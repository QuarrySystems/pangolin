import type { ItemState } from '../contracts/index.js';

/**
 * Greedily select up to `slots` candidates whose resourceLocks intersect neither
 * `heldKeys` nor each other. Candidates are considered in array order (stable).
 */
export function selectRunnable(candidates: ItemState[], heldKeys: string[], slots: number): ItemState[] {
  const taken = new Set(heldKeys);
  const out: ItemState[] = [];
  for (const c of candidates) {
    if (out.length >= slots) break;
    if (c.resourceLocks.some((k) => taken.has(k))) continue;
    for (const k of c.resourceLocks) taken.add(k);
    out.push(c);
  }
  return out;
}
