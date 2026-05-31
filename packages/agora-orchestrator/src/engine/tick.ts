// packages/agora-orchestrator/src/engine/tick.ts
import type { Executor, RunStateStore } from '../contracts/index.js';
import { effectTierPolicy } from '../contracts/effect-policy.js';
import type { PackRegistry } from '../packs/registry.js';
import { computeNewlyReady, computeSkipped } from './dep-resolver.js';
import { selectRunnable } from './lock-manager.js';

/** Advance one queue by a single tick. Returns counts for observability/tests. */
export async function tick(
  store: RunStateStore,
  executors: Record<string, Executor>,
  queue: string,
  packs?: PackRegistry,
  opts: { maxAttempts?: number; now?: number; backoffMs?: (n: number) => number } = {},
): Promise<{ readied: number; fired: number; reconciled: number }> {
  const maxAttempts = opts.maxAttempts ?? 1; // tick is no-retry by default; the orchestrator opts into retry
  const now = opts.now ?? Date.now();
  const backoff = opts.backoffMs ?? ((n) => 1000 * 2 ** n);

  const queueItems = () => store.getItems().filter((i) => i.queue === queue);

  // 1. Ready newly-satisfied items (scoped to this queue).
  const newlyReady = computeNewlyReady(queueItems());
  store.markReady(newlyReady);

  // 2. Reconcile in-flight items in this queue; release locks on terminal status.
  //    A failed item with retries remaining is requeued with exponential backoff;
  //    otherwise it goes terminal (the cascade in step 4 then skips its dependents).
  let reconciled = 0;
  for (const it of store.getItems().filter((i) => i.queue === queue && i.status === 'running')) {
    const ex = executors[it.executor];
    if (!ex) {
      store.setStatus(it.id, 'failed', `no executor registered for '${it.executor}'`);
      store.releaseLocks(it.id);
      continue;
    }
    const res = await ex.reconcile(it.dispatchHash!);
    if (res) {
      if (res.status === 'failed' && store.getAttempts(it.id) + 1 < maxAttempts) {
        store.bumpAttempt(it.id);
        store.releaseLocks(it.id);
        store.requeue(it.id, now + backoff(store.getAttempts(it.id)));
      } else {
        store.setStatus(it.id, res.status, res.status === 'failed' ? 'executor reported failed' : undefined);
        if (res.status === 'done' && res.resultRef) store.setResultRef(it.id, res.resultRef);
        store.releaseLocks(it.id);
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
  //    Skip items whose nextAttemptAt (backoff gate) is still in the future.
  const slots = store.queueConcurrency(queue) - store.runningCount(queue);
  const ready = store.getItems().filter(
    (i) => i.queue === queue && i.status === 'ready' && (i.nextAttemptAt ?? 0) <= now,
  );
  const runnable = selectRunnable(ready, store.heldLockKeys(), Math.max(0, slots));
  let fired = 0;
  for (const it of runnable) {
    // Shape resolution + input validation (before acquiring locks to avoid lock leaks).
    if (it.subagentShape) {
      const shape = packs?.get(it.subagentShape);
      if (!shape) {
        store.setStatus(it.id, 'failed', `unknown subagentShape '${it.subagentShape}'`);
        store.releaseLocks(it.id);
        continue;
      }
      const parsed = shape.inputSchema.safeParse(it.inputs);
      if (!parsed.success) {
        store.setStatus(it.id, 'failed', `inputs failed ${shape.id} schema`);
        store.releaseLocks(it.id);
        continue;
      }
      void effectTierPolicy(shape.effectTier); // TODO(PR6): enforce EffectPolicy (snapshot/gate) — currently read + discarded
    }
    if (!store.acquireLocks(it.id, it.resourceLocks)) continue;
    const ex = executors[it.executor];
    if (!ex) {
      store.setStatus(it.id, 'failed', `no executor registered for '${it.executor}'`);
      store.releaseLocks(it.id);
      continue;
    }
    try {
      const { dispatchHash, manifestRef } = await ex.fire(it, {
        runId: it.runId, actor: it.actor, submittedAt: it.submittedAt,
      });
      store.setRunning(it.id, dispatchHash);
      if (manifestRef) store.setManifestRef(it.id, manifestRef);
      fired++;
    } catch (err) {
      store.releaseLocks(it.id);
      store.setStatus(it.id, 'failed', `fire failed: ${(err as Error).message}`);
    }
  }

  // 4. Cascade: mark pending dependents of failed/skipped items as skipped.
  for (const id of computeSkipped(queueItems())) {
    store.setStatus(id, 'skipped', 'dependency failed or skipped');
  }

  return { readied: newlyReady.length + moreReady.length, fired, reconciled };
}
