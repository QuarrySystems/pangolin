import type { ItemState } from '../contracts/index.js';

/** §7 (run-3 spec): a red GATE blocks its dependents. Failed-like = done +
 *  verify.passed === false + the item declares inputs.gate.onRed === 'spawn-fix'.
 *  Red verify on any non-gate item remains report-only (never blocks). */
function isBlockingRedGate(item: ItemState): boolean {
  if (item.status !== 'done' || item.verify?.passed !== false) return false;
  const gate = (item.inputs as { gate?: { onRed?: string } } | undefined)?.gate;
  return gate?.onRed === 'spawn-fix';
}

/** ids of currently-`pending` items whose every dependency is `done`
 *  AND is not a blocking red gate. */
export function computeNewlyReady(items: ItemState[]): string[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  return items
    .filter((i) =>
      i.status === 'pending' &&
      i.depends_on.every((d) => {
        const dep = byId.get(d);
        return dep?.status === 'done' && !isBlockingRedGate(dep);
      }),
    )
    .map((i) => i.id);
}

/** ids of `pending` items with at least one dependency already `failed`, `skipped`, `cancelled`,
 *  OR a blocking red gate (done + verify.passed===false + inputs.gate.onRed==='spawn-fix').
 *  Single-pass; the tick re-invokes across ticks so transitive chains fully settle. */
export function computeSkipped(items: ItemState[]): string[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  return items
    .filter((i) =>
      i.status === 'pending' &&
      i.depends_on.some((d) => {
        const dep = byId.get(d);
        if (!dep) return false;
        const s = dep.status;
        return s === 'failed' || s === 'skipped' || s === 'cancelled' || isBlockingRedGate(dep);
      }),
    )
    .map((i) => i.id);
}

/** A run/queue is settled when nothing can still move (no pending/ready/running). */
export function isSettled(items: ItemState[]): boolean {
  return !items.some((i) => i.status === 'pending' || i.status === 'ready' || i.status === 'running');
}
