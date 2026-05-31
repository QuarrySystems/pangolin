import type { ItemState } from '../contracts/index.js';

/** ids of currently-`pending` items whose every dependency is `done`. */
export function computeNewlyReady(items: ItemState[]): string[] {
  const status = new Map(items.map((i) => [i.id, i.status]));
  return items
    .filter((i) => i.status === 'pending' && i.depends_on.every((d) => status.get(d) === 'done'))
    .map((i) => i.id);
}

/**
 * Returns the full multi-hop downstream closure: every item whose `depends_on`
 * (transitively) includes any id in `rootIds`. Order-independent; excludes the roots themselves.
 */
export function transitiveDependents(items: ItemState[], rootIds: string[]): string[] {
  const failed = new Set(rootIds);
  const result = new Set<string>();

  // Build an adjacency map: depId -> items that depend on it
  const dependsOnMap = new Map<string, string[]>();
  for (const item of items) {
    for (const dep of item.depends_on) {
      if (!dependsOnMap.has(dep)) dependsOnMap.set(dep, []);
      dependsOnMap.get(dep)!.push(item.id);
    }
  }

  // BFS/DFS from the root failed ids
  const queue = [...rootIds];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const children = dependsOnMap.get(current) ?? [];
    for (const child of children) {
      if (!failed.has(child) && !result.has(child)) {
        result.add(child);
        queue.push(child);
      }
    }
  }

  return [...result];
}
