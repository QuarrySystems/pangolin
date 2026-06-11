import type { ItemState } from '../contracts/index.js';

/** §7 (run-3 spec): a red GATE blocks its dependents. Failed-like = done +
 *  verify.passed === false + the item declares inputs.gate.onRed === 'spawn-fix'.
 *  Red verify on any non-gate item remains report-only (never blocks). */
function isBlockingRedGate(item: ItemState): boolean {
  if (item.status !== 'done' || item.verify?.passed !== false) return false;
  const gate = (item.inputs as { gate?: { onRed?: string } } | undefined)?.gate;
  return gate?.onRed === 'spawn-fix';
}

/** §7 "Data-edge exemption": a red gate blocks CONTROL-FLOW dependents but NOT data consumers
 *  of its own outputs. Consumer `c` is exempt from dep `g`'s blocking-red status when `c.needs`
 *  has some binding with from === g.id AND select.kind === 'output'. (The gate's findings are
 *  exactly what red MEANS; red does not invalidate them.)
 *
 *  Returns true when `dep` is a blocking red gate AND `consumer` is NOT exempt from it. */
function isBlockedBy(consumer: ItemState, dep: ItemState): boolean {
  if (!isBlockingRedGate(dep)) return false;
  const needs = consumer.needs ?? {};
  const consumesOutput = Object.values(needs).some(
    (b) => b.from === dep.id && b.select.kind === 'output',
  );
  return !consumesOutput;
}

/** ids of currently-`pending` items whose every dependency is `done`
 *  AND is not a blocking red gate (respecting the data-edge exemption). */
export function computeNewlyReady(items: ItemState[]): string[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  return items
    .filter((i) =>
      i.status === 'pending' &&
      i.depends_on.every((d) => {
        const dep = byId.get(d);
        return dep?.status === 'done' && !isBlockedBy(i, dep);
      }),
    )
    .map((i) => i.id);
}

/** ids of `pending` items with at least one dependency already `failed`, `skipped`, `cancelled`,
 *  OR a blocking red gate (done + verify.passed===false + inputs.gate.onRed==='spawn-fix',
 *  data-edge exemption applied per-edge).
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
        return s === 'failed' || s === 'skipped' || s === 'cancelled' || isBlockedBy(i, dep);
      }),
    )
    .map((i) => i.id);
}

/** A run/queue is settled when nothing can still move (no pending/ready/running). */
export function isSettled(items: ItemState[]): boolean {
  return !items.some((i) => i.status === 'pending' || i.status === 'ready' || i.status === 'running');
}
