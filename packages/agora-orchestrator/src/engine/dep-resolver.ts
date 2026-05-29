import type { ItemState } from '../contracts/index.js';

/** ids of currently-`pending` items whose every dependency is `done`. */
export function computeNewlyReady(items: ItemState[]): string[] {
  const status = new Map(items.map((i) => [i.id, i.status]));
  return items
    .filter((i) => i.status === 'pending' && i.depends_on.every((d) => status.get(d) === 'done'))
    .map((i) => i.id);
}
