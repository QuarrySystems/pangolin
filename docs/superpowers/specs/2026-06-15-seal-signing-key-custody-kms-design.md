# Seal signing-key custody: production KMS/HSM signer — design

- **Status:** draft (awaiting human review; KMS algorithm choice + trust-root distribution APPROVED in brainstorming 2026-06-15)
- **Date:** 2026-06-15
- **Refines (does not re-decide):** `wikis/agora/decisions/decision-2026-06-15-seal-signing-key-custody-demo-local.md`
- **Related decisions:** `decision-2026-06-04-seal-must-meet-soc2-hipaa-eu-ai-act-iso` (gap #5), `decision-2026-06-09-evidence-assurance-is-two-dimensional`
- **Builds on (merged):** #66 (standalone `pangolin-verify` + trusted-time seam), #69 (earliest-version WORM read), #70 (verified signature REQUIRED for the tamper-evident claim)

---

## 1. Problem

PR #70 (`12a4c4d`) made a **verified signature REQUIRED** for the `tamper-evident` claim: `claimFor(intact, guarantee, sigOk)` (`packages/pangolin-core/src/audit-verify.ts`) only returns `tamper-evident` when `sigOk === true`. The strongest tier of the seal — the moat — now rests on the signing key.

But the only real signer is `createLocalSigner` (`packages/pangolin-orchestrator/src/audit/signer.ts:7`), which calls `generateKeyPairSync('ed25519')` — a **fresh ephemeral keypair per process**: no persistence, no rotation, no published trust-root public key. That was deferred compliance gap #5; #70 made it load-bearing rather than theoretical.

This spec designs the **production** custody story. It is **additive** — demo/dev keeps `createLocalSigner` + `NoneSigner` unchanged, and the existing Ed25519 verify path is untouched. It is **not** a build commitment: per the recorded decision, build is demand-pulled by the first compliance design partner. This spec + its plan exist so the design is settled and audited ahead of that pull.

The seal's cryptographic core (hash-chain, Merkle root, WORM anchor, required-sig claim rule) is **out of scope and not re-audited** — it is solid per #65/#66/#69/#70. This spec touches only the **key-custody edge**.

### 1.1 What KMS custody does and does NOT buy (honesty bound)

Stated plainly so the spec does not overclaim, consistent with the two-dimensional assurance framing (`decision-2026-06-09-evidence-assurance-is-two-dimensional`):

- **Buys:** the private key is never exfiltrable (never leaves the KMS/HSM boundary); signing is IAM-access-controlled and CloudTrail-logged; rotation happens without redistributing private material; revocation is centralized in a published trust root.
- **Does NOT buy:** it does not stop a *currently-authorized* operator from asking KMS to sign a forged root. That is true of any signer and is **not** what the signature defends. Tamper-evidence rests on the WORM anchor + hash-chain (#69/#70); the signature proves *"a holder of keyRef X signed this exact root"* — binding identity / non-repudiation and enabling revocation, not preventing authorized misuse. Externally-shown bundles must continue to state the key tier alongside the tamper tier.

---

## 2. Decisions resolved in brainstorming (2026-06-15)

| # | Fork | Resolution | Why |
|---|------|------------|-----|
| 1 | **Signing algorithm.** The seal signs Ed25519 today; does the production KMS path keep it or add ECDSA? | **Add an `ecdsa-p256` path** (KMS `ECC_NIST_P256` / `ECDSA_SHA_256`). Keep `ed25519` for local/dev. | Lowest common denominator across AWS KMS **and** virtually every PKCS#11 HSM (P-256 is universal; Ed25519 on HSMs is not), FIPS 186-4 GA in all regions, verifiable with node's built-in crypto (no new dependency). Genuinely exercises the pluggable `alg` seam. |
| 2 | Seam placement | New **leaf** package `pangolin-signer-aws-kms` holding the only `@aws-sdk/client-kms` dependency, implementing the existing `Signer` interface. | Mirrors `pangolin-storage-s3` / `pangolin-providers-aws-creds`; keeps `pangolin-core` zero-cloud-SDK. |
| 3 | Trust root | A **published, out-of-band key manifest** mapping `keyRef → pubkey`, never bundle-supplied. | A bundle-supplied key is self-attesting/forgeable — same class as the version-pin regression rejected in #70. |
| 4 | Rotation/revocation | Keyed on the existing `Signature.keyRef`; revocation **time-bounded by the existing trusted-time tier**. | `keyRef` already rides every signature; trusted time is the only non-operator-controllable source of "when it was signed". |
| 5 | Spec scope | **Full production design** — all four sections specified; plan sequences them but leaves them unbuilt pending a partner pull. | Settle + audit the design ahead of the demand pull. |

### 2.1 Premise correction (load-bearing)

The recorded decision and the original brief state that **AWS KMS asymmetric does not support Ed25519**. Verified against current AWS KMS docs (2026-06-15, `https://docs.aws.amazon.com/kms/latest/developerguide/asymmetric-key-specs.html`): **that is no longer true** — AWS KMS now offers key spec `ECC_NIST_EDWARDS25519` with signing algorithm `ED25519_SHA_512` (`MessageType: RAW`). So "must add ECDSA because KMS can't do Ed25519" is **not** the forcing function. The choice of ECDSA-P256 stands on its own merits (decision #1 above: portability across KMS + HSM, FIPS GA, pluggable-seam proof), **not** on a false KMS limitation. This correction must propagate to the decision page on promotion.

---

## 3. Current-state grounding (verified against code)

| Fact | Location |
|------|----------|
| `Signature` is single-sourced; `alg` is already typed `string` (pluggable, no type change to add an algorithm). | `packages/pangolin-core/src/audit.ts:64` — `interface Signature { alg: string; bytes: Uint8Array; keyRef?: string; }` |
| Orchestrator merely **re-exports** the core `Signature`/`Signer` — there is one type, not two. The only sibling is `ManifestSignature` (base64 wire shape) at `audit.ts:19`. | `packages/pangolin-orchestrator/src/contracts/audit.ts:7,10` |
| `Signer` interface the production signer must implement. | `packages/pangolin-core/src/audit.ts:95` — `interface Signer { sign(rootHash: Uint8Array): Promise<Signature>; readonly keyRef?: string; }` |
| Local signer + `verifyEd25519` (the latter imported directly by ~8 examples/e2e tests — must stay back-compat). | `packages/pangolin-orchestrator/src/audit/signer.ts:7,19` |
| **Core's `verify`/`verifyBundle` are already algorithm-agnostic** — they consume an injected `verifySignature(root, sig) => boolean` callback. The alg dispatch lives only in the callback constructors. | `packages/pangolin-core/src/audit-verify-bundle.ts:8`, `audit-verify.ts` |
| Standalone verifier: trust root is a **single** `signerPublicKeySpkiDer` (base64 SPKI-DER), loaded out-of-band from the verify-context JSON; the ed25519 check is inline `verify(null,…)`; `sig.keyRef` is **ignored**. | `packages/pangolin-verify/src/verify-context.ts:38,76,182` |
| Anchored-root wire record carries `signature.{alg,bytesHex,keyRef}` (hex) — DER bytes round-trip fine. | `packages/pangolin-verify/src/verify-context.ts:139,148` |
| `VerificationReport` (additions must be **optional** to avoid breaking example/consumer literals — see §8 blast radius). | `packages/pangolin-core/src/audit.ts:121` |
| Trusted-time tier already exists (`timeTier`, `TimestampToken`, injected `verifyTimestamp`) — the source for revocation time-bounding. | `packages/pangolin-core/src/audit.ts:72,91,128`; `verify-context.ts:193` |

---

## 4. §1 — ECDSA-P256 algorithm path

### 4.1 Signing (KMS)

KMS `Sign` request: `{ KeyId: <keyRef-resolved-arn>, Message: <32-byte root>, MessageType: 'RAW', SigningAlgorithm: 'ECDSA_SHA_256' }`. With `MessageType: RAW`, KMS computes `SHA-256(root)` then ECDSA-signs it; the 32-byte root is far under the 4096-byte RAW limit. KMS returns a **DER-encoded** ECDSA signature. The adapter returns `Signature { alg: 'ecdsa-p256', bytes: <DER>, keyRef }`.

> Rationale for `RAW` over `DIGEST`: the verifier (node `verify('sha256', root, …)`) hashes the root with SHA-256 itself. `RAW` makes KMS hash identically; `DIGEST` would treat the root *as* the digest and node would double-hash → mismatch.

> **VERIFY-AT-BUILD (assumption, not code-grounded):** `@aws-sdk/client-kms` is not installed in the workspace today. The KMS command/field names above (`SignCommand`/`GetPublicKeyCommand`, `KeyId`/`Message`/`MessageType`/`SigningAlgorithm`, the `Signature`/`PublicKey` outputs) and the `MessageType:'RAW'` ⇒ hash-then-sign semantics are from AWS SDK/KMS docs, to be confirmed against the installed SDK at build time with one real `Sign`+verify round-trip. The node-crypto ECDSA round-trip in §4.2/§4.3 IS empirically verified; only the KMS-specific surface is the assumption.

### 4.2 Verifying (pure node crypto, no new dependency)

`crypto.verify('sha256', root, spkiKeyObject, derSig)` — node computes `SHA-256(root)`, ECDSA-verifies against the SPKI-DER P-256 public key; node's default `dsaEncoding: 'der'` matches KMS's DER output.

Add **`verifyEcdsaP256(root, sig, spkiDer): boolean`** beside `verifyEd25519` in `packages/pangolin-orchestrator/src/audit/signer.ts` (mirror its shape: guard `sig.alg !== 'ecdsa-p256'` → false; `createPublicKey({format:'der',type:'spki'})`; `verify('sha256', …)`; try/catch → false). **`verifyEd25519` is left untouched** (back-compat for its direct importers).

In the standalone verifier, the alg dispatch is written in **exactly one** module-private primitive `verifySignatureBytes(alg, root, key, sigBytes)` (`ed25519 → verify(null,…)` | `ecdsa-p256 → verify('sha256',…)` | unknown → false). Both `makeVerifySignature` (single-key) and `makeVerifySignatureFromTrustRoot` (§6) route through it — no duplicated `if/else` (DRY). This is one primitive *within* `pangolin-verify`: the orchestrator's `verifyEd25519`/`verifyEcdsaP256` stay separate because `pangolin-verify` cannot import `pangolin-orchestrator` (guard test `no-orchestrator-dep.test.ts`) and `pangolin-core` deliberately owns no signature crypto (verification is callback-injected). Cross-package duplication of the raw verify is the existing, accepted repo pattern (the ed25519 verify already lives in both places today).

### 4.3 Local ECDSA signer (test/dev parity)

Add **`createLocalEcdsaSigner(keyRef?)`** beside `createLocalSigner` — `generateKeyPairSync('ec', { namedCurve: 'P-256' })`, `sign('sha256', root, privateKey)` → DER, exported `publicKey` SPKI-DER. Not a production signer; it exists so the `ecdsa-p256` verify path is testable hermetically and so the KMS adapter's output format can be validated against a node-local equivalent (both emit DER ECDSA over `SHA-256(root)`).

### 4.4 Conformance vector

Add a `sign-ecdsa-p256.json` vector beside the existing `sign-ed25519.json` (`packages/pangolin-orchestrator/test/conformance/audit-vectors/`) — fixed P-256 key, fixed root, expected verify outcome — pinning cross-version byte-compatibility of the new path.

---

## 5. §2 — KMS signer leaf package

`packages/pangolin-signer-aws-kms/` — copy `pangolin-providers-aws-creds` verbatim as the template.

> **Canonical leaf shape (grounded across all leaf packages):** CommonJS output compiled by `tsc` under `module: NodeNext` — **do NOT set `"type": "module"`** (no AWS-SDK leaf does; only `pangolin-verify` is ESM, and it has no AWS dep). No `exports` field — flat `main`/`types`. `tsconfig.json` = `extends ../../tsconfig.base.json` + `outDir/rootDir`. Pin `@aws-sdk/client-kms: ^3.700.0` to match the `^3.700.0` floor the other `@aws-sdk/client-*` packages use.

> **Naming (resolved 2026-06-15).** Named `pangolin-signer-aws-kms` to follow the repo's prefix=seam convention: `providers-*` denotes the `ComputeProvider`/`CredentialProvider` seam (fargate, local-docker, aws-creds), `storage-*` = `StorageProvider`, `runtime-*` = `RuntimeAdapter`. A `Signer`-seam adapter therefore gets a new `signer-*` family — leaving room for `pangolin-signer-pkcs11-hsm` / `pangolin-signer-gcp-kms`. (An earlier draft proposed `providers-aws-kms-signer`; rejected because it would overload `providers-*` with a third unrelated seam. Confirm consistency with ADR-0001 (package scope) when the package is created.)

- **Sole owner** of `@aws-sdk/client-kms`. `pangolin-core` and `pangolin-verify` gain **no** new dependency.
- Exports `createKmsSigner(opts: { keyId: string; keyRef: string; region?: string; client?: KMSClient }): Signer` returning `{ keyRef, async sign(root) { /* KMS Sign → DER */ return { alg:'ecdsa-p256', bytes, keyRef }; } }`.
  - `keyId` = the KMS key ARN/alias used for the `Sign` call; `keyRef` = the **stable public identifier** sealed into the signature and resolved against the trust root (§6). They are intentionally distinct: `keyId` is an AWS-internal locator, `keyRef` is the audit-facing name (e.g. `pangolin-prod-2026`). A test injects a fake `client`.
- Exports a `publishablePublicKey(client, keyId): Promise<{ keyRef; alg; spkiDer }>` helper that calls KMS `GetPublicKey` (returns SPKI-DER) to produce a trust-root manifest entry (§6) — so operators generate the published key material from KMS directly, never by hand.
- The orchestrator injects this signer exactly as it injects `createLocalSigner` today (no orchestrator/core architecture change). Wiring example for `deploy/serve-stack` is documented, not built.

**Existing consumers the plan must account for** (all back-compat-safe; named so nothing is missed):
- `deploy/serve-stack/client/pangolin.config.mjs` hard-wires `verifyEd25519` against a fetched `public-key.json`. Ed25519 bundles keep verifying; `verifyEd25519` returns `false` for `ecdsa-p256` via its alg guard. This is the realistic place a *production* deployment wires the ecdsa branch + trust-root map — the documented (not built) wiring target.
- `packages/pangolin-cli/src/cmd-verify.ts` is alg-agnostic: it threads whatever `verifySignature` the config supplies into `verifyBundle`. Acceptance #1's "CLI verify green via ecdsa-p256" holds **iff** the config's `verifySignature` dispatches to the new path — correct by construction, dependency made explicit here.
- `packages/pangolin-verify/src/cli.ts` builds its callback via `makeVerifySignature(ctx)`, so the §4.2 alg branch reaches the standalone CLI automatically.
- `packages/pangolin-mcp` has **no** signer/verify wiring (verified) — not a missed consumer.

Interface-only forward-compat: because the package implements the core `Signer` shape, a future `pangolin-signer-pkcs11-hsm` (P-256, also `alg:'ecdsa-p256'`) or `pangolin-signer-gcp-kms` is a sibling in the same `signer-*` family with **zero** verifier changes.

---

## 6. §3 — Published trust root (keyRef → pubkey)

### 6.0 What "publishing the trust root" actually means (and what it is NOT)

The trust root is a **static, public, read-only file** — not a service, not infrastructure operated at runtime, and **not** the WORM anchor. Two distinct "roots" defend two distinct things and must not be conflated:

| | **WORM anchor** (exists today) | **Trust root** (this spec) |
|---|---|---|
| What it is | S3 Object-Lock store holding the Merkle **root hash** | A published file holding the signing **public key(s)** |
| Proves | The ledger wasn't altered after sealing (tamper-evidence) | *Which key* signed it — key authenticity / non-repudiation |
| Contains | A hash | Public key(s) + `keyRef` + lifecycle status. **No secrets.** |
| Runtime role | Written to at seal time (a live bucket) | **None** — published once per key; read only by the verifier |

So the operator's runtime stays simple: KMS holds the private key and signs (§5); the matching **public** key is published once. "Hosting" is therefore as light as the deployment wants, because the artifact is public and immutable-in-practice:

- a file on the docs site (`quarrysystems.github.io/...`),
- a raw file at a known path in the repo (pinned by git tag/commit),
- a static object in S3/CDN,
- or handed/emailed directly to the auditor.

The **only** load-bearing property is the *channel*, not the host: the auditor must obtain the file through a channel they already trust (TLS docs site, signed git tag, direct handoff) and **never** read the key from the audit bundle. A bundle-supplied key is self-attesting — a forger would simply ship their own key plus a matching signature — which is the same forgery class rejected in #70. Out-of-band publication is exactly what breaks that. Rotation = add an entry to the file; revocation = flip an entry's `status` to `revoked` (§7).

### 6.1 Manifest format

A JSON document published out-of-band (vendor docs site over TLS, and/or a signed file committed to a known repo path) — **never** read from the bundle. All timestamps are **strict ISO-8601 with an explicit `Z`/offset** (so `Date.parse` is unambiguous, not local-TZ):

```json
{
  "schemaVersion": 1,
  "keys": {
    "pangolin-prod-2026": {
      "alg": "ecdsa-p256",
      "spkiDer": "<base64 SPKI-DER from KMS GetPublicKey>",
      "status": "active",
      "notBefore": "2026-07-01T00:00:00Z",
      "notAfter": null,
      "revokedAt": null
    }
  }
}
```

A trust-root read from disk/network is parsed by a strict `parseTrustRoot(json)` validator that **fails closed** on anything malformed — bad JSON, unknown `schemaVersion`, non-enum `alg`, missing `spkiDer`, a `revoked` entry without `revokedAt`, or a non-strict timestamp. The manifest is the security root, so an invalid manifest must error, never silently degrade. The `notBefore`/`notAfter`/`revokedAt` fields are **enforced** (§7.2), not decorative.

### 6.2 Resolution + verify-context integration

`VerifyContextJson` (`verify-context.ts:38`) gains an **optional** `trustRoot` field. Rather than collapse the existing single-key path into a synthetic one-entry map, the design keeps **two callbacks and lets the caller select** (simpler, lower-risk, and leaves every current single-key caller byte-for-byte unchanged):

- `makeVerifySignature(ctx)` — the existing single-key path, now alg-dispatching via the shared `verifySignatureBytes` primitive. Returns `undefined` when no key is configured (core records `'n/a'`, exactly as today).
- `makeVerifySignatureFromTrustRoot(trustRoot, verifiedGenTime?)` — the new map path. Resolves the entry for `sig.keyRef`; **unknown/absent keyRef → hard fail** (not `'n/a'` — an unrecognized signer fails); `alg` must equal the entry's `alg`; the key-lifecycle gate (§7.2) is applied; then the shared crypto primitive verifies against `entry.spkiDer`. Returns `undefined` only when no trust root is configured.

The verify wiring selects `makeVerifySignatureFromTrustRoot` when `ctx.trustRoot` is set, else `makeVerifySignature`. The callback is a thin **composition** of three separately-tested pure helpers — `resolveKey` (lookup), `keyUsableAt` (lifecycle policy), `verifySignatureBytes` (crypto) — so no single function owns multiple concerns (SRP).

### 6.3 Manifest trust (defense-in-depth)

MVP trust = the auditor obtains the manifest over an authenticated channel (TLS docs site / pinned committed file) and runs it through `parseTrustRoot` — the same trust model as today's single-key context, generalized to a validated map. Optional hardening: a detached signature over the manifest by a long-lived **offline** root key whose SHA-256 fingerprint is pinned in published docs; the verifier checks it before trusting any entry. Specified as optional because it adds an offline-root-key custody problem of its own; recommended once a partner requires it.

---

## 7. §4 — Rotation + revocation

### 7.1 Rotation

- Cadence: routine annual rotation + immediate emergency rotation on suspected compromise.
- Mechanism: provision a new KMS key, publish its `keyRef → pubkey` entry (`status: active`, `notBefore` = cutover), point the injected signer at the new `keyId`/`keyRef`. New seals carry the new `keyRef`; **old keyRefs remain `active` (or `notAfter`-bounded) and verifiable** for already-sealed bundles indefinitely (audit retention). Old private key material is scheduled for KMS deletion only after no further signing is needed — verification never needs the private key.

### 7.2 Key lifecycle: validity window + time-bounded revocation

The `notBefore`/`notAfter`/`revokedAt` fields are enforced by **one** pure lifecycle function `keyUsableAt(entry, verifiedGenTime)` (single responsibility), so they are real controls, not dead fields:

- **`revoked`:** usable **only** when a `tsa-attested` verified `genTime` proves the root was signed **strictly before** `revokedAt`; a missing verified genTime (asserted-only time) is **hard-fail**. The "hard-fail" case is just the absence of trusted proof-of-signing-time — one unified rule, not two.
- **`active`:** usable; and **when a verified genTime exists** it must fall within `[notBefore, notAfter]`. When no verified (tsa-attested) genTime exists, the window is advisory — revocation remains the hard control — so the no-TSA path for active keys behaves exactly as today.

Self-asserted chain time (`timeTier: 'asserted'`) is operator-controllable and **never** satisfies any of these time conditions. A key that fails the gate surfaces as `failure: 'signature'` and collapses the claim to `tamper-detecting` — consistent with #70.

### 7.3 Where the lifecycle decision runs (and its hard prerequisite)

The boolean `verifySignature(root, sig)` callback does not itself see the timestamp, so the verified `genTime` is computed **once at the bundle-wiring level** (via `verifyTimestampWithTime` over the bundle's anchored-root token) and **injected** into the trust-root signature callback. The callback then *composes* three pure helpers — `resolveKey` → `keyUsableAt(entry, verifiedGenTime)` → `verifySignatureBytes` — and owns none of their internals; the lifecycle policy lives in `keyUsableAt` (in `revocation.ts`), the crypto in `verifySignatureBytes`. So "obtain genTime at the bundle level, decide with a pure policy function" is honored without a god-callback. A failed `keyUsableAt` sets `checks.signature` false → `failure: 'signature'`.

**HARD PREREQUISITE (audit finding, 2026-06-15).** The verified authoritative `genTime` is currently surfaced **nowhere**. `verifyTimestamp` (`packages/pangolin-verify/src/timestamp-authority.ts`) parses `genTime` internally for its cert-window check and then **returns a plain `boolean`** — `genTime` is discarded. The only bundle-level time value is `token.at`, which `audit.ts:69-75` explicitly marks **display-only / sealer-asserted / non-authoritative**. So `genTime < revokedAt` is **not evaluable with the current seam** at any layer. The §7.2 rule and acceptance #4's positive case (a revoked key that still verifies a pre-revocation bundle) are therefore **unbuildable until a new capability lands**:

> **Prerequisite task (sequenced before the revocation task):** widen the trusted-time seam to surface the parsed, verified authoritative `genTime` out of the timestamp verifier (e.g. `verifyTimestamp` returns `{ ok: boolean; genTime?: Date }`, or a sibling `extractVerifiedGenTime`), threaded to the `verifyBundle` level. This is an additive change to the time seam introduced in #66; it must not alter the existing `timeTier` semantics (a failed/absent time check still forces `asserted` and never gates `intact`).

Until that prerequisite is built, revocation degrades to **hard-fail** (any bundle under a revoked keyRef fails) — the documented default-safe behavior, but note it means the *soft* (time-bounded) revocation in §7.2 cannot ship in the same increment as the genTime work is skipped. The plan sequences genTime-surfacing → soft revocation accordingly.

---

## 8. Blast radius + verification gate

Mostly additive → minimal stale-test risk:

- **New** package, **new** `verifyEcdsaP256`, **new** `createLocalEcdsaSigner`, **new** conformance vector, **additive** optional `trustRoot` on the verify-context → no existing literals break.
- **`verifyEd25519` and the inline ed25519 path are left unchanged** → the ~8 example/e2e importers keep working.
- **One ripple risk:** any new field on `VerificationReport` (`audit.ts:121`) breaks full `VerificationReport` literals in example/consumer tests (the lesson from #66's `time`/`timeTier` and #71's e2e assertion). Mitigation: any report addition (e.g. an informational `signerKeyRef`) is **optional** so existing literals still satisfy the type. Prefer **not** adding to `VerificationReport` at all in the first build.
- **Policy-tightening edge:** turning on the trust-root map changes the `'n/a'`-vs-fail outcome for unknown keyRefs. Any test asserting old signature outcomes under a configured trust root must be updated by making the fixture legitimately satisfy the rule (publish the test key in the test manifest), **never** by loosening the assertion.

**Full local gate (required, per repeated CI lessons):** `pnpm -r typecheck` **and** `pnpm -r test` **and** `pnpm test:e2e` (root e2e is a SEPARATE CI job not included in `pnpm -r test`) **and** per-package `pnpm -r lint`. In a fresh worktree at build time: `pnpm install && pnpm -r build` before trusting any cross-package/missing-export failure (stale-dist).

---

## 9. Out of scope

- Building/deploying the production signer (demand-pulled by a compliance design partner).
- Re-auditing the seal crypto core (hash-chain/Merkle/WORM/required-sig) — solid per #65/#66/#69/#70.
- The same-second WORM version-pin residual (`finding-tamper-evident-version-pin`) — separate deferred work; orthogonal to key custody.
- GCP KMS / Azure Key Vault / PKCS#11 HSM adapters — forward-compatible by construction (sibling packages, same `alg:'ecdsa-p256'`), but not specified here.
- Ed25519-via-KMS (`ECC_NIST_EDWARDS25519`) — viable per §2.1 but not chosen; recorded so the option is not lost.

---

## 10. Acceptance (what "designed + provable" means)

1. A bundle signed by `createLocalEcdsaSigner` verifies green via the new `ecdsa-p256` path (orchestrator verify, standalone `pangolin-verify`, and CLI) — and a tampered root fails it.
2. The `ecdsa-p256` conformance vector pins byte-compatibility.
3. A trust-root manifest with a known `keyRef` verifies; an unknown `keyRef` under a configured trust root **fails** (not `'n/a'`); no trust root → `'n/a'` exactly as today.
4. `parseTrustRoot` **fails closed** on a malformed manifest (bad JSON, unknown `schemaVersion`, non-enum `alg`, revoked-without-`revokedAt`, non-strict-ISO timestamp).
5. `keyUsableAt` enforces the validity window when a verified genTime exists: an `active` key used outside `[notBefore, notAfter]` fails; within it passes (so the window fields are live, not decorative).
6. A `revoked` keyRef fails a bundle whose only time evidence is `asserted`. The same keyRef verifies a bundle carrying a `tsa-attested` token with `genTime < revokedAt` — **this positive case depends on the §7.3 genTime-surfacing prerequisite** and is gated behind it; before that prerequisite ships, revocation is hard-fail (the negative case still holds).
7. The alg dispatch is written **once** (`verifySignatureBytes`); the verify callback is a composition of `resolveKey` + `keyUsableAt` + `verifySignatureBytes`.
8. The existing Ed25519 demo/dev path, all example importers, and the full gate (`typecheck` + `test` + `test:e2e` + `lint`) stay green.
9. The KMS adapter's `@aws-sdk/client-kms` dependency lives **only** in `pangolin-signer-aws-kms`; `pangolin-core` and `pangolin-verify` gain no new dependency.
