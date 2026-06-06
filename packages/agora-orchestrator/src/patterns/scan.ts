import type { ItemState } from '../contracts/types.js';
import type { Pattern, CollectedSpawn } from '../contracts/pattern.js';   // contract lives in contracts/

const TERMINAL = new Set(['done', 'failed', 'skipped', 'cancelled']);

/** PURE — runItems are ONE run's items, de-namespaced. The orchestrator groups by run,
 *  de-namespaces, and applies the returned directives via extendRun. */
export function collectSpawns(runItems: ItemState[], pattern: Pattern): CollectedSpawn[] {
  const out: CollectedSpawn[] = [];
  for (const it of runItems) {
    if (!TERMINAL.has(it.status)) continue;
    const d = pattern.onTaskDone(it, { runItems });
    if (d && d.items.length > 0) out.push({ causeItemId: it.id, items: d.items });
  }
  return out;
}
