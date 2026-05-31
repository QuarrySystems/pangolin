// packages/agora-orchestrator/src/engine/tick.ts
import type { Executor, RunStateStore } from '../contracts/index.js';
import { computeNewlyReady, transitiveDependents } from './dep-resolver.js';
import { selectRunnable } from './lock-manager.js';

/** Advance one queue by a single tick. Returns counts for observability/tests. */
export async function tick(
  store: RunStateStore,
  executors: Record<string, Executor>,
  queue: string,
  opts: { maxAttempts?: number; now?: number; backoffMs?: (n: number) => number } = {},
): Promise<{ readied: number; fired: number; reconciled: number }> {
  const maxAttempts = opts.maxAttempts ?? 2;
  const now = opts.now ?? Date.now();
  const backoff = opts.backoffMs ?? ((n) => 1000 * 2 ** n);

  const queueItems = () => store.getItems().filter((i) => i.queue === queue);

  // 1. Ready newly-satisfied items (scoped to this queue).
  const newlyReady = computeNewlyReady(queueItems());
  store.markReady(newlyReady);

  // 2. Reconcile in-flight items in this queue; release locks on terminal status.
  let reconciled = 0;
  for (const it of store.getItems().filter((i) => i.queue === queue && i.status === 'running')) {
    const ex = executors[it.executor];
    if (!ex) throw new Error(`tick: no executor registered for '${it.executor}'`);
    const res = await ex.reconcile(it.dispatchHash!);
    if (res) {
      if (res.status === 'failed' && store.getAttempts(it.id) + 1 < maxAttempts) {
        // Retry: bump attempt counter, release locks, requeue with exponential backoff.
        store.bumpAttempt(it.id);
        store.releaseLocks(it.id);
        store.requeue(it.id, now + backoff(store.getAttempts(it.id)));
      } else {
        store.setStatus(it.id, res.status);
        store.releaseLocks(it.id);
        // Terminal failure: cascade skips to all transitive dependents that are still pending/ready.
        if (res.status === 'failed') {
          const NON_TERMINAL = new Set(['pending', 'ready']);
          for (const depId of transitiveDependents(store.getItems(), [it.id])) {
            const dep = store.getItems().find((i) => i.id === depId);
            if (dep && NON_TERMINAL.has(dep.status)) {
              store.setStatus(depId, 'skipped');
            }
          }
        }
      }
      reconciled++;
    }
  }

  // Re-evaluate newly-ready items now that reconciled items may have unblocked dependents.
  let moreReady: string[] = [];
  if (reconciled > 0) {
    moreReady = computeNewlyReady(queueItems());
    store.markReady(moreReady);
  }

  // 3. Fire ready items within remaining concurrency + lock budget.
  // Skip items whose nextAttemptAt is still in the future.
  const slots = store.queueConcurrency(queue) - store.runningCount(queue);
  const ready = store.getItems().filter(
    (i) => i.queue === queue && i.status === 'ready' && (i.nextAttemptAt ?? 0) <= now,
  );
  const runnable = selectRunnable(ready, store.heldLockKeys(), Math.max(0, slots));
  let fired = 0;
  for (const it of runnable) {
    if (!store.acquireLocks(it.id, it.resourceLocks)) continue;
    const ex = executors[it.executor];
    if (!ex) throw new Error(`tick: no executor registered for '${it.executor}'`);
    const { dispatchHash } = await ex.fire(it);
    store.setRunning(it.id, dispatchHash);
    fired++;
  }
  return { readied: newlyReady.length + moreReady.length, fired, reconciled };
}
