import type { AuditEntry } from '../contracts/index.js';

/** Positional JSON array — Pangolin Scale's pinned field order. NOT JCS. Absent optionals → null.
 * Field order: [kind, runId, itemId, status, actor, manifestRef, resultRef, at, seq]
 */
export function canonEntry(e: AuditEntry): string {
  return JSON.stringify([
    e.kind,
    e.runId,
    e.itemId ?? null,
    e.status ?? null,
    e.actor ?? null,
    e.manifestRef ?? null,
    e.resultRef ?? null,
    e.at,
    e.seq,
  ]);
}
