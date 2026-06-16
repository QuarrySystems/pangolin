import type { AuditEntry } from './audit.js';
import { canonicalJsonString } from './content-hash.js';

/** Positional JSON array — Pangolin Scale's pinned field order. NOT JCS. Absent optionals → null.
 * Field order: [kind, runId, itemId, status, actor, manifestRef, resultRef, at, seq]
 * (+ canonicalized authorization as a trailing 10th element ONLY when present, so legacy
 * entries without authorization serialize byte-identically to the pre-authorization form).
 */
export function canonEntry(e: AuditEntry): string {
  const arr: unknown[] = [
    e.kind,
    e.runId,
    e.itemId ?? null,
    e.status ?? null,
    e.actor ?? null,
    e.manifestRef ?? null,
    e.resultRef ?? null,
    e.at,
    e.seq,
  ];
  if (e.authorization !== undefined) arr.push(canonicalJsonString(e.authorization));
  return JSON.stringify(arr);
}
