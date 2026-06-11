// packages/pangolin-orchestrator/src/serve/driver.ts
import type { PangolinOrchestrator } from '../orchestrator.js';
import type { SubmissionTransport, ControlChannel } from '../contracts/index.js';
import type { CronScheduler } from '../scheduling/cron-scheduler.js';

export interface ServeOptions {
  orchestrator: PangolinOrchestrator;
  transport: SubmissionTransport & Partial<ControlChannel>;
  queue?: string;
  tickIntervalMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  onError?: (err: unknown) => void;
  /** When provided, due schedules are drained into the transport each tick (before orchestrator.tick). */
  scheduler?: CronScheduler;
}

/** Resolves after `ms` milliseconds, or immediately if the signal is already aborted or fires. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function serve(opts: ServeOptions): Promise<void> {
  const queue = opts.queue ?? 'default';
  const interval = opts.tickIntervalMs ?? 2000;

  // Crash recovery: re-ready items left `running` by a crashed process
  opts.orchestrator.recoverStranded(opts.now?.() ?? Date.now());

  // Reconcile-first: one tick before the main loop
  await opts.orchestrator.tick(queue);

  // Tracks runs whose audit export has already been published — persists across
  // iterations so each run's audit export is emitted exactly once (idempotent).
  const publishedAudit = new Set<string>();

  while (!opts.signal?.aborted) {
    try {
      for (const env of await opts.transport.pollInbox()) {
        try {
          opts.orchestrator.submitRun(env.run, env.actor, env.submittedAt);
          await opts.transport.ack(env.run.id);      // consume it
        } catch (err) {
          opts.onError?.(err);
          await opts.transport.deadLetter(env.run.id);   // poison -> dead-letter, NOT infinite re-poll
        }
      }
      for (const ctl of (await opts.transport.pollControl?.()) ?? []) {
        try {
          if (ctl.kind === 'cancel') opts.orchestrator.cancelRun(ctl.target, ctl.actor);
          await opts.transport.ackControl?.(ctl.target);
        } catch (err) { opts.onError?.(err); }
      }
      if (opts.scheduler) {
        try {
          for (const env of opts.scheduler.dueSubmissions()) {
            try { await opts.transport.submit(env); }
            catch (err) { opts.onError?.(err); }
          }
        } catch (err) { opts.onError?.(err); }
      }
      await opts.orchestrator.tick(queue);

      const at = new Date(opts.now?.() ?? Date.now()).toISOString();

      // Group status items by runId — one OutboxRecord per run
      const byRun = new Map<string, unknown[]>();
      for (const s of opts.orchestrator.getStatus()) {
        let arr = byRun.get(s.runId);
        if (!arr) {
          arr = [];
          byRun.set(s.runId, arr);
        }
        arr.push(s);
      }

      for (const [runId, items] of byRun) {
        await opts.transport.publish({ runId, kind: 'status', body: items, at });
      }

      // Publish sealed audit exports — once per run, after the epoch seals (root defined).
      for (const runId of byRun.keys()) {
        if (publishedAudit.has(runId)) continue;
        const exp = opts.orchestrator.getAuditExport(runId);
        if (exp.root === undefined) continue;        // not sealed yet
        await opts.transport.publish({ runId, kind: 'audit', body: exp, at });
        publishedAudit.add(runId);
      }
    } catch (err) {
      opts.onError?.(err);
    }

    await sleep(interval, opts.signal);
  }
}
