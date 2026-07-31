// packages/pangolin-orchestrator/src/serve/driver.ts
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

/** Default surfacing when no `onError` is wired: the serve loop's errors (poison submissions,
 *  control/publish/scheduler failures) must not vanish silently. Operators override via `onError`. */
function defaultServeOnError(err: unknown): void {
  console.error(`[pangolin serve] loop error: ${err instanceof Error ? err.message : String(err)}`);
}

export async function serve(opts: ServeOptions): Promise<void> {
  // Which queues this process drives. `tick()` filters items by queue, so a configured
  // queue nobody ticks is one whose items are never considered ready, fired or
  // reconciled — they sit `ready` with `blockedBy: []` forever, with no error in the
  // serve log, in `orch status`, or in the audit chain. `orch cancel` cannot rescue
  // them either, because cancellation is processed by this same loop.
  //
  // Naming a queue explicitly still drives exactly that one, so one-process-per-queue
  // deployments keep working. Omitting it now drives EVERY configured queue rather
  // than just 'default': the orchestrator already holds and validates the whole map,
  // so a config declaring queues the loop silently ignored was half-inert by default.
  const queues = opts.queue !== undefined ? [opts.queue] : opts.orchestrator.getConfiguredQueues();
  const tickAll = async () => {
    for (const q of queues) await opts.orchestrator.tick(q);
  };

  // A single-queue process is legitimate, so this is a notice rather than a refusal —
  // but the operator has to learn it at boot. The failure it prevents produces no
  // signal to correlate with a doc, which is what made it expensive to diagnose.
  const undriven = opts.orchestrator.getConfiguredQueues().filter((q) => !queues.includes(q));
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

    // Reconcile-first: one tick before the main loop
    await tickAll();
    health.started = true;
    health.lastTickAt = now();
    health.lastTickOkAt = now();

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

    while (!opts.signal?.aborted) {
      try {
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
          await opts.transport.publish({ runId, kind: 'status', body: items, at });
          // Marked only AFTER the publish resolves, matching publishedAudit below. Marking
          // first would let a transient publish failure retire the run permanently — the
          // final status would never land and no later tick would retry it.
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
