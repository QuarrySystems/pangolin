import type { ItemState } from '../contracts/index.js';

/** ids of currently-`pending` items whose every dependency is `done`. */
export function computeNewlyReady(items: ItemState[]): string[] {
  const status = new Map(items.map((i) => [i.id, i.status]));
  return items
    .filter((i) => i.status === 'pending' && i.depends_on.every((d) => status.get(d) === 'done'))
    .map((i) => i.id);
}

/** ids of `pending` items with at least one dependency already `failed`, `skipped`, or `cancelled`
 *  (they can never ready, so they cascade to `skipped`). Single-pass; the tick re-invokes
 *  across ticks so transitive chains fully settle. */
export function computeSkipped(items: ItemState[]): string[] {
  const status = new Map(items.map((i) => [i.id, i.status]));
  return items
    .filter((i) => i.status === 'pending' && i.depends_on.some((d) => {
      const s = status.get(d);
      return s === 'failed' || s === 'skipped' || s === 'cancelled';
    }))
    .map((i) => i.id);
}

/** A run/queue is settled when nothing can still move (no pending/ready/running). */
export function isSettled(items: ItemState[]): boolean {
  return !items.some((i) => i.status === 'pending' || i.status === 'ready' || i.status === 'running');
}
