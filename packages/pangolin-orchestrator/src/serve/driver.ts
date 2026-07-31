// packages/pangolin-orchestrator/src/serve/driver.ts
import { createHash } from 'node:crypto';
import type { PangolinOrchestrator, StatusItem } from '../orchestrator.js';
import type { SubmissionTransport, ControlChannel, AppendChannel } from '../contracts/index.js';
import { TERMINAL_STATUSES } from '../contracts/index.js';
import type { CronScheduler } from '../scheduling/cron-scheduler.js';
import { startHealthServer, type ServeHealth, type HealthServerHandle } from './http.js';
import type { MetricsSnapshot } from '@quarry-systems/pangolin-core';

export interface ServeOptions {
  orchestrator: PangolinOrchestrator;
  transport: SubmissionTransport & Partial<ControlChannel> & Partial<AppendChannel>;
  queue?: string;
  tickIntervalMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  onError?: (err: unknown) => void;
  /** When provided, due schedules are drained into the transport each tick (before orchestrator.tick). */
  scheduler?: CronScheduler;
  /** Opt-in HTTP observability endpoint. When unset, no server is started and no port opens. */
  http?: {
    port: number;
    host?: string;
    /** Liveness staleness window; default max(tickIntervalMs * 4, 60_000). */
    livenessTimeoutMs?: number;
    /** Readiness staleness window; default max(tickIntervalMs * 4, 60_000). */
    readinessTimeoutMs?: number;
    /** Provider for /metrics; when omitted /metrics returns 404. */
    metricsSnapshot?: () => MetricsSnapshot;
  };
}

/** Resolves after `ms` milliseconds, or immediately if the signal is already aborted or fires. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Digest of a run's status body, used to decide whether anything actually changed since
 *  the last publish.
 *
 *  Covers the whole StatusItem, not just `status`: `blockedBy`, `resultRef`, `manifestRef`
 *  and `verify` are all things a client watches for, and a run can change in those while
 *  every status string stays put. The record's `at` timestamp is deliberately excluded —
 *  it moves every tick, so including it would defeat the comparison entirely. */
function fingerprintStatus(items: StatusItem[]): string {
  return createHash('sha256').update(JSON.stringify(items)).digest('hex');
}

/** Default surfacing when no `onError` is wired: the serve loop's errors (poison submissions,
 *  control/publish/scheduler failures) must not vanish silently. Operators override via `onError`. */
function defaultServeOnError(err: unknown): void {
  console.error(`[pangolin serve] loop error: ${err instanceof Error ? err.message : String(err)}`);
}

