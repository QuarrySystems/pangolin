// packages/pangolin-orchestrator/src/engine/tick.ts
import type { Executor, RunStateStore } from '../contracts/index.js';
import { effectTierPolicy } from '../contracts/effect-policy.js';
import type { PackRegistry } from '../packs/registry.js';
import { computeNewlyReady, computeSkipped } from './dep-resolver.js';
import { selectRunnable } from './lock-manager.js';
import type { AuditLog } from '../audit/audit-log.js';
import { resolveInputRefs } from './needs-resolver.js';

/** Advance one queue by a single tick. Returns counts for observability/tests. */
export async function tick(
  store: RunStateStore,
  executors: Record<string, Executor>,
  queue: string,
  packs?: PackRegistry,
  opts: { maxAttempts?: number; now?: number; backoffMs?: (n: number) => number; auditLog?: AuditLog; denamespace?: (id: string) => string } = {},
): Promise<{ readied: number; fired: number; reconciled: number }> {
  const maxAttempts = opts.maxAttempts ?? 1; // tick is no-retry by default; the orchestrator opts into retry
  const now = opts.now ?? Date.now();
  const backoff = opts.backoffMs ?? ((n) => 1000 * 2 ** n);
  const deNs = opts.denamespace ?? ((x) => x);

  /** Audit is best-effort observability — a failing append must NEVER abort a tick or corrupt run state. */
  const auditAt = new Date(now).toISOString();
  const audit = (e: Parameters<NonNullable<typeof opts.auditLog>['append']>[0]) => {
    try { opts.auditLog?.append(e); } catch { /* best-effort; dropping an append is safe */ }
  };

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
        audit({ kind: 'item.retried', runId: it.runId, itemId: deNs(it.id), at: auditAt });
      } else {
        store.setStatus(it.id, res.status, res.status === 'failed' ? 'executor reported failed' : undefined);
        if (res.status === 'done' && res.resultRef) store.setResultRef(it.id, res.resultRef);
        if (res.status === 'done' && res.verify) store.setVerify(it.id, res.verify);
        if (res.status === 'done' && res.outputRefs) store.setOutputRefs(it.id, res.outputRefs);
        store.releaseLocks(it.id);
        if (res.status === 'done') {
          audit({ kind: 'item.reconciled', runId: it.runId, itemId: deNs(it.id), status: 'done', ...(res.resultRef ? { resultRef: res.resultRef } : {}), at: auditAt });
        } else {
          audit({ kind: 'item.reconciled', runId: it.runId, itemId: deNs(it.id), status: 'failed', at: auditAt });
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
  //    Skip items whose nextAttemptAt (backoff gate) is still in the future.
  const slots = store.queueConcurrency(queue) - store.runningCount(queue);
  const ready = store.getItems().filter(
    (i) => i.queue === queue && i.status === 'ready' && (i.nextAttemptAt ?? 0) <= now,
  );
  const runnable = selectRunnable(ready, store.heldLockKeys(), Math.max(0, slots));
  // Build a snapshot of all items for needs resolution (hoist ONCE outside the loop).
  const byId = new Map(store.getItems().map((i) => [i.id, i]));
  let fired = 0;
  for (const it of runnable) {
    // Needs resolution: resolve typed-product bindings before input validation (spec §4).
    let fireItem = it;
    if (it.needs && Object.keys(it.needs).length > 0) {
      const r = resolveInputRefs(it, byId);
      if ('error' in r) {
        store.setStatus(it.id, 'failed', r.error);
        store.releaseLocks(it.id);
        continue;
      }
      fireItem = { ...it, inputs: { ...it.inputs, inputRefs: r.inputRefs } };
    }
    // Shape resolution + input validation (before acquiring locks to avoid lock leaks).
    if (it.subagentShape) {
      const shape = packs?.get(it.subagentShape);
      if (!shape) {
        store.setStatus(it.id, 'failed', `unknown subagentShape '${it.subagentShape}'`);
        store.releaseLocks(it.id);
        continue;
      }
      const parsed = shape.inputSchema.safeParse(fireItem.inputs);
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
      const { dispatchHash, manifestRef } = await ex.fire(fireItem, {
        runId: it.runId, actor: it.actor, submittedAt: it.submittedAt,
      });
      store.setRunning(it.id, dispatchHash);
      if (manifestRef) store.setManifestRef(it.id, manifestRef);
      audit({ kind: 'item.fired', runId: it.runId, itemId: deNs(it.id), ...(manifestRef ? { manifestRef } : {}), at: auditAt });
      fired++;
    } catch (err) {
      store.releaseLocks(it.id);
      store.setStatus(it.id, 'failed', `fire failed: ${(err as Error).message}`);
    }
  }

  // 4. Cascade: mark pending dependents of failed/skipped items as skipped.
  const currentItems = queueItems();
  const itemRunId = new Map(currentItems.map((i) => [i.id, i.runId]));
  for (const id of computeSkipped(currentItems)) {
    store.setStatus(id, 'skipped', 'dependency failed or skipped');
    audit({ kind: 'item.skipped', runId: itemRunId.get(id) ?? '', itemId: deNs(id), at: auditAt });
  }

  return { readied: newlyReady.length + moreReady.length, fired, reconciled };
}
