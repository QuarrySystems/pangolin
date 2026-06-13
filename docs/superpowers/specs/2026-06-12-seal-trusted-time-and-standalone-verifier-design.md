# Seal compliance builds #1 + #6: trusted timestamp + standalone verifier

> **Status:** design, approved 2026-06-12. Implements items **#1 (trusted timestamp)**
> and **#6 (standalone verifier)** from the accepted decision
> `decision-2026-06-04-seal-must-meet-soc2-hipaa-eu-ai-act-iso` (vault) and its spec
> `spec-seal-compliance-requirements`. These two are the "build now, on-wedge,
> auditor-first-probed" items; **#2–#5 (authz-in-evidence, retention, access-log, key
> custody) stay demand-pulled and are explicitly out of scope here.**

## 1. Why

The audit seal is the moat of the provable-execution GTM. Its cryptographic core
(hash-chain + Merkle root + WORM anchor + Ed25519 signature + independent `verify()`)
is strong. Two edges an auditor probes first are open:

1. **Trusted time.** Every timestamp in the seal is the local clock (`Date.now()` /
   `new Date()`), which a self-hosting operator controls and an auditor cannot trust.
   "Ran at T" is operator-asserted, not independently provable.
2. **A standalone verifier artifact.** `verify()`/`verifyBundle()` exist in code and a
   `pangolin verify <bundle.json>` CLI wraps them, but the literal wedge promise —
   "trust the artifact, run the verifier yourself, you don't need us" — needs an
   isolated, documented tool an auditor can run **without installing the orchestrator.**

The organizing principle of this design: **one canonical verification core, no
divergence.** A verifier whose crypto could drift from the sealer is worse than no
verifier. So #6 is the spine, and #1 is one of the checks the verifier performs.

## 2. Scope

**In:** the `TimestampAuthority` seam + tiers; extraction of the pure verification core
into `pangolin-core`; a new minimal `@quarry-systems/pangolin-verify` package; a
committed `VERIFICATION.md`; additive data-model fields; the offline/anchor-checked
verify modes.

**Out (demand-pulled, unchanged):** #2 authz-in-evidence, #3 regime-configured
retention + written-policy artifact, #4 access-logging the bundle, #5 KMS/HSM/BYOK key
custody. No changes to the sealing *write* path beyond adding the timestamp call. No new
network-inbound surface.

## 3. Architecture & package layout

### 3.1 Extraction (the DRY/SoC heart)

The pure verification logic moves out of `packages/pangolin-orchestrator/src/audit/`
into **`packages/pangolin-core`** — already the home of `content-hash` and the S3-client
seam contracts (the established "shared seam" location that killed the dev-edge build
cycle, PR #58). What moves:

- `canon.ts` → `canonEntry` (the pinned positional serialization)
- `merkle.ts` → `chainHash`, `merkleRoot`, `leavesFromEntryHashes`
- `verify.ts` → `verify`, `claimFor`
- `verify-bundle.ts` → `verifyBundle`, `checkHandoffClosure`
- the audit contract **types** consumed by the above (`AuditEntry`/`AuditEntryRow`,
  `AnchoredRoot`, `AnchorReceipt`, `Signature`, `Guarantee`/`GUARANTEE_RANK`,
  `VerificationReport`, `CheckResult`, `AuditBundle`, `DispatchManifest`, …)

The types land in a **new `packages/pangolin-core/src/audit.ts`** (a sibling of the
existing `content-hash.ts` / `s3-clients.ts` seam files), re-exported from the core
barrel; the verify logic lands beside it (e.g. `verify.ts` / `merkle.ts` / `canon.ts`
under `pangolin-core/src/`). These are pure `node:crypto` + plain data with **no**
sqlite/orchestrator runtime dependency, so the move is mechanical.

**Core stays dependency-light.** Critically, core does **not** gain the RFC 3161
ASN.1/CMS dependency — `pangolin-core` is the base every package imports, so a heavy CMS
lib there would bloat the whole tree and contradict the "minimal verifier" goal. Core's
`verify()` already **injects** `verifySignature` rather than owning ed25519; trusted-time
follows the same idiom — `verify()` takes an optional injected `verifyTimestamp`
callback, and the ASN.1-heavy implementation lives only where it is used (§4).

After the move:

- `pangolin-orchestrator` **imports** the verification core from `pangolin-core` and
  re-exports the same surface for back-compat (its `AuditLog.sealEpoch` *write* path,
  `AuditStore`, anchors, signer, and the SQLite store all stay in orchestrator).
- The orchestrator's `src/audit/*` files become thin re-export shims (or are deleted and
  their importers re-pointed) — chosen per-file during implementation to minimize churn,
  but the **single source of truth for chain/Merkle/verify is `pangolin-core`.**

