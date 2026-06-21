import type { AuditEntry } from './audit.js';
import { canonicalJsonString } from './content-hash.js';

/** Positional JSON array — Pangolin Scale's pinned field order. NOT JCS. Absent optionals → null.
 * Field order: [kind, runId, itemId, status, actor, manifestRef, resultRef, at, seq]
 * (+ canonicalized authorization as a trailing element ONLY when present, then canonicalized
 * outputRefs as a trailing element ONLY when present — each appended conditionally so legacy
 * entries that carry neither serialize byte-identically to the pre-feature form, and an entry
 * with only authorization is unchanged from the pre-outputRefs form). authorization and
 * outputRefs never co-occur on the same entry kind (fired/denied carry authorization;
 * reconciled carries outputRefs), but the order is fixed for determinism either way.
 * SECURITY: outputRefs MUST be sealed here so provenance closure can derive the producer set
 * from the tamper-anchored chain — a producer ref left out of canonEntry would be forgeable.
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
  if (e.outputRefs !== undefined) arr.push(canonicalJsonString(e.outputRefs));
  return JSON.stringify(arr);
}
