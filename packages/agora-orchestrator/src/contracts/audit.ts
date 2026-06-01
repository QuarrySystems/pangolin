// Cross-system byte-parity: Guarantee/GUARANTEE_RANK/Signature/AnchorReceipt/AnchoredRoot/Signer/AuditAnchor
// are verbatim from Mneme src/audit/types.ts.
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
  | 'item.retried' | 'item.skipped' | 'run.cancelled' | 'run.completed';

export interface AuditEntry {
  runId: string; seq: number; kind: AuditEntryKind;
  itemId?: string; status?: string; actor?: string;
  manifestRef?: string; resultRef?: string; at: string; // ISO-8601
}

export interface VerificationReport {
  runId: string; intact: boolean; anchorId: string; guarantee: Guarantee;
  claim: 'tamper-evident' | 'tamper-detecting';
  failure?: 'chain' | 'anchor-missing' | 'root-mismatch' | 'signature';
}

export interface AuditEntryRow extends AuditEntry { entryHash: string; prevHash: string; }

export interface AuditStore {
  appendAuditEntry(row: AuditEntryRow): void;
  getAuditEntries(runId: string): AuditEntryRow[];     // ordered by seq
  getAuditChainHead(runId: string): string;            // last entryHash, or '' if none
  putAuditRoot(root: AnchoredRoot): void;
  getAuditRoot(epochId: string): AnchoredRoot | undefined;
}
