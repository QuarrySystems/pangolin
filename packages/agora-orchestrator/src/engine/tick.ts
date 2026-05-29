// packages/agora-orchestrator/src/engine/tick.ts
import type { Executor, RunStateStore } from '../contracts/index.js';
import { computeNewlyReady } from './dep-resolver.js';
import { selectRunnable } from './lock-manager.js';

/** Advance one queue by a single tick. Returns counts for observability/tests. */
export async function tick(
  store: RunStateStore,
  executors: Record<string, Executor>,
  queue: string,
): Promise<{ readied: number; fired: number; reconciled: number }> {
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
      store.setStatus(it.id, res.status);
      store.releaseLocks(it.id);
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
  const slots = store.queueConcurrency(queue) - store.runningCount(queue);
  const ready = store.getItems().filter((i) => i.queue === queue && i.status === 'ready');
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
