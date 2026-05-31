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
}

/** Resolves after `ms` milliseconds, or immediately if the signal is already aborted or fires. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function serve(opts: ServeOptions): Promise<void> {
  const queue = opts.queue ?? 'default';
  const interval = opts.tickIntervalMs ?? 2000;

  // Reconcile-first: one tick before the main loop
  await opts.orchestrator.tick(queue);

  while (!opts.signal?.aborted) {
    for (const env of await opts.transport.pollInbox()) {
      opts.orchestrator.submitRun(env.run, env.actor);
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

    await sleep(interval, opts.signal);
  }
}
