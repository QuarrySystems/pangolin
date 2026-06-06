// Cross-system byte-parity: Guarantee/GUARANTEE_RANK/Signature/AnchorReceipt/AnchoredRoot/Signer/AuditAnchor
// are verbatim from Mneme src/audit/types.ts.
import type { DispatchManifest } from './manifest.js';
export type Guarantee = "detect" | "external-immutable" | "witnessed";

/** Rank used by the report to license the "tamper-evident" claim only at >= external-immutable. */
export const GUARANTEE_RANK: Record<Guarantee, number> = { detect: 0, "external-immutable": 1, witnessed: 2 };

export interface Signature { alg: string; bytes: Uint8Array; keyRef?: string; }
export interface AnchorReceipt { anchorId: string; epochId: string; guarantee: Guarantee; at: number; locator?: string; }
export interface AnchoredRoot { epochId: string; root: Uint8Array; signature?: Signature; receipt: AnchorReceipt; }

export interface Signer { sign(rootHash: Uint8Array): Promise<Signature>; readonly keyRef?: string; }

export interface AuditAnchor {
  readonly id: string;
  readonly guarantee: Guarantee;
  anchor(epoch: { epochId: string; root: Uint8Array; signature?: Signature }): Promise<AnchorReceipt>;
  fetch(range: { epochId?: string; since?: string }): Promise<AnchoredRoot[]>;
}

// agora-pinned entry (epoch = run; chain is per-run):
export type AuditEntryKind =
  | 'run.submitted' | 'item.fired' | 'item.reconciled'
  | 'item.retried' | 'item.skipped' | 'run.cancelled' | 'run.completed'
  | 'run.extended';

export interface AuditEntry {
  runId: string; seq: number; kind: AuditEntryKind;
  itemId?: string; status?: string; actor?: string;
  manifestRef?: string; resultRef?: string; at: string; // ISO-8601
}

export interface CheckResult {
  ok: boolean | 'n/a';   // 'n/a' = prerequisite genuinely absent (e.g. anchor missing) — never a false ✓
  detail?: string;       // e.g. "entry 7 hash ≠ recomputed"
}

export interface VerificationReport {
  runId: string; intact: boolean; anchorId: string; guarantee: Guarantee;
  claim: 'tamper-evident' | 'tamper-detecting';
  failure?: 'chain' | 'anchor-missing' | 'root-mismatch' | 'signature' | 'handoff';  // first failing check (kept for back-compat)
  checks: { chain: CheckResult; root: CheckResult; signature: CheckResult; anchor: CheckResult; handoff: CheckResult };
}

export interface AuditEntryRow extends AuditEntry { entryHash: string; prevHash: string; }

export interface AuditStore {
  appendAuditEntry(row: AuditEntryRow): void;
  getAuditEntries(runId: string): AuditEntryRow[];     // ordered by seq
  getAuditChainHead(runId: string): string;            // last entryHash, or '' if none
  putAuditRoot(root: AnchoredRoot): void;
  getAuditRoot(epochId: string): AnchoredRoot | undefined;
}

/** Per-item outcome row carried in an audit export — references only, never values. */
export interface AuditItemOutcome {
  id: string; status: string; attempts?: number; actor?: string;
  resultRef?: string; manifestRef?: string;
  /** Producer-side handoff evidence (spec §7): outputs/ deliverable refs, keyed by
   *  posix path. Refs only — content-addressed. */
  outputRefs?: Record<string, string>;
}

/** Refs-only audit export the service publishes to the outbox on epoch seal (§6.5). */
export interface AuditExport {
  runId: string;
  entries: AuditEntryRow[];
  root: AnchoredRoot | undefined;   // undefined when the run never sealed
  items: AuditItemOutcome[];
}

/** The assembled, verifiable §6.5 evidence bundle the CLI emits. */
export interface AuditBundle {
  runId: string;
  manifests: DispatchManifest[];
  auditLog: { entries: AuditEntryRow[]; root: AnchoredRoot | undefined };
  items: AuditItemOutcome[];
  report: VerificationReport;       // names the anchor + guarantee tier
}
