# Seal trusted-time + standalone verifier — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the audit seal independently verifiable by an auditor running a minimal tool, and let it carry a trusted (RFC 3161) timestamp — implementing items #1 and #6 of the accepted seal-compliance decision.

**Architecture:** Extract the pure verification core (chain/Merkle/canon/`verify`/`verifyBundle`) from `pangolin-orchestrator` into `pangolin-core` so there is ONE non-divergent implementation. Add a pluggable `TimestampAuthority` seam whose ASN.1/CMS weight is scoped to a new minimal `@quarry-systems/pangolin-verify` package and injected into core's `verify()` exactly as `verifySignature` already is (core stays dependency-light). Trusted time is reported as a separate `timeTier` dimension, never collapsed into the tamper claim. All data-model changes are additive (existing bundles verify byte-identically).

**Tech Stack:** TypeScript (ESM, NodeNext), pnpm workspaces, vitest, `node:crypto`, a pure-JS ASN.1/CMS toolkit (ratified in Task 0), commander (CLI).

**Spec:** `docs/superpowers/specs/2026-06-12-seal-trusted-time-and-standalone-verifier-design.md`

**Conventions (verified against the repo — follow exactly):**
- ESM with explicit `.js` import suffixes (NodeNext). No `any` (eslint `@typescript-eslint/no-explicit-any` is an error). Catch blocks use `(err as Error)`.
- Per-package gate is `eslint src --ext .ts` + `tsc --noEmit` + `vitest run`. A PostToolUse hook lints every edited file (tests included) — keep all edits lint-clean.
- TDD: write the failing test, run it, watch it fail, then implement. Commit per task.
- Branch: do this work on `feat/seal-trusted-time-verifier` (off `main`). Do NOT reuse the spec branch for code.

---

## File Structure

**`packages/pangolin-core/` (gains the verification core — NO new runtime deps):**
- Create `src/audit.ts` — audit contract TYPES (moved from orchestrator) + the new `TimestampToken` type and `TimestampAuthority` interface.
- Create `src/audit-merkle.ts`, `src/audit-canon.ts`, `src/audit-verify.ts`, `src/audit-verify-bundle.ts` — the moved pure logic (prefixed `audit-` to sit unambiguously beside `content-hash.ts`/`s3-clients.ts`).
- Modify `src/index.ts` — re-export the new audit surface from the barrel.

**`packages/pangolin-orchestrator/` (keeps the WRITE path; imports the core):**
- Modify `src/audit/audit-log.ts` — keep `AuditLog`; add optional `timestamper`.
- Modify `src/audit/anchor.ts`, `src/audit/signer.ts` — unchanged logic; re-point type imports to core.
- Replace `src/audit/{canon,merkle,verify,verify-bundle}.ts` with thin re-export shims from `@quarry-systems/pangolin-core` (preserve the public surface).
- Modify `src/contracts/audit.ts` — re-export the audit types from core (single source).