### 3.2 New package: `@quarry-systems/pangolin-verify`

A minimal package depending on `pangolin-core` plus the single ASN.1/CMS lib needed for
RFC 3161 token verification (§4.2) — **no** orchestrator/sqlite/Docker dependency. It
follows the repo's leaf-package conventions (verified against `pangolin-secret-store` /
`pangolin-storage-local`): `@quarry-systems/*` scope, `BUSL-1.1` license, `dist/`
publish, scripts `build: tsc` / `lint: eslint src --ext .ts` / `test: vitest run` /
`typecheck: tsc --noEmit`, and a `src/index.ts` barrel.

- CLI entry: a `bin` field — `"bin": { "pangolin-verify": "./dist/cli.js" }` — backed by
  `src/cli.ts` (commander, mirroring `pangolin-cli/src/cmd-verify.ts`).
- Entry: `npx @quarry-systems/pangolin-verify <bundle.json> [--anchor <verify-context.json>] [--json] [--full]`
- It loads a self-contained `AuditBundle` JSON and an optional read-only
  **verify-context** (signer public key + a read-only anchor source: an inline
  anchored-root JSON, or S3 object-lock coordinates), then runs the core `verifyBundle`.
- It contains **no** secrets, no Docker, no SQLite, no run-state — it is the artifact an
  auditor or the customer's customer runs. This mirrors the run-3 proof, which already
  persisted `bundle.json` + `verify-context.json` (signer public key + anchored roots).

`pangolin verify` (the existing CLI command) is re-pointed at the same core so there is
exactly one implementation path.

## 4. The `TimestampAuthority` seam (#1)

A new seam mirroring `AuditAnchor`/`Signer`. **Split by dependency weight:** the *type* and
the *interface* (zero deps) live in `pangolin-core/src/audit.ts`; the ASN.1/CMS-heavy
*token verification* and the concrete impls live where the dep belongs (§4.2).

In `pangolin-core` (no new deps):

```ts
export interface TimestampToken {
  alg: 'rfc3161';
  /** DER-encoded RFC 3161 TimeStampToken (CMS SignedData), base64 in JSON. */
  token: Uint8Array;
  /** TSA-asserted time, surfaced for display; the AUTHORITATIVE time is inside `token`. */
  at: string;            // ISO-8601
  tsaUrl?: string;
}

export interface TimestampAuthority {
  readonly id: string;
  /** Obtain a token binding a hash of `rootHash` to a trusted time. */
  timestamp(rootHash: Uint8Array): Promise<TimestampToken>;
}
```

`verify()` (in core) gains an **injected** timestamp check — exactly the idiom it already
uses for signatures (`verifySignature?`), so core never imports an ASN.1 lib:

```ts
verify(runId, {
  store, anchor,
  verifySignature?: (root, sig) => boolean,
  verifyTimestamp?: (root: Uint8Array, token: TimestampToken) => boolean,  // NEW, optional
})
```

The concrete check (parses the CMS SignedData, confirms the token's `messageImprint`
matches `root`, validates the TSA signature against trusted certs) is implemented in
`pangolin-verify` and passed in by the CLI / verify-context. When `verifyTimestamp` is
absent or no token is present, the time check is `n/a` and `timeTier = 'asserted'`.

### 4.1 Honest tiers

Trusted time is reported as **its own attribute**, never collapsed into the
tamper-evident/tamper-detecting claim:

| `timeTier`     | Meaning                                                        |
|----------------|----------------------------------------------------------------|
| `asserted`     | No token. Time is the operator's local clock (NTP floor only). |
| `tsa-attested` | RFC 3161 token present and valid; time independently provable. |

This keeps the proposed two-dimensional assurance model
(`decision-2026-06-09-evidence-assurance-is-two-dimensional`, still PROPOSED) **open**
rather than prematurely binding trusted-time into the tamper claim. A bundle never
renders `asserted` time as `tsa-attested`.

### 4.2 Implementations

