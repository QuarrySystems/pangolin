---
title: Agora Offload — offload-audit wave design (tamper-evident audit log)
date: 2026-05-31
status: design (approved direction; implementation plan pending)
branch: feat/offload-audit
authors: [human:Brett, agent:claude-opus-4-8]
builds_on: "[[docs/superpowers/specs/2026-05-29-agora-offload-v1-design.md]]"
---

# Agora Offload — `offload-audit` wave design

> Implements §6.3 (tamper-evident audit log), the `verify` routine, and §6.6
> (encryption-at-rest defaults) of the agora-offload V1 spec. The `agora orch
> audit` **CLI** export stays in the next wave (`offload-surface`, §9 staging);
> this wave ships the engine-side library + machinery.

## 0. Context & scope

The runner (`offload-runner` #18) and escape (`offload-escape` #19) waves shipped
the submit→run→escape→`result_ref` spine and the §6.2 content-addressed dispatch
manifest (written on fire; `signature?` field reserved). This wave makes a run's
record **tamper-evident**: a durable, hash-chained, Merkle-rooted, signed,
externally-anchored audit log, plus a `verify(runId)` routine that proves it.

**In scope:** the `Signer` / `AuditAnchor` contracts; the Merkle + hash-chain
crypto; the engine-side `AuditLog` (append on engine operations, seal per run);
`LocalSigner` + `NoneSigner`; `LocalAnchor` + `S3ObjectLockAnchor` (with a *real*
`fetch`); the `verify(runId)` routine + `VerificationReport`; SQLite persistence;
encryption-at-rest defaults; conformance vectors; and the two §6.3 spec-wording
fixes.

**Out of scope (deferred / later waves):** `KmsSigner` (KMS asymmetric keys don't
offer ed25519, so a KMS signature would not cross-verify against the shared
baseline — deferred until a real need; the seam is left clean); `WitnessAnchor`
(§6.3 already defers it); the `agora orch audit` **CLI/bundle export** (→
`offload-surface`); BYOK/KMS-managed keys and automated retention policy (V1.1).

### 0.1 Decisions locked in brainstorming

1. **Event source = engine operations** (not the worker's internal lifecycle
   stream). The audit entries are the orchestrator's own observable lifecycle —
   submit / fire / reconcile / retry / skip / cancel / run-complete — each with
   actor + timestamp. This honors the V1-D4 executor-agnostic guardrail (the
   audit layer references no AI/dispatch concepts), needs no callback / inbound
   networking, is durable on the sole-writer engine, and is exactly §6.5's
   "outcomes + retry history + actors."
2. **Signer/Anchor scope:** `LocalSigner` + `NoneSigner` + `LocalAnchor` +
   `S3ObjectLockAnchor`. `KmsSigner` deferred.
3. **Mneme is the contract reference.** Mneme's *shipped* `src/audit/*` is the
   authoritative protocol; agora matches it byte-for-byte.

## 1. Mneme alignment (the load-bearing constraint)

agora and Mneme are the two halves of the platform; their audit roots and
signatures MUST cross-verify. Mneme is **fully implemented** (verified against
`C:/Users/brett/source/repos/My_Projects/Mneme/src/audit/{types,merkle,audit-log,signers}.ts`).
agora replicates its pinned rules exactly. (Not shared *code* — D11, agora takes
no Quarry-lib deps — but byte-identical *protocol*, pinned by conformance
vectors.)

### 1.1 The pinned protocol (verbatim from Mneme's code)

- **Contract** (`src/audit/types.ts`) — copied verbatim into agora
  `contracts/audit.ts`:
  ```typescript
  export type Guarantee = 'detect' | 'external-immutable' | 'witnessed';
  export const GUARANTEE_RANK: Record<Guarantee, number> = { detect: 0, 'external-immutable': 1, witnessed: 2 };
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
  ```
  (No `listEpochs`. `fetch`'s `since?: string` is typed string but carries a
  numeric epoch-ms at runtime — mirrored verbatim, wart and all.)
- **Canonicalization** — a positional `JSON.stringify([...ordered fields])`
  array. **NOT JCS, no library.** Each product pins its *own* ordered field
  array; the chaining/Merkle rules are what match. (Mneme: `[op,corpusId,…]`.)
- **Chain hash** — `entryHash = sha256(canon(entry) + prevHash).digest('hex')`
  (canon string first, prev hex appended, **no domain tag**); genesis
  `prevHash = ""`. `entryHash`/`prevHash` are lowercase hex strings.
- **Merkle** (`src/audit/merkle.ts`): leaf `SHA256(0x00 ‖ leafBytes)`, internal
  `SHA256(0x01 ‖ L ‖ R)`; empty tree → 32 zero bytes; **odd node carried up
  unhashed** (NOT duplicated). Leaves are the entry hashes decoded from hex to 32
  raw bytes (`Buffer.from(entryHash,'hex')`), then leaf-hashed.
- **Signer** (`src/audit/signers.ts`): `LocalSigner` = ed25519 (`node:crypto`),
  signs `Buffer.from(root)`, `alg:'ed25519'`, public key exported SPKI-DER;
  `NoneSigner` = `{alg:'none', bytes: 0-length}`.

### 1.2 §6.3 spec corrections (this wave)

The agora V1 spec §6.3 is mostly correct; two edits land here:
1. Source-path citation `src/contracts/audit.ts` → `src/audit/types.ts`.
2. Odd-node wording "an odd level duplicates its last node" → "an odd level
   carries up its last node unhashed."
(Genesis `""`, the chain hash, Merkle domain tags, empty→32-zero, ed25519/SPKI,
and "ordered JSON-stringified field array" are already correct.)

### 1.3 Where agora extends Mneme (coordination notes)

- **Conformance vectors exist in neither repo.** agora authors them (encoding the
  pinned protocol); they become the shared fixtures Mneme adopts later.
- **Mneme's `S3ObjectLockAnchor.fetch()` is stubbed.** agora implements the real
  S3 `GetObject` fetch — required because verification must consult the external
  anchor.
- **Mneme has no unified verify routine** (only `verifyChain` + `auditReport`).
  agora builds the full `verify(runId)`. Primitives match, so roots/signatures
  cross-verify.

## 2. Architecture

```
agora-orchestrator/src/
  contracts/
    audit.ts          [NEW] Signer/AuditAnchor/Signature/AnchorReceipt/AnchoredRoot/
                            Guarantee/GUARANTEE_RANK (verbatim) + AuditEntry +
                            VerificationReport + AuditStore
  audit/
    manifest.ts       [EXISTING] §6.2 dispatch manifest (untouched)
    canon.ts          [NEW] positional-array canonicalize for agora audit entries
    merkle.ts         [NEW] merkleRoot + entry-chain hashing (Mneme-identical)
    signer.ts         [NEW] createLocalSigner (ed25519/SPKI) + NoneSigner
    anchor.ts         [NEW] LocalAnchor (detect) + S3ObjectLockAnchor (external-immutable)
    audit-log.ts      [NEW] AuditLog: append(entry) chains+persists; sealEpoch(runId)
                            merkle→sign→anchor→persist
    verify.ts         [NEW] verify(runId): recompute→fetch→compare→verify-sig→report
  runstate/
    sqlite.ts         [EXTEND] AuditStore impl: audit_entries + audit_roots tables
  orchestrator.ts     [EXTEND] optional auditLog injection; append on operations
  engine/tick.ts      [EXTEND] append fire/reconcile/retry/skip entries; seal on run-complete
test/conformance/audit-vectors/   [NEW] chain-basic, merkle-odd, merkle-empty, sign-ed25519
```

All new seams live in `contracts/` (D8/D11). The `audit/` modules and the
`engine`/`runstate` extensions reference **no AI/dispatch concepts** (V1-D4) — an
`AuditEntry` is an opaque engine operation; the dispatch executor is invisible to
this layer.

## 3. Components

### 3.1 `AuditEntry` (agora's pinned field set)

Per-run chain. Canonical form = ordered positional array (§1.1):

```typescript
export interface AuditEntry {
  runId: string;
  seq: number;                 // per-run monotonic, 0-based
  kind: 'run.submitted' | 'item.fired' | 'item.reconciled'
      | 'item.retried' | 'item.skipped' | 'run.cancelled' | 'run.completed';
  itemId?: string;             // absent for run-level events
  status?: string;            // terminal status on reconcile/skip
  actor?: string;             // submitter / canceller identity
  manifestRef?: string;       // on item.fired
  resultRef?: string;         // on item.reconciled (done)
  at: string;                 // ISO-8601
}
// canon order (nulls for absent): [kind, runId, itemId??null, status??null,
//   actor??null, manifestRef??null, resultRef??null, at, seq]
```

`entryHash = sha256(canon(entry) + prevHash).hex`. The chain is **per run**
(epoch = run); genesis `prevHash=""` at each run's `seq=0`.

### 3.2 `audit/canon.ts`, `audit/merkle.ts`

Pure functions, Mneme-identical (§1.1). `canonEntry(entry)` →
`JSON.stringify([...])`; `chainHash(canonStr, prevHex)` → hex; `merkleRoot(
leaves: Uint8Array[])`; `leavesFromEntryHashes(hexes: string[])` →
`hexes.map(h => Buffer.from(h,'hex'))`.

### 3.3 `audit/signer.ts`

`createLocalSigner(keyRef?='local')` → `Signer & { publicKey: Buffer }` (ed25519,
SPKI-DER). `NoneSigner: Signer`. Registry-injected (D8).

### 3.4 `audit/anchor.ts`

- `LocalAnchor` — `id:'local'`, `guarantee:'detect'`. `anchor()` persists the
  signed root in the engine's own store (same DB); `fetch()` reads it back.
  Catches accidental/clumsy mutation; **not** evidence against a DB-controlling
  attacker.
- `S3ObjectLockAnchor` — `id:`s3:${bucket}``, `guarantee:'external-immutable'`.
  `anchor()` `PutObject`s the signed root under a deterministic key with
  Object-Lock retention in **COMPLIANCE** mode; `fetch()` `GetObject`s it back
  (the real implementation Mneme lacks). `locator = s3://bucket/key`. Tested
  against a faked S3 client (mirrors `AwsSecretStore`/`agora-storage-s3`).

### 3.5 `audit/audit-log.ts` — `AuditLog`

```typescript
class AuditLog {
  constructor(deps: { store: AuditStore; signer: Signer; anchor: AuditAnchor });
  append(entry: Omit<AuditEntry,'seq'>): void;   // assigns seq, chains, persists
  sealEpoch(runId: string): Promise<AnchorReceipt>; // merkle→sign→anchor→persist root
}
```

`append` reads the run's current chain head (last `entryHash` or `""`), computes
`entryHash`, persists the entry. `sealEpoch` reads the run's entry hashes, builds
the Merkle root, signs it, calls `anchor.anchor()`, and persists the
`AnchoredRoot` + receipt.

### 3.6 `audit/verify.ts` — `verify(runId)`

```typescript
async function verify(runId: string, deps: { store: AuditStore; anchor: AuditAnchor;
  verifySignature?: (root,sig)=>boolean }): Promise<VerificationReport>;

interface VerificationReport {
  runId: string;
  intact: boolean;            // chain + Merkle recompute + anchored-root match + sig
  anchorId: string;
  guarantee: Guarantee;       // CONFIGURED tier
  claim: 'tamper-evident' | 'tamper-detecting';  // PROVEN tier
  failure?: 'chain' | 'anchor-missing' | 'root-mismatch' | 'signature';
}
```

Steps: recompute the chain from persisted entries → recompute the Merkle root →
`anchor.fetch({epochId: runId})` the anchored root → recomputed root MUST equal
the fetched root → verify the signature over the root. **Any** mismatch /
missing / unreachable anchor → `intact:false` and `claim` drops to
`tamper-detecting` **regardless of configured tier** (the claim follows what
verification can prove). `claim = tamper-evident` only when `intact` AND
`GUARANTEE_RANK[guarantee] >= external-immutable`.

### 3.7 Persistence — `AuditStore` (SQLite)

`SqliteRunStateStore` implements `AuditStore` (it already owns the DB + guarded
migrations; one writer per D3). Additive tables:

```sql
CREATE TABLE IF NOT EXISTS audit_entries (
  run_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
  item_id TEXT, status TEXT, actor TEXT, manifest_ref TEXT, result_ref TEXT,
  at TEXT NOT NULL, entry_hash TEXT NOT NULL, prev_hash TEXT NOT NULL,
  PRIMARY KEY (run_id, seq));
CREATE TABLE IF NOT EXISTS audit_roots (
  epoch_id TEXT PRIMARY KEY, root BLOB NOT NULL,
  sig_alg TEXT, sig_bytes BLOB, sig_keyref TEXT,
  anchor_id TEXT NOT NULL, guarantee TEXT NOT NULL, receipt_at INTEGER NOT NULL,
  locator TEXT, anchored_at TEXT NOT NULL);
```

`AuditStore` methods: `appendAuditEntry(row)`, `getAuditEntries(runId)`,
`getAuditChainHead(runId)`, `putAuditRoot(root)`, `getAuditRoot(epochId)`. The
chain head is derivable (`MAX(seq)` entry's hash) — no separate column. (`LocalAnchor`
persists via `putAuditRoot`; `S3ObjectLockAnchor` persists to S3 and the receipt
is also recorded locally for the bundle.)

### 3.8 Engine wiring

`AgoraOrchestrator` gains an **optional** `auditLog?: AuditLog` (construction-time,
like `packs`). When present:
- `submitRun(run, actor, …)` → `append({kind:'run.submitted', runId, actor, at})`.
- `tick` fire → `append({kind:'item.fired', runId, itemId, manifestRef, at})`.
- `tick` reconcile terminal → `append({kind:'item.reconciled', runId, itemId,
  status, resultRef, at})`; retry → `item.retried`; skip → `item.skipped`.
- `cancel` (when added) → `run.cancelled`.
- When a run's items are **all terminal** → `append({kind:'run.completed'})` then
  `await auditLog.sealEpoch(runId)`.

When `auditLog` is absent the engine behaves exactly as today (no-audit), so
every existing test is untouched (mirrors the `packs` optionality). The engine
passes only generic strings — it never inspects entry semantics (V1-D4).

## 4. Encryption at rest (§6.6)

- S3 anchor `PutObject` and the S3 storage provider set **SSE** (KMS-capable) by
  default; documented.
- Local: document the encrypted-volume expectation for the run-state DB + audit
  tables + patch artifacts.
- Patch artifacts (`result_ref`) are treated as confidential (may contain PHI);
  documented in the data-flow note. Automated retention/purge is V1.1.

Mostly config + documentation; the only code is the SSE default on S3 requests.

## 5. Conformance vectors

Committed JSON fixtures under `test/conformance/audit-vectors/` encoding the
pinned protocol, each with inputs + expected outputs:
- `chain-basic.json` — entries → entry hashes (genesis `""`, `sha256(canon+prev)`).
- `merkle-odd.json` — odd leaf count → root (proves carry-up, not duplicate).
- `merkle-empty.json` — empty → 32 zero bytes.
- `sign-ed25519.json` — a fixed keypair (SPKI-DER pub) + root → signature, and a
  verify-true / verify-false pair.
agora's tests assert against these; they are the shared reference Mneme adopts.

## 6. Acceptance criteria (the §6.3 / §10 gates)

1. `verify(runId)` returns `intact:true`, `claim:'tamper-detecting'` for a clean
   run under `LocalAnchor`; `'tamper-evident'` under `S3ObjectLockAnchor`.
2. **Mutating any persisted entry makes `verify` fail** (`failure:'chain'` or
   `'root-mismatch'`), and the claim drops to `tamper-detecting`.
3. A run sealed under `S3ObjectLockAnchor` whose **DB entries are tampered but the
   anchored root is not** fails verification by root mismatch against the fetched
   anchored root (the external-immutable demo).
4. `verify` against a missing/unreachable anchor → `failure:'anchor-missing'`,
   `claim:'tamper-detecting'`.
5. Conformance vectors pass; agora's Merkle/chain/signature primitives match the
   pinned bytes exactly.
6. No secret values in any audit entry/root/export — a test greps a serialized
   audit export for a known secret value and fails on a hit.
7. The engine with no `auditLog` injected behaves identically to today (all
   pre-existing orchestrator tests pass); with it injected, entries accrue and
   the run seals on completion.
8. Per-task gate runs **`typecheck`** (vitest's esbuild ignores type errors).