**`packages/pangolin-verify/` (NEW minimal package — owns the ASN.1/CMS dep):**
- `package.json`, `tsconfig.json`, `BUSL-1.1`, `README.md` (no `vitest.config.ts` — leaf packages inherit the root's).
- `src/index.ts` — barrel.
- `src/timestamp-authority.ts` — `NoTimestampAuthority`, `Rfc3161TimestampAuthority`, `LocalCaTimestampAuthority`, `verifyTimestamp`.
- `src/verify-context.ts` — load bundle + verify-context, build the offline / anchor-checked anchor.
- `src/cli.ts` — the `pangolin-verify` bin.

**`packages/pangolin-cli/`:**
- Modify `src/cmd-verify.ts` — pass an optional `verifyTimestamp` through to `verifyBundle`.

**Repo root:**
- Create `VERIFICATION.md` — the auditor-facing format + algorithm doc (written in Task 3, before the package body).

---

## Task 0: Ratify the ASN.1/CMS library (spike)

**Why:** RFC 3161 token verification needs ASN.1/CMS parsing that `node:crypto` does not provide. De-risk the library choice before the seam hardens. Candidate: `pkijs` + `asn1js` (PeculiarVentures, pure-JS, MIT, no native bindings, mature TSP support). Alternative: `@peculiar/asn1-schema` + `@peculiar/asn1-cms` + `@peculiar/asn1-tsp`.

**Files:**
- Create: `spike/rfc3161/package.json`, `spike/rfc3161/roundtrip.mjs`
- Create (output): `spike/rfc3161/FINDINGS.md`

- [ ] **Step 1: Scaffold the throwaway spike**

```bash
mkdir -p spike/rfc3161
cd spike/rfc3161
cat > package.json <<'JSON'
{ "name": "spike-rfc3161", "private": true, "type": "module",
  "dependencies": { "pkijs": "^3.2.4", "asn1js": "^3.0.5", "pvutils": "^1.1.3" } }
JSON
npm install
```

- [ ] **Step 2: Write a round-trip that proves create + verify against a LOCAL CA**

`spike/rfc3161/roundtrip.mjs`: using the candidate lib, (a) build a self-signed CA + a TSA cert, (b) accept a `messageImprint` (SHA-256 of an arbitrary 32-byte root), (c) issue an RFC 3161 `TimeStampToken` (CMS SignedData), (d) verify the token: parse it, confirm `messageImprint` equals the root hash, and validate the signature chains to the CA. Print `OK <tsa-time>` or throw.

- [ ] **Step 3: Run it**

Run: `node spike/rfc3161/roundtrip.mjs`
Expected: prints `OK <ISO time>` — the lib can both mint and verify a token offline with no network.

- [ ] **Step 4: (Optional, network) verify a real public TSA token**

If egress is available, request a token from `https://freetsa.org/tsr` over a known hash and verify it against freeTSA's published CA cert (committed as a fixture). If no egress, skip and note it.

- [ ] **Step 5: Record the decision and remove the spike**

Write `spike/rfc3161/FINDINGS.md` to this exact template (Task 3 depends on it being complete):

```markdown
# RFC 3161 / CMS library decision
## Ratified packages (exact versions)
- <pkg>: <version>   # e.g. pkijs: 3.2.4
- <pkg>: <version>   # e.g. asn1js: 3.0.5
## API entry points (real call chains, copy-pasteable)
- Mint a token (LocalCaTimestampAuthority): <the exact calls to build CA+TSA cert and sign a TimeStampToken over a messageImprint>
- Verify a token (verifyTimestamp): <the exact calls to parse the CMS SignedData, read messageImprint.hashedMessage, and validate the signer chains to a trusted cert>
## Gotchas
- <genTime/accuracy parsing, DER vs BER, cert-chain validation caveats, etc.>
```

Then:

```bash
git add spike/rfc3161/FINDINGS.md
git rm -r spike/rfc3161/node_modules spike/rfc3161/package-lock.json 2>/dev/null || true
git commit -m "spike(rfc3161): ratify ASN.1/CMS lib for trusted-timestamp tokens"
```

> The ratified package name + versions from FINDINGS.md are referenced as `<TSLIB>` below.

---

## Task 1: Extract the verification core into `pangolin-core`

**Why:** One non-divergent implementation shared by the sealer and the verifier. Mechanical move; behavior must not change. The existing orchestrator audit suite is the safety net.

**Files:**
- Create: `packages/pangolin-core/src/audit.ts`, `src/audit-canon.ts`, `src/audit-merkle.ts`, `src/audit-verify.ts`, `src/audit-verify-bundle.ts`
- Modify: `packages/pangolin-core/src/index.ts`
- Modify: `packages/pangolin-orchestrator/src/contracts/audit.ts`, `src/audit/{canon,merkle,verify,verify-bundle}.ts`, `src/audit/audit-log.ts`, `src/audit/anchor.ts`
- Test: the existing `packages/pangolin-orchestrator/test/audit/**` suite (must stay green)

- [ ] **Step 1: Move the audit TYPES into core**

Cut the type/`const` declarations from `packages/pangolin-orchestrator/src/contracts/audit.ts` (`Guarantee`, `GUARANTEE_RANK`, `Signature`, `AnchorReceipt`, `AnchoredRoot`, `Signer`, `AuditAnchor`, `AuditEntryKind`, `AuditEntry`, `CheckResult`, `VerificationReport`, `AuditEntryRow`, `AuditStore`, `AuditItemOutcome`, `AuditExport`, `AuditBundle`) into a new `packages/pangolin-core/src/audit.ts`. Keep `DispatchManifest` where it is and import it into `audit.ts` from its core location if already there, else move it too. Leave `packages/pangolin-orchestrator/src/contracts/audit.ts` as a pure re-export:

```ts
export * from '@quarry-systems/pangolin-core';
// (or, if narrower:) export type { Guarantee, AuditEntry, AuditBundle, ... } from '@quarry-systems/pangolin-core';
```

- [ ] **Step 2: Move the pure logic files into core**

Move file bodies verbatim, renaming to avoid collisions:
- `orchestrator/src/audit/canon.ts` → `core/src/audit-canon.ts`
- `orchestrator/src/audit/merkle.ts` → `core/src/audit-merkle.ts`
- `orchestrator/src/audit/verify.ts` → `core/src/audit-verify.ts`
- `orchestrator/src/audit/verify-bundle.ts` → `core/src/audit-verify-bundle.ts`

Update their internal imports to `./audit.js` (types) and to each other (`./audit-canon.js`, `./audit-merkle.js`). They import only `node:crypto` + types — confirm no orchestrator import sneaks in (`grep -n "orchestrator" core/src/audit-*.ts` must be empty).

- [ ] **Step 3: Export the surface from the core barrel**

In `packages/pangolin-core/src/index.ts` add:

```ts
export * from './audit.js';
export * from './audit-canon.js';
export * from './audit-merkle.js';
export * from './audit-verify.js';
export * from './audit-verify-bundle.js';
```

- [ ] **Step 4: Turn the orchestrator logic files into re-export shims**

Replace each of `orchestrator/src/audit/{canon,merkle,verify,verify-bundle}.ts` body with a shim so every existing `./canon.js` / `./merkle.js` / `./verify.js` import keeps working:

```ts
// packages/pangolin-orchestrator/src/audit/verify.ts
export { verify, claimFor } from '@quarry-systems/pangolin-core';
```
```ts
// canon.ts
export { canonEntry } from '@quarry-systems/pangolin-core';
// merkle.ts
export { chainHash, merkleRoot, leavesFromEntryHashes } from '@quarry-systems/pangolin-core';
// verify-bundle.ts  (checkHandoffClosure is INTERNAL to the moved file — not exported)
export { verifyBundle } from '@quarry-systems/pangolin-core';
```

`audit-log.ts` and `anchor.ts` keep their logic; their `import type { ... }` lines now resolve through `../contracts/index.js` (which re-exports core) — no change needed if they import types via the contracts barrel.

- [ ] **Step 5: Build core, then run the orchestrator audit suite**

Run:
```bash
pnpm --filter @quarry-systems/pangolin-core build
pnpm --filter @quarry-systems/pangolin-orchestrator exec vitest run test/audit
```
Expected: PASS — identical results to before the move (chain/Merkle/verify byte-identical). If a test imports a moved symbol directly from a path that no longer exports it, re-point that import to `@quarry-systems/pangolin-core` or the shim.

- [ ] **Step 6: Typecheck + lint the two packages**

Run:
```bash
pnpm --filter @quarry-systems/pangolin-core exec tsc --noEmit && pnpm --filter @quarry-systems/pangolin-core exec eslint src --ext .ts
pnpm --filter @quarry-systems/pangolin-orchestrator exec tsc --noEmit && pnpm --filter @quarry-systems/pangolin-orchestrator exec eslint src --ext .ts
```
Expected: clean.

- [ ] **Step 7: Add a dependency-graph guard test**

Create `packages/pangolin-core/test/no-orchestrator-dep.test.ts`:

```ts
import { it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

it('pangolin-core never imports from pangolin-orchestrator', () => {
  const dir = join(__dirname, '..', 'src');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    expect(src, `${f} must not import orchestrator`).not.toMatch(/pangolin-orchestrator/);
  }
});
```
Run it (PASS), then commit.

```bash
git add packages/pangolin-core packages/pangolin-orchestrator
git commit -m "refactor: extract audit verification core into pangolin-core (single source)"
```

---

## Task 2: `TimestampAuthority` seam + injected `verifyTimestamp` + additive data model

**Why:** Add trusted-time as a pluggable, honestly-tiered attribute without bloating core. Core defines the type+interface and an INJECTION point; the ASN.1 weight stays out (Task 3).

**Files:**
- Modify: `packages/pangolin-core/src/audit.ts` (types), `src/audit-verify.ts` (`verify` injection), `src/audit-verify-bundle.ts` (passthrough)
- Modify: `packages/pangolin-orchestrator/src/audit/audit-log.ts` (`timestamper` wiring)
- Test: `packages/pangolin-core/test/audit/timestamp-verify.test.ts`, extend `packages/pangolin-orchestrator/test/audit/audit-log.test.ts`

- [ ] **Step 1: Add the types + interface to core**

In `packages/pangolin-core/src/audit.ts` add:

```ts
export interface TimestampToken {
  alg: 'rfc3161';
  token: Uint8Array;       // DER RFC 3161 TimeStampToken (CMS SignedData); base64 in JSON
  at: string;              // ISO-8601 TSA-asserted time (display only; authoritative time is inside token)
  tsaUrl?: string;
}

export interface TimestampAuthority {
  readonly id: string;
  timestamp(rootHash: Uint8Array): Promise<TimestampToken>;
}

export type TimeTier = 'asserted' | 'tsa-attested';
```

Extend the existing interfaces (additive):

```ts
export interface AnchoredRoot {
  epochId: string; root: Uint8Array; signature?: Signature; receipt: AnchorReceipt;
  timestamp?: TimestampToken;   // NEW
}

export interface VerificationReport {
  // ...existing fields...
  timeTier: TimeTier;           // NEW
  checks: {
    chain: CheckResult; root: CheckResult; signature: CheckResult;
    anchor: CheckResult; handoff: CheckResult;
    time: CheckResult;          // NEW
  };
}
```

- [ ] **Step 2: Write the failing test for `verify`'s injected timestamp check**

`packages/pangolin-core/test/audit/timestamp-verify.test.ts`:

```ts
import { it, expect } from 'vitest';
import { verify } from '../../src/audit-verify.js';
import { chainHash, merkleRoot, leavesFromEntryHashes } from '../../src/audit-merkle.js';
import { canonEntry } from '../../src/audit-canon.js';
import type { AuditStore, AuditAnchor, AnchoredRoot, TimestampToken } from '../../src/audit.js';

function oneEntryStore(runId: string): { store: AuditStore; root: Uint8Array } {
  const h0 = chainHash(canonEntry({ runId, seq: 0, kind: 'run.submitted', at: 't0' }), '');
  const entries = [{ runId, seq: 0, kind: 'run.submitted' as const, at: 't0', entryHash: h0, prevHash: '' }];
  const root = merkleRoot(leavesFromEntryHashes([h0]));
  const store = { getAuditEntries: () => entries } as unknown as AuditStore;
  return { store, root };
}
function anchorWith(root: Uint8Array, token?: TimestampToken): AuditAnchor {
  const anchored: AnchoredRoot = {
    epochId: 'r', root, receipt: { anchorId: 'a', epochId: 'r', guarantee: 'external-immutable', at: 0 },
    ...(token ? { timestamp: token } : {}),
  };
  return { id: 'a', guarantee: 'external-immutable', async anchor() { return anchored.receipt; }, async fetch() { return [anchored]; } };
}

it('no token present -> time check n/a, timeTier asserted', async () => {
  const { store, root } = oneEntryStore('r');
  const r = await verify('r', { store, anchor: anchorWith(root) });
  expect(r.checks.time.ok).toBe('n/a');
  expect(r.timeTier).toBe('asserted');
});

it('valid token + verifyTimestamp true -> time ok, timeTier tsa-attested', async () => {
  const { store, root } = oneEntryStore('r');
  const token: TimestampToken = { alg: 'rfc3161', token: new Uint8Array([1]), at: '2026-01-01T00:00:00Z' };
  const r = await verify('r', {
    store, anchor: anchorWith(root, token),
    verifyTimestamp: (rt, tk) => rt.length > 0 && tk === token,
  });
  expect(r.checks.time.ok).toBe(true);
  expect(r.timeTier).toBe('tsa-attested');
});

it('token present but verifyTimestamp false -> time fails, tier stays asserted', async () => {
  const { store, root } = oneEntryStore('r');
  const token: TimestampToken = { alg: 'rfc3161', token: new Uint8Array([1]), at: '2026-01-01T00:00:00Z' };
  const r = await verify('r', { store, anchor: anchorWith(root, token), verifyTimestamp: () => false });
  expect(r.checks.time.ok).toBe(false);
  expect(r.timeTier).toBe('asserted');
});
```

- [ ] **Step 3: Run it — watch it fail**

Run: `pnpm --filter @quarry-systems/pangolin-core exec vitest run test/audit/timestamp-verify.test.ts`
Expected: FAIL (`verifyTimestamp` dep + `time`/`timeTier` fields not present).

- [ ] **Step 4: Implement the injection in `audit-verify.ts`**

Add the optional dep and compute the check after the anchor fetch (the token rides on the fetched `AnchoredRoot`):

```ts
export async function verify(
  runId: string,
  deps: {
    store: AuditStore; anchor: AuditAnchor;
    verifySignature?: (root: Uint8Array, sig: Signature) => boolean;
    verifyTimestamp?: (root: Uint8Array, token: TimestampToken) => boolean;   // NEW
  },
): Promise<VerificationReport> {
  // ...existing chain/root/signature computation, `anchored` already fetched...
  const tok = anchored?.timestamp;
  const timeOk: boolean | 'n/a' =
    tok && deps.verifyTimestamp ? deps.verifyTimestamp(anchored!.root, tok) : 'n/a';
  const timeTier: TimeTier = timeOk === true ? 'tsa-attested' : 'asserted';
  // add `time: { ok: timeOk }` to `checks`, and `timeTier` to the returned report.
  // `time` does NOT gate `intact` (deliberate — separate assurance dimension).
}
```

**Important — the `failure` field is unchanged.** Its enum stays
`'chain' | 'anchor-missing' | 'root-mismatch' | 'signature' | 'handoff'`. A failed time
check (`time.ok === false`) is informational only: it does NOT add a `'time'` variant, does
NOT set `failure`, and does NOT affect `intact`. It only forces `timeTier` to `asserted`.
Add an assertion to the Step 2 "verifyTimestamp false" test: `expect(r.failure).toBeUndefined()`
and `expect(r.intact).toBe(true)` (a clean tamper chain stays intact even when the TSA token is bad).

- [ ] **Step 5: Run the test (PASS) + the full core audit suite (no regression)**

Run:
```bash
pnpm --filter @quarry-systems/pangolin-core exec vitest run test/audit
```
Expected: PASS, including the existing verify/back-compat tests (which omit `verifyTimestamp` → `time.ok='n/a'`, `timeTier='asserted'`).

- [ ] **Step 6: Pass `verifyTimestamp` through `verifyBundle`**

In `src/audit-verify-bundle.ts`, widen the `deps` param (additive — old callers keep working since `verifyTimestamp` is optional) and thread it into the inner `verify()` call, exactly as `verifySignature` is already threaded:

```ts
export function verifyBundle(
  bundle: AuditBundle,
  deps: {
    anchor: AuditAnchor;
    verifySignature?: (root: Uint8Array, sig: Signature) => boolean;
    verifyTimestamp?: (root: Uint8Array, token: TimestampToken) => boolean;  // NEW, optional
  },
): Promise<VerificationReport>
```

Add a test asserting a bundle with a token + `verifyTimestamp:()=>true` reports `timeTier:'tsa-attested'`.

- [ ] **Step 7: Wire the optional `timestamper` into `AuditLog.sealEpoch`**

In `packages/pangolin-orchestrator/src/audit/audit-log.ts`, add `timestamper?: TimestampAuthority` to the constructor deps. In `sealEpoch`, after signing:

```ts
const signature = await this.deps.signer.sign(root);
let timestamp: TimestampToken | undefined;
if (this.deps.timestamper) {
  try { timestamp = await this.deps.timestamper.timestamp(root); }
  catch (err) { this.deps.onDrop?.({ runId, kind: 'run.completed', at: new Date(0).toISOString() }, err as Error); }
}
const receipt = await this.deps.anchor.anchor({ epochId: runId, root, signature });
this.deps.store.putAuditRoot({ epochId: runId, root, signature, receipt, ...(timestamp ? { timestamp } : {}) });
```

Add a test: a stub `timestamper` returning a token → `getAuditRoot(runId).timestamp` is set; a throwing `timestamper` → seal still succeeds, `timestamp` undefined (self-evidencing degradation), run not aborted.

- [ ] **Step 8: Typecheck + lint + commit**

Run the per-package `tsc --noEmit` + `eslint src` for core and orchestrator (clean), then:
```bash
git add packages/pangolin-core packages/pangolin-orchestrator
git commit -m "feat: TimestampAuthority seam + injected verifyTimestamp + additive time tier"
```

---

## Task 3: The `@quarry-systems/pangolin-verify` package + `VERIFICATION.md`

**Why:** Deliver the minimal artifact an auditor runs, owning the ASN.1/CMS dependency. Write `VERIFICATION.md` first so the format is design-driven.

**Files:**
- Create: `packages/pangolin-verify/{package.json,tsconfig.json,BUSL-1.1,README.md,vitest.config.ts}`
- Create: `packages/pangolin-verify/src/{index.ts,timestamp-authority.ts,verify-context.ts,cli.ts}`
- Create: `VERIFICATION.md` (repo root)
- Modify: `packages/pangolin-cli/src/cmd-verify.ts`
- Test: `packages/pangolin-verify/test/{timestamp.test.ts,verify-context.test.ts,no-orchestrator-dep.test.ts}`

- [ ] **Step 1: Write `VERIFICATION.md` first**

Document, sufficient to reimplement without the code: the `AuditBundle` JSON shape (`runId`, `manifests[]`, `auditLog.{entries,root}`, `items[]`, `report`); the verify-context shape (signer SPKI-DER public key (base64); a read-only anchor source — inline `AnchoredRoot` for offline, or S3 object-lock coordinates for anchor-checked; optional TSA CA cert(s) for the time check); the algorithm (recompute `chainHash` over `canonEntry`, check `prevHash` linkage + seq contiguity; recompute `merkleRoot`; compare to the anchored root; verify ed25519 signature; verify the RFC 3161 token's `messageImprint` == root and its CA chain; check handoff closure); and the two modes with their claim ceilings (`offline` → `tamper-detecting`; `anchor-checked` → `tamper-evident`). Commit.

- [ ] **Step 2: Scaffold the package (follow the leaf-package convention)**

`packages/pangolin-verify/package.json` — match `pangolin-secret-store/package.json` field-for-field (verified): `version: "0.2.0"`, empty/absent `devDependencies` (dev tools — vitest `^2.1.9`, typescript `^5.7.2`, eslint — are declared ONLY at the workspace root; do NOT redeclare them), `publishConfig`/`repository`/`homepage`/`bugs` present, `files: ["dist","README.md","LICENSE"]`, `bin` value without a leading `./` (matches `pangolin-cli`'s `"pangolin": "dist/index.js"`):

```json
{
  "name": "@quarry-systems/pangolin-verify",
  "version": "0.2.0",
  "license": "BUSL-1.1",
  "description": "Standalone auditor verifier for Pangolin Scale audit bundles — chain/Merkle/signature/RFC-3161 checks with zero orchestrator dependency.",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "bin": { "pangolin-verify": "dist/cli.js" },
  "publishConfig": { "access": "public" },
  "files": ["dist", "README.md", "LICENSE"],
  "repository": { "type": "git", "url": "git+https://github.com/QuarrySystems/pangolin.git", "directory": "packages/pangolin-verify" },
  "homepage": "https://quarrysystems.github.io/pangolin",
  "bugs": { "url": "https://github.com/QuarrySystems/pangolin/issues" },
  "scripts": {
    "lint": "eslint src --ext .ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "build": "tsc",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@quarry-systems/pangolin-core": "workspace:*",
    "commander": "^12.0.0",
    "pkijs": "<exact version from Task 0 FINDINGS.md>",
    "asn1js": "<exact version from Task 0 FINDINGS.md>"
  },
  "devDependencies": {}
}
```

> The `pkijs`/`asn1js` entries are illustrative of the Task-0 candidate; replace the names+versions with whatever FINDINGS.md ratified before `pnpm install` (the angle-bracket text is NOT valid JSON — substitute it).

Copy `tsconfig.json` and `BUSL-1.1` from `pangolin-secret-store` (matching `extends`/paths). Do **NOT** create a `vitest.config.ts` — leaf packages have none; they inherit the root config. Add a one-paragraph `README.md` stating it is the standalone auditor verifier. **Note:** NO dependency on `@quarry-systems/pangolin-orchestrator`.

- [ ] **Step 3: Write the failing timestamp round-trip test**

`packages/pangolin-verify/test/timestamp.test.ts`:

```ts
import { it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { LocalCaTimestampAuthority, verifyTimestamp } from '../src/timestamp-authority.js';

it('local-CA TSA issues a token that verifyTimestamp accepts for the same root', async () => {
  const tsa = new LocalCaTimestampAuthority();
  const root = createHash('sha256').update('root').digest();
  const token = await tsa.timestamp(root);
  expect(verifyTimestamp(root, token, [tsa.caCertDer])).toBe(true);
});

it('verifyTimestamp rejects a token whose messageImprint != root', async () => {
  const tsa = new LocalCaTimestampAuthority();
  const token = await tsa.timestamp(createHash('sha256').update('root').digest());
  const otherRoot = createHash('sha256').update('different').digest();
  expect(verifyTimestamp(otherRoot, token, [tsa.caCertDer])).toBe(false);
});

it('verifyTimestamp rejects a token signed by an untrusted CA', async () => {
  const tsaA = new LocalCaTimestampAuthority();
  const tsaB = new LocalCaTimestampAuthority();
  const root = createHash('sha256').update('root').digest();
  const token = await tsaA.timestamp(root);
  expect(verifyTimestamp(root, token, [tsaB.caCertDer])).toBe(false); // trust only B's CA
});
```

- [ ] **Step 4: Run it — watch it fail**

Run: `pnpm --filter @quarry-systems/pangolin-verify exec vitest run test/timestamp.test.ts`
Expected: FAIL (module not implemented).

- [ ] **Step 5: Implement `timestamp-authority.ts` with the ratified lib**

Implement using `<TSLIB>` (per Task 0): `verifyTimestamp(root, token, trustedCerts)` parses the CMS SignedData, checks `messageImprint.hashedMessage === SHA-256(root)`, and validates the signer chains to one of `trustedCerts`; returns boolean (never throws — wrap parse errors → `false`). `LocalCaTimestampAuthority` (exposes `caCertDer`) mints a real-shape token signed by a self-generated test CA — the offline `LocalAnchor` analogue. `Rfc3161TimestampAuthority` (constructor `{ url }`) POSTs a TimeStampReq and returns the token. `NoTimestampAuthority`'s `timestamp()` throws (it is never wired; the default is "no timestamper at all"), or omit it and treat "no timestamper" as the floor — prefer omission to avoid a throwing no-op. Run the test (PASS).

- [ ] **Step 6: Implement `verify-context.ts` + the two modes**

`loadBundle(path)` and `loadVerifyContext(path)` (JSON, base64→`Uint8Array` for keys/roots/tokens). `buildAnchor(ctx, bundle)`: if the context names an S3 object-lock source → return a read-only anchor that fetches the real WORM root (anchor-checked); else return a read-only anchor that returns `bundle.auditLog.root` (offline). Expose `verifySignature` (ed25519 via `node:crypto`, using the context's public key) and `verifyTimestamp` bound to the context's TSA certs. Test that offline mode caps the claim at `tamper-detecting` and the embedded-root anchor compares equal on a clean bundle.

- [ ] **Step 7: Implement `cli.ts` (the `bin`)**

`#!/usr/bin/env node` + commander: `pangolin-verify <bundle.json> [--anchor <verify-context.json>] [--json] [--full]`. Load bundle (+ context if given), call `verifyBundle` from `@quarry-systems/pangolin-core` with the built anchor + `verifySignature` + `verifyTimestamp`, render with the core's `renderVerification` (re-exported) or a local renderer, `process.exitCode = report.intact ? 0 : 1`. Mirror `pangolin-cli/src/cmd-verify.ts`.

- [ ] **Step 8: Barrel + dependency-graph guard**

`src/index.ts` re-exports the public surface. Add `test/no-orchestrator-dep.test.ts` (same shape as Task 1 Step 7, asserting no `pangolin-orchestrator` import across `src/`). Run all package tests (PASS).

- [ ] **Step 9: Re-point the existing CLI to pass `verifyTimestamp`**

In `packages/pangolin-cli/src/cmd-verify.ts`, thread an optional `verifyTimestamp` from the orch context (if the config provides TSA certs) into the `verifyBundle` call — additive, defaulting to omitted (back-compat: existing behavior unchanged). Run the CLI test suite (PASS).

- [ ] **Step 10: Workspace build + typecheck + lint + commit**

Run:
```bash
pnpm -r build && pnpm --filter @quarry-systems/pangolin-verify exec eslint src --ext .ts
```
Expected: clean topological build (verify depends only on core). Commit:
```bash
git add packages/pangolin-verify packages/pangolin-cli VERIFICATION.md
git commit -m "feat: pangolin-verify standalone package + VERIFICATION.md + RFC3161 timestamp impls"
```

---

## Task 4: Offline `tsa-attested` demo proof

**Why:** Prove the whole chain end-to-end: a sealed bundle carrying TSA-attested time, re-verified by an auditor process that has ONLY `pangolin-verify`.

**Files:**
- Create: `examples/verify-tsa/{README.md,produce.mjs,verify.mjs}` (or extend `examples/offload-fanout` per repo example conventions)
- Test: `examples/verify-tsa/test/proof.test.ts`

- [ ] **Step 1: Write the failing end-to-end proof test**

`examples/verify-tsa/test/proof.test.ts`: run a small in-proc seal wiring an `AuditLog` with a `LocalCaTimestampAuthority`, export the bundle + a verify-context (public key + embedded root + TSA CA cert), then verify it using ONLY the `@quarry-systems/pangolin-verify` surface. Assert `report.intact === true`, `report.timeTier === 'tsa-attested'`, `report.checks.time.ok === true`.

- [ ] **Step 2: Run it — watch it fail; then implement `produce.mjs` + `verify.mjs`**

`produce.mjs` seals a tiny run with the local-CA timestamper and writes `bundle.json` + `verify-context.json`. `verify.mjs` is the auditor side: imports only `@quarry-systems/pangolin-verify`, loads both files, verifies, prints the report. Implement until the test passes.

- [ ] **Step 3: Run the proof (PASS) + write the README**

Run: `pnpm --filter <example> exec vitest run`
Expected: PASS — `intact`, `tsa-attested`, time check ok, with no orchestrator import on the verify side.
Document the two commands in `README.md` (the demo motion).

- [ ] **Step 4: Final full-suite gate + commit**

Run:
```bash
pnpm -r lint && pnpm -r build && pnpm -r test
```
Expected: green (modulo the known Windows-local integration flakes — `data-mapreduce`, `pressure-runner` — which are environment timeouts, not logic). Commit:
```bash
git add examples
git commit -m "feat: offline tsa-attested verify demo — auditor re-verifies with only pangolin-verify"
```

---

## Self-Review notes (author)

- **Spec coverage:** #1 trusted timestamp → Tasks 0,2,3. #6 standalone verifier → Tasks 1,3. Extraction (§3.1) → Task 1. Honest tiers (§4.1) → Task 2 Steps 1–5. Data-model additivity (§6) → Task 2 Step 1 + the back-compat tests in Task 1/2. VERIFICATION.md (§5) → Task 3 Step 1. Demo (§8.4) → Task 4. Out-of-scope #2–#5 are not present (correct).
- **Dependency-light core:** enforced by the Task 1 Step 7 + Task 3 Step 8 guard tests, not just by intent.
- **Back-compat:** every existing audit test must pass after Task 1 (no behavior change) and after Task 2 (new fields default to `n/a`/`asserted`).
- **`<TSLIB>`** is the single deferred decision, ratified in Task 0 before any seam code — by design.
