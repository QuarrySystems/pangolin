// packages/agora-orchestrator/src/serve/driver.ts
import type { AgoraOrchestrator } from '../orchestrator.js';
import type { SubmissionTransport } from '../contracts/index.js';

export interface ServeOptions {
  orchestrator: AgoraOrchestrator;
  transport: SubmissionTransport;
  queue?: string;
  tickIntervalMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  onError?: (err: unknown) => void;
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
    } catch (err) {
      opts.onError?.(err);
    }

    await sleep(interval, opts.signal);
  }
}