export async function serve(opts: ServeOptions): Promise<void> {
  // Which queues this process drives. `tick()` filters items by queue, so a configured
  // queue nobody ticks is one whose items are never considered ready, fired or
  // reconciled — they sit `ready` with `blockedBy: []` forever, with no error in the
  // serve log, in `orch status`, or in the audit chain. (`orch cancel` DOES still reach
  // them: cancelRun walks a run's items directly and is not queue-scoped. An earlier
  // version of this comment said otherwise.)
  //
  // Naming a queue explicitly still drives exactly that one, so one-process-per-queue
  // deployments keep working. Omitting it now drives EVERY configured queue rather
  // than just 'default': the orchestrator already holds and validates the whole map,
  // so a config declaring queues the loop silently ignored was half-inert by default.
  const configured = opts.orchestrator.getConfiguredQueues();
  const queues = opts.queue !== undefined ? [opts.queue] : configured;

  /** Drain everything arriving from the transport — submissions, then extends, then
   *  control — and apply it to the orchestrator.
   *
   *  THE ORDER IS LOAD-BEARING and this runs as one unit for that reason. Control must be
   *  applied against fully-ingested state: `cancelRun` on a run the store has never seen
   *  iterates an empty item list and returns without throwing, so draining control ahead
   *  of the inbox would ack and destroy a cancel that arrived in the same batch as the
   *  run it targets. Extends sit between them because an extend names a run that must
   *  already exist, and a close arriving with it must observe the extended item set.
   *
   *  Shared by the reconcile-first pass and the loop so the two cannot drift. */
  const drainIngress = async () => {
    for (const env of await opts.transport.pollInbox()) {
      try {
        await opts.orchestrator.submitRun(env.run, env.actor, env.submittedAt);
        await opts.transport.ack(env.run.id); // consume it
      } catch (err) {
        onError(err);
        await opts.transport.deadLetter(env.run.id); // poison -> dead-letter, NOT infinite re-poll
      }
    }
    for (const env of (await opts.transport.pollExtends?.()) ?? []) {
      try {
        opts.orchestrator.producerExtend(env.runId, env.items, env.actor, env.causeItemId);
      } catch (err) {
        onError(err); // invalid/poison extend — surfaced. Do NOT deadLetter(runId): that targets the SUBMISSION, not this extend.
      }
      // ALWAYS remove the extend envelope by seq (success OR failure) so a poison extend never re-delivers.
      if (env.seq) await opts.transport.ackExtend?.(env.runId, env.seq);
    }
    for (const ctl of (await opts.transport.pollControl?.()) ?? []) {
      try {
        if (ctl.kind === 'cancel') opts.orchestrator.cancelRun(ctl.target, ctl.actor);
        else if (ctl.kind === 'close') opts.orchestrator.closeRun(ctl.target, ctl.actor);
        await opts.transport.ackControl?.(ctl.target);
      } catch (err) {
        onError(err);
      }
    }
  };

  /** Tick every queue this process drives, one pass.
   *
   *  Every configured queue is ATTEMPTED each pass, whatever its siblings did. Awaiting
   *  them in a bare loop would let a throw from an early queue abort the pass before the
   *  later ones are ticked — and since each pass restarts at the same failing queue, one
   *  deterministic fault would starve every queue behind it forever. That is precisely the
   *  silently-never-driven failure this whole change exists to remove, so it must not be
   *  reintroduced through the back door.
   *
   *  Failures are collected, not swallowed: the pass still ends up throwing, because
   *  /readyz staleness is derived from iterations reaching their end cleanly and a broken
   *  tick must not read as a healthy iteration. A lone failure rethrows AS-IS so
   *  single-queue deployments see byte-identical error surfacing; several become an
   *  AggregateError naming each one, since reporting only the first would hide the rest.
   *
   *  Sequential on purpose — not a missed parallelisation. The orchestrator is a
   *  single-writer design (one SQLite writer, one shared lock manager), so concurrent
   *  ticks would race. Each tick(q) is a queue-filtered query, so the cost is small and
   *  proportional to the number of configured queues. */
  const tickAll = async () => {
    const failures: unknown[] = [];
    for (const q of queues) {
      try {
        await opts.orchestrator.tick(q);
      } catch (err) {
        failures.push(err);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, `serve tick failed for ${failures.length} queues`);
    }
  };

  // A single-queue process is legitimate, so this is a notice rather than a refusal —
  // but the operator has to learn it at boot. The failure it prevents produces no
  // signal to correlate with a doc, which is what made it expensive to diagnose.
  const undriven = configured.filter((q) => !queues.includes(q));
  if (undriven.length > 0) {
    console.warn(
      `[pangolin serve] driving queue(s) ${queues.join(', ')}; configured but NOT driven by this ` +
        `process: ${undriven.join(', ')}. Items submitted to those queues will sit at 'ready' ` +
        `indefinitely unless another serve process ticks them.`,
    );
  }

  const interval = opts.tickIntervalMs ?? 2000;
  const onError = opts.onError ?? defaultServeOnError;
  const now = () => opts.now?.() ?? Date.now();

  // Liveness/readiness heartbeat, shared by reference with the HTTP server (if enabled).
  const health: ServeHealth = { started: false, lastTickAt: 0, lastTickOkAt: 0 };

  let healthServer: HealthServerHandle | undefined;
  if (opts.http) {
    const window = Math.max(interval * 4, 60_000);
    healthServer = await startHealthServer({
      port: opts.http.port,
      host: opts.http.host,
      health,
      livenessTimeoutMs: opts.http.livenessTimeoutMs ?? window,
      readinessTimeoutMs: opts.http.readinessTimeoutMs ?? window,
      now,
      metricsSnapshot: opts.http.metricsSnapshot,
    });
  }

  try {
    // Crash recovery: re-ready items left `running` by a crashed process
    opts.orchestrator.recoverStranded(now());

    // Reconcile-first: one tick before the main loop.
    //
    // A failure here is reported and the loop still starts, rather than rejecting out of
    // serve(). With one queue those were equivalent; with several they are not — letting
    // it throw means a single broken queue stops every healthy queue from ever being
    // driven, and since the fault is usually deterministic the process just crash-loops
    // under `restart: unless-stopped` and serves nothing. There is also no principled
    // reason for the same failure to be fatal at boot but recoverable one iteration
    // later, which is how the loop below already treats it.
    //
    // The failure is NOT hidden: lastTickOkAt stays unset, so /readyz reports 503
    // (`not-ready`) until a tick succeeds, while /healthz stays up because liveness
    // drives restarts and a dependency outage must not cause a restart storm — the
    // split evaluateHealth() already documents.
    // Ingress BEFORE that first tick. The loop below already drains ahead of its tick, but
    // the reconcile-first pass did not, so a cancel queued while this process was DOWN lost
    // the race to the very item it was meant to stop — defeated by the restart that was
    // supposed to apply it. (While serve is UP, cancel was never at risk: control is drained
    // in the loop body and cancelRun is not queue-scoped.) Draining the whole of ingress,
    // not just control, is what keeps a cancel arriving alongside its own submission working.
    try {
      await drainIngress();
    } catch (err) {
      onError(err);
    }

    try {
      await tickAll();
      health.lastTickOkAt = now();
    } catch (err) {
      onError(err);
    }
    health.started = true;
    health.lastTickAt = now();

    // Tracks runs whose audit export has already been published — persists across
    // iterations so each run's audit export is emitted exactly once (idempotent).
    const publishedAudit = new Set<string>();

    // Tracks runs whose FINAL (all-items-terminal) status has been published, so the
    // loop announces completion once and then goes quiet about that run.
    //
    // Without this the loop republished every run it could see on every tick, forever:
    // getStatus() below takes no runId, and the store reads that as "everything", so a
    // run kept accruing one outbox record per tick for the rest of the stack's life.
    // A 67-second run was measured holding 23,307 records, and since every client read
    // walks the run's prefix, read cost grew with uptime rather than with the run.
    //
    // In-memory, like publishedAudit: a serve restart re-announces each terminal run
    // once. That is bounded by restarts rather than by uptime, and it is the safer
    // direction — a client that missed the announcement gets another one.
    const publishedTerminal = new Set<string>();

    // Last published status body per run, as a digest. Deliberately NOT the body itself:
    // an entry is then a fixed 64 bytes whatever the run's size, so a long-lived process
    // that has seen many runs holds a map proportional to run COUNT and nothing else.
    // In-memory like the two sets above — a restart re-publishes each run's current status
    // once, which is bounded by restarts and is the safe direction.
    const lastStatusFingerprint = new Map<string, string>();

    while (!opts.signal?.aborted) {
      try {
        await drainIngress();
        if (opts.scheduler) {
          try {
            for (const env of opts.scheduler.dueSubmissions()) {
              try {
                await opts.transport.submit(env);
              } catch (err) {
                onError(err);
              }
            }
          } catch (err) {
            onError(err);
          }
        }
        await tickAll();

        const at = new Date(now()).toISOString();

        // Group status items by runId — one OutboxRecord per run
        const byRun = new Map<string, StatusItem[]>();
        for (const s of opts.orchestrator.getStatus()) {
          let arr = byRun.get(s.runId);
          if (!arr) {
            arr = [];
            byRun.set(s.runId, arr);
          }
          arr.push(s);
        }

        for (const [runId, items] of byRun) {
          // A run whose items have all stopped moving has nothing left to report. Publish
          // that final state once so clients can observe completion, then stay quiet —
          // republishing it every tick is what made the outbox grow without bound.
          const terminal = items.every((i) => TERMINAL_STATUSES.has(i.status));
          if (terminal && publishedTerminal.has(runId)) continue;

          // …and more generally, publish only what has CHANGED. The terminal guard above
          // bounds runs that FINISH; this bounds the ones that do not. A run with a single
          // permanently-stuck item never satisfies `terminal`, so it used to re-emit
          // identical bytes every tick forever — the stranded-queue case of issue 7, and
          // any run whose executor stops reconciling. Those are exactly the runs left
          // sitting for days, so they were the worst possible ones to exclude.
          //
          // The terminal guard is kept rather than folded into this one: it short-circuits
          // on item statuses alone, so a settled run never pays for fingerprinting its
          // whole body on every tick.
          const fingerprint = fingerprintStatus(items);
          if (lastStatusFingerprint.get(runId) === fingerprint) continue;

          await opts.transport.publish({ runId, kind: 'status', body: items, at });
          // Marked only AFTER the publish resolves, matching publishedAudit below. Marking
          // first would let a transient publish failure retire the run permanently — the
          // final status would never land and no later tick would retry it. The same
          // reasoning applies to the fingerprint: record it only once the bytes are out,
          // or a failed publish would be remembered as delivered.
          lastStatusFingerprint.set(runId, fingerprint);
          if (terminal) publishedTerminal.add(runId);
        }

        // Publish sealed audit exports — once per run, after the epoch seals (root defined).
        for (const runId of byRun.keys()) {
          if (publishedAudit.has(runId)) continue;
          const exp = opts.orchestrator.getAuditExport(runId);
          if (exp.root === undefined) continue; // not sealed yet
          await opts.transport.publish({ runId, kind: 'audit', body: exp, at });
          publishedAudit.add(runId);
        }

        // Reached the end of the iteration with no outer-catch error → deps are reachable.
        health.lastTickOkAt = now();
      } catch (err) {
        onError(err);
      }

      // Every completed iteration (success OR caught error) advances the liveness heartbeat.
      health.lastTickAt = now();

      await sleep(interval, opts.signal);
    }
  } finally {
    if (healthServer) await healthServer.close();
  }
}
