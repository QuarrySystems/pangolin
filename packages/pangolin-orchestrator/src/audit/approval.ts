import { canonicalJsonString, computeContentHash } from '@quarry-systems/pangolin-core';

/** The immutable evidence sealed when a human decides — proves WHO approved, WHEN, of what.
 *  This is the pure evidence type; the executor's request/source/sink interfaces live with
 *  {@link HumanApprovalExecutor}. */
export interface ApprovalRecord {
  approvalId: string;
  runId: string;
  subjectItemId: string;
  approverRole: string;
  approver: string;
  decision: 'approve' | 'reject';
  decidedAt: string;
  reason?: string;
}

export interface SealApprovalOptions {
  /** Namespace prefix for the record ref. Default 'ns'. */
  namespace?: string;
}

export interface SealApprovalResult {
  /** Content-addressed `pangolin://<ns>/approval/a/<sha256>` ref the record seals under. */
  ref: string;
  /** The canonical-JSON bytes the caller persists at `ref` (content-addressed). */
  bytes: Uint8Array;
}

/**
 * Seal an {@link ApprovalRecord} into a content-addressed ref + its canonical bytes.
 *
 * This is the single source of truth for the approval seal — the same canonicalize →
 * SHA-256 → `pangolin://<ns>/approval/a/<hash>` path that `verifyBundle` binds through
 * `outputRefs.approval`. It is **engine-free**: `HumanApprovalExecutor.reconcile()` calls
 * it when Pangolin's run-engine drives the approval, and an external orchestrator (one
 * that keeps its own control flow and wraps Pangolin as an audit seam) calls it directly.
 * The caller persists `bytes` at `ref` (content-addressed) and references `ref` from the
 * chain via `outputRefs.approval`.
 */
export function sealApproval(
  record: ApprovalRecord,
  opts: SealApprovalOptions = {},
): SealApprovalResult {
  const namespace = opts.namespace ?? 'ns';
  const bytes = new TextEncoder().encode(canonicalJsonString(record));
  // computeContentHash returns a `sha256:`-prefixed digest; the URI's last segment is that
  // digest verbatim (mirrors the dispatch/pattern-harness convention so verifyBundle's
  // content-address check binds it).
  const ref = `pangolin://${namespace}/approval/a/${computeContentHash(bytes)}`;
  return { ref, bytes };
}
