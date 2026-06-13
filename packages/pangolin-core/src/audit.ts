// @quarry-systems/pangolin-core — audit verification core: shared types.
//
// Single source of truth for the audit chain/Merkle/verify type surface,
// shared by the sealer (orchestrator write path) and the verifier. The
// orchestrator re-exports these via `contracts/audit.ts` so existing imports
// keep working.
//
// Cross-system byte-parity: Guarantee/GUARANTEE_RANK/Signature/AnchorReceipt/AnchoredRoot/Signer/AuditAnchor
// are verbatim from Mneme src/audit/types.ts.

// ── Manifest types ────────────────────────────────────────────────────────
// Moved into core alongside the audit types because `AuditBundle` references
// `DispatchManifest`, and core must NOT depend on the orchestrator package. These
// are pure type declarations with no runtime/import surface. The orchestrator
// re-exports them via `contracts/manifest.ts`.

/** Optional cryptographic signature. Populated by the SEPARATE offload-audit
 *  wave when a Signer is configured; absent in offload-escape. */
export interface ManifestSignature {
  alg: string;
  /** base64 of the signature bytes. */
  bytes: string;
  keyRef?: string;
}

export interface DispatchManifest {
  schemaVersion: 1;
  runId: string;
  itemId: string;
  parent: string;            // "run:<runId>"
  executor: string;          // which executor kind ran this (e.g. "dispatch")
  executorManifest: unknown; // executor-defined, content-hashed, OPAQUE here
  secretRefs: string[];      // REFERENCES ONLY — never values (all executors)
  actor: string;             // "human:<id>" | "agent:<id>"
  submittedAt?: string;      // ISO-8601, when the run was submitted (if known)
  /** Typed-product handoff (spec §7): input key -> already-pinned pangolin:// URI of the
   *  upstream product this dispatch consumed. Sealed at fire; absent when the item
   *  has no needs. REFERENCES only — refs are sha256 content hashes. */
  inputRefs?: Record<string, string>;
  /** Pinned pipeline-definition URI sealed at fire; absent for default-pipeline dispatches. */
  pipelineRef?: string;
  firedAt: string;           // ISO-8601, when this item was fired
  manifestHash: string;      // sha256:<hex> self-hash over all fields above
  signature?: ManifestSignature; // offload-audit; omitted in offload-escape
}

/** The dispatch executor's `executorManifest` block shape. A future `command`
 *  executor nests a different shape under the same key — the envelope is unchanged. */
export interface DispatchExecutorManifest {
  subagent: { name: string; contentHash: string };
  capabilities: Array<{ name: string; contentHash: string }>;
  env: Array<{ name: string; contentHash: string }>;
  workerImage: string;       // digest-pinned, e.g. ghcr.io/.../pangolin-worker@sha256:...
  model: { id: string; temperature: number; maxTokens: number };
}

// ── Audit types ───────────────────────────────────────────────────────────

export type Guarantee = "detect" | "external-immutable" | "witnessed";

/** Rank used by the report to license the "tamper-evident" claim only at >= external-immutable. */
export const GUARANTEE_RANK: Record<Guarantee, number> = { detect: 0, "external-immutable": 1, witnessed: 2 };

export interface Signature { alg: string; bytes: Uint8Array; keyRef?: string; }
export interface AnchorReceipt { anchorId: string; epochId: string; guarantee: Guarantee; at: number; locator?: string; }

/** Trusted-time evidence over a sealed Merkle root. A SEPARATE assurance dimension
 *  from the tamper claim — never collapsed into tamper-evident/tamper-detecting. The
 *  authoritative time lives INSIDE `token` (the RFC-3161 genTime); `at` is display-only.
 *  Concrete ASN.1/CMS verification + TSA clients live in a later package — core only
 *  defines the type + the injection point (see `verify`'s `verifyTimestamp`). */
export interface TimestampToken {
  alg: 'rfc3161';
  token: Uint8Array;       // DER RFC 3161 TimeStampToken (CMS SignedData); base64 in JSON
  at: string;              // ISO-8601 TSA-asserted time (display only; authoritative time is inside token)
  tsaUrl?: string;
}

/** Pluggable trusted-time authority. The orchestrator's sealer obtains a token over the
 *  sealed root best-effort (a TSA outage must never abort a seal). Implementations that
 *  own the RFC-3161 client/ASN.1 weight live OUTSIDE core. */
export interface TimestampAuthority {
  readonly id: string;
  timestamp(rootHash: Uint8Array): Promise<TimestampToken>;
}

/** Trusted-time tier reported ALONGSIDE the tamper claim. `tsa-attested` only when a token
 *  is present AND an injected verifier confirmed it; otherwise `asserted` (the chain timestamps
 *  are self-asserted by the sealer). A failed time check is INFORMATIONAL — it forces `asserted`
 *  but never gates `intact` or sets `failure`. */
export type TimeTier = 'asserted' | 'tsa-attested';

export interface AnchoredRoot { epochId: string; root: Uint8Array; signature?: Signature; receipt: AnchorReceipt; timestamp?: TimestampToken; }

export interface Signer { sign(rootHash: Uint8Array): Promise<Signature>; readonly keyRef?: string; }

export interface AuditAnchor {
  readonly id: string;
  readonly guarantee: Guarantee;
  anchor(epoch: { epochId: string; root: Uint8Array; signature?: Signature }): Promise<AnchorReceipt>;
  fetch(range: { epochId?: string; since?: string }): Promise<AnchoredRoot[]>;
}

// pangolin-pinned entry (epoch = run; chain is per-run):
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
  /** Trusted-time tier — a SEPARATE dimension from `claim`. A failed `time` check forces
   *  `asserted` but does NOT affect `intact`/`failure`/`claim`. */
  timeTier: TimeTier;
  failure?: 'chain' | 'anchor-missing' | 'root-mismatch' | 'signature' | 'handoff';  // first failing check (kept for back-compat). NOTE: no 'time' variant — time is informational.
  checks: { chain: CheckResult; root: CheckResult; signature: CheckResult; anchor: CheckResult; handoff: CheckResult; time: CheckResult };
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