The concrete impls + the CMS token verification live in `pangolin-verify` (and the
opt-in timestamper is constructed by the operator's config), so the **single ASN.1/CMS
dependency is scoped there, never in `pangolin-core`**. Library choice: a pure-JS,
maintained, MIT/Apache ASN.1+CMS toolkit with no native bindings (candidate:
`@peculiar/asn1-*` / `pkijs`); pinned, and used for both token *creation* (the impls
below) and *verification* (`verifyTimestamp`) so the two cannot diverge. The exact
library is ratified in the first plan task via a thin spike (round-trip a token through a
real public TSA + the local-CA fake) before the seam hardens.

- **`NoTimestampAuthority`** (default / floor): `sealEpoch` attaches no token; the seal
  documents the NTP floor. `timeTier = 'asserted'`. Keeps the no-egress posture intact.
- **`Rfc3161TimestampAuthority`** (opt-in): HTTP TSA client to a configurable URL
  (freeTSA / DigiCert / a corporate TSA). The only network-**egress** component, opted
  into by the operator — consistent with `S3ObjectLockAnchor` being the opt-in over
  `LocalAnchor`.
- **`LocalCaTimestampAuthority`** (test/offline fake, the `LocalAnchor` analogue): issues
  real-shape RFC 3161 tokens signed by a bundled test CA so tests and **offline demos**
  can exercise and *show* the `tsa-attested` tier with zero egress. Its CA is clearly a
  test cert; never shipped as a production trust root.

### 4.3 Write-path wiring

`AuditLog` (orchestrator) gains an optional `timestamper?: TimestampAuthority` in its
constructor deps (alongside `store`/`signer`/`anchor`). In `sealEpoch`, after computing
the Merkle `root` and signing it, it calls `timestamper.timestamp(root)` and stores the
returned token on the `AnchoredRoot` (§6). A `timestamp()` failure is **best-effort** — a
TSA outage downgrades the seal to `asserted` (no token written), it does not abort the
run, consistent with the best-effort audit posture (PR #65). **Degradation is
self-evidencing, not a separate counter:** token *absence* on the `AnchoredRoot` IS the
signal, and `timeTier = 'asserted'` reports it at verify — so no `droppedTimestamps`
field is needed. The operator's `onDrop`-style stderr surfacing (PR #65) is the place to
also log a TSA failure if the config wires the timestamper.

## 5. Standalone verifier: two honest modes (#6)

The verifier runs over the bundle JSON and reports per-check results. Two modes differ
only in whether the anchored root is re-fetched from the immutable source:

- **Offline (bundle-only).** Recompute chain + Merkle; compare to the root **embedded in
  the bundle**; check the signature against the provided public key; check handoff
  closure; check the TSA token (RFC 3161 tokens verify offline against the TSA cert).
  Proves integrity + provenance + (if present) trusted time. **Claim ceiling:
  `tamper-detecting`** — you are trusting the bundle's own embedded root.
- **Anchor-checked (online).** Additionally fetch the root from the real WORM anchor (via
  a read-only anchor in the verify-context) and `Buffer.compare` it to the recomputed
  root. **This is the check that licenses `tamper-evident`.**

The two modes are **parametrized by which anchor is passed**, not a flag or a forked code
path — `verify()` is unchanged in shape. Offline = a tiny read-only anchor that returns
the bundle's own embedded `auditLog.root` (so the recompute-vs-anchor compare is against
the embedded root, capping the claim at `tamper-detecting`). Anchor-checked = a read-only
anchor backed by the real WORM source (e.g. an S3-object-lock fetch). Both satisfy the
existing `AuditAnchor` interface, so no new verify branch is introduced (SoC preserved).

`VERIFICATION.md` (committed at repo root or `docs/`) documents: the `AuditBundle` and
verify-context formats; the exact step-by-step algorithm; the trust model and claim
ceiling of each mode; and how to obtain the TSA trust cert. The goal is that a third
party can reimplement the verifier from the document alone — the "trust the artifact,
not the vendor" promise made concrete.

## 6. Data-model changes (all additive, version-safe)

- `AnchorReceipt` / `AnchoredRoot`: optional `timestamp?: TimestampToken`.
- `VerificationReport.checks`: add `time: CheckResult`.
- `VerificationReport`: add `timeTier: 'asserted' | 'tsa-attested'`.
- The chain/canon byte layout (`canonEntry`) is **unchanged** → existing sealed bundles
  verify byte-identically. The Merkle root never covers the timestamp (the token is taken
  *over* the root), so adding a token cannot change any pre-existing root.
- `time` participates in the report for display/forensics; it does **not** gate `intact`
  in this version (an `asserted` seal can still be `intact` + `tamper-evident` on the
  tamper axis). This is deliberate: trusted-time is a separate assurance dimension.

## 7. Testing strategy (TDD throughout)

- **Golden / back-compat:** an existing exported bundle with no `timestamp` field still
  verifies, byte-identical root, `timeTier = 'asserted'`, `time.ok = 'n/a'`.
- **Timestamp round-trip:** `LocalCaTimestampAuthority` issues a token over a root;
  `verifyTimestamp` accepts it; `timeTier = 'tsa-attested'`.
- **Timestamp tamper:** a token whose messageImprint ≠ root, or signed by an untrusted
  cert, fails `time.ok` and the tier stays/falls to `asserted` honestly.
- **TSA outage:** a throwing `timestamp()` downgrades the seal to `asserted` (no token
  written — absence is self-evidencing); the run still seals and verifies on the tamper axis.
- **Mode separation:** offline mode caps the claim at `tamper-detecting` even on a clean
  external-immutable bundle; anchor-checked mode reaches `tamper-evident`.
- **Dependency-graph test:** `@quarry-systems/pangolin-verify` resolves and verifies a
  real exported bundle with **zero** imports from `pangolin-orchestrator` (enforced, so
  the "minimal artifact" guarantee cannot silently regress).
- **Extraction parity:** the moved core produces identical chain/Merkle/verify output to
  the pre-move orchestrator implementation (pinned by the existing audit suite, which
  rides along after re-pointing imports).

## 8. Sequencing within the build

0. **ASN.1/CMS library spike** — ratify the toolkit (§4.2) with a thin round-trip test (a
   token from a real public TSA *and* from the local-CA fake, both verified). Cheap,
   de-risks everything downstream, gates the seam's shape. Pins the dep in `pangolin-verify`.
1. Extract the pure core to `pangolin-core` (new `src/audit.ts` for types; verify/merkle/
   canon beside it); re-point orchestrator imports; keep the full existing audit suite
   green (no behavior change). *This is the load-bearing refactor; core gains no new deps.*
2. Add the `TimestampAuthority` type+interface to core and the optional injected
   `verifyTimestamp` param on `verify()` + the additive data-model fields; wire the
   optional `timestamper` into `AuditLog.sealEpoch`; extend the report (`time`, `timeTier`).
3. Stand up `@quarry-systems/pangolin-verify` (the impls, `verifyTimestamp`, the CLI `bin`)
   over the core; re-point `pangolin verify`; **write `VERIFICATION.md` first** so it drives
   the bundle/verify-context format rather than documenting it after the fact.
4. Offline demo proof: a bundle showing `tsa-attested` time via the local-CA fake, and an
   auditor re-verifying it with only the `pangolin-verify` package.

## 9. Risks & mitigations

- **RFC 3161 implementation surface.** Parsing/validating CMS SignedData is fiddly.
  *Resolved by design:* the ASN.1/CMS dependency is scoped to `pangolin-verify` (never
  `pangolin-core` — §3.1/§4.2), and the step-0 spike ratifies the library against a real
  TSA + the local-CA fake before the seam hardens. `verifyTimestamp` stays small and is
  injected into core's `verify()` exactly as `verifySignature` already is.
- **Extraction churn breaking importers.** Mitigated by re-export shims and running the
  full audit suite at step 1 before any feature work.
- **Trust-root distribution.** The auditor needs the TSA's CA cert to verify offline;
  `VERIFICATION.md` documents where to get it, and the verify-context may carry it.
- **Over-claiming time.** The tier is reported separately and never upgraded implicitly;
  the local-CA fake's cert is unmistakably a test root.

## 10. Acceptance

Per the spec's acceptance bar: an independent party, from the bundle alone (plus a
read-only anchor for the tamper-evident tier), can verify *what ran, that the record is
complete + unaltered, on whose provenance, and — when a TSA is configured — when, at a
time the operator cannot backdate.* Delivered when: the extracted core is the single
implementation; `@quarry-systems/pangolin-verify` verifies a real bundle with no
orchestrator dependency; the `tsa-attested` tier is demonstrable offline; and
`VERIFICATION.md` is sufficient to reimplement the verifier.
