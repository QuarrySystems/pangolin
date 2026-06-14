# Require a verified signature for the `tamper-evident` claim

> **Status:** design, approved 2026-06-13. Closes the same-second residual left by PR #69 with a
> surgical `verify()` change — the `tamper-evident` claim requires a present + verified signature.
> Supersedes [`2026-06-13-versionid-pinning-design.md`](./2026-06-13-versionid-pinning-design.md)
> (version-binding was over-built — see that doc's banner). Keeps #69's earliest-version read.

## 1. Why

PR #69 made `S3ObjectLockAnchor` read the **earliest** (original, COMPLIANCE-locked) S3 version,
defeating an attacker who re-PUTs a forged root as a *later* version. Residual: S3 `LastModified`
is second-granular, so a **same-second** forgery can tie for "earliest" and be selected.

Tracing that attack against the real `verify()` (`packages/pangolin-core/src/audit-verify.ts`)
shows the precise hole — and it is NOT "which version is read":

```
intact  = chainOk && anchorOk && rootOk !== false && sigOk !== false   // 'n/a' passes
claim   = claimFor(intact, guarantee)                                   // tamper-evident if intact && external-immutable
```

A same-second external forgery (attacker has bucket write, **no signing key**) PUTs `v2 = {forgedRoot,
NO signature}` and forges the bundle's entries to hash to `forgedRoot`. If the earliest-read ties and
selects `v2`: `chainOk` true (forger relinked), `rootOk` true (recomputed forged root == `v2`),
`anchorOk` true, **`sigOk = 'n/a'`** (no signature) → `'n/a' !== false` → `intact` true → **`claim =
tamper-evident` → forgery accepted.** The load-bearing defect is that a **missing signature is `'n/a'`,
and `'n/a'` does not block the `tamper-evident` claim.**

## 2. Threat model (the bar) and why require-sig clears it

| Adversary | Attack | Defense |
|---|---|---|
| External, bucket write, **no key** | re-PUT forged root as a **later** version | earliest-read (#69) — ignores later versions |
| External, bucket write, **no key** | re-PUT forged root **same second** as seal | **require-sig (this spec)** — forgery has no valid signature → claim collapses |
| Malicious/compromised **operator** (holds key) | forge root, PUT new version, present a fresh bundle | earliest-read (#69) — verifier reads the original; recomputed forged root ≠ original → `root-mismatch` |

A same-second forgery cannot carry a valid signature without the key. Gating `tamper-evident` on a
**verified** signature therefore rejects it fail-safe: the claim drops to `tamper-detecting` (and, when
the bundle supplies an honest signature checked against the read forged root, `sigOk === false` →
`failure: 'signature'`). No operator-supplied value steers verification; no new trusted artifact.

**VersionId-binding was considered and rejected** (see the superseded doc): a stripped-signature
forgery still hits the `sigOk === 'n/a'` path, so version-binding ALSO needs this require-sig rule to
work — and adds a seal re-order + relocating the signature out of the WORM object for no extra realistic
coverage.

## 3. Design — one claim-gate change

`claimFor` (the single source of the claim rule, `packages/pangolin-core/src/audit-verify.ts`) gains
the signature-check result and requires it to be `true` for `tamper-evident`:

```ts
export function claimFor(
  intact: boolean,
  guarantee: Guarantee,
  sigOk: boolean | 'n/a',
): 'tamper-evident' | 'tamper-detecting' {
  return intact
    && GUARANTEE_RANK[guarantee] >= GUARANTEE_RANK['external-immutable']
    && sigOk === true
    ? 'tamper-evident'
    : 'tamper-detecting';
}
```

Both (and only) call sites pass the signature result:
- `verify()` (`audit-verify.ts:93`): `claimFor(intact, g, sigOk)` — `sigOk` is already in scope.
- `verifyBundle()` (`audit-verify-bundle.ts:22`): `claimFor(intact, base.guarantee, base.checks.signature.ok)`.

**`intact` is unchanged** — it remains the structural-integrity signal (chain + root + anchor). The new
requirement lives on the **claim**, not on `intact`, so the report still distinguishes "structurally
self-consistent" from "earns the top claim." An `external-immutable` run that is genuinely unsigned (e.g.
`NoneSigner`) or whose signature cannot be verified (no `verifySignature` injected) now correctly reports
`tamper-detecting` — it has the WORM anchor but no verified authorship.

## 4. What stays the same (YAGNI / no regression surface)

- **#69 earliest-version read** — kept verbatim (the operator + later-second defense).
- **Seal flow** — unchanged (sign-then-anchor; signature stays in the S3 object).
- **`S3LockClient` / `AwsS3LockClient` / `AnchorReceipt` / `S3ObjectLockAnchor` / `pangolin-verify`
  `buildAnchor`** — unchanged. No interface, storage, or seal-ordering changes.
- **Detect tier (`LocalAnchor`)** — already `tamper-detecting`; the new `sigOk` gate only tightens the
  `external-immutable` path, so detect is unaffected by construction.
- **Trusted-time / `timeTier`** — orthogonal, untouched.

## 5. Documented residual

Malicious-operator **same-second self-race**: an operator holding the key races a forgery into the
**same second** as their own honest seal; the tie may select the forged version and the operator validly
signs it (`sigOk` true) → `tamper-evident`. Contrived (the operator races their own seal) and unfixable
by any approach short of sub-second WORM ordering S3 does not expose. Out of scope; recorded here.

## 6. TDD (genuine red-green — new behavior)

All in `packages/pangolin-orchestrator/test/audit/` (verify is re-exported there; existing `claimFor`
and forge helpers live here).

1. **Same-second forgery → claim collapses (the closer, RED first).** Reuse the immutable-fake +
   chain-consistent-forge machinery from `tamper-evident-contrast.test.ts`, but with a **versioned**
   fake S3 whose forged version has `LastModified ≤` the original and **no signature**, so the
   earliest-read selects the forgery. Assert `report.claim === 'tamper-detecting'` (NOT
   `tamper-evident`). **On current code this FAILS** (returns `tamper-evident` — the hole); passes after
   the `claimFor` gate. This is the red-green proof.
2. **Unsigned external-immutable downgrades.** A clean `S3ObjectLockAnchor` run with **no**
   `verifySignature` injected (or an unsigned seal) → `report.claim === 'tamper-detecting'`,
   `report.intact === true`. Documents the (correct) behavior change.
3. **Clean signed run still tamper-evident (regression guard).** A clean signed `S3ObjectLockAnchor` run
   with a valid `verifySignature` → `report.claim === 'tamper-evident'` (unchanged — green before & after).
4. **`claimFor` unit table** (update `verify.test.ts:214-224` to the 3-arg signature):
   `claimFor(true,'external-immutable',true) === 'tamper-evident'`;
   `claimFor(true,'external-immutable','n/a') === 'tamper-detecting'`;
   `claimFor(true,'external-immutable',false) === 'tamper-detecting'`;
   `claimFor(false,'external-immutable',true) === 'tamper-detecting'`;
   `claimFor(true,'detect',true) === 'tamper-detecting'`.
5. **Detect tier unaffected.** `LocalAnchor` clean run still `intact: true`, `tamper-detecting`.

## 7. Blast-radius check (must run before claiming done)

Adding a required 3rd parameter to `claimFor` is a compile-time fence: `pnpm -r typecheck` (the CI gate)
flags every caller, and the only two are the ones above. Audit the **assertions** of every test that
expects `tamper-evident` (`acceptance.int.test.ts`, `demo-claims-appeals-minio`, the root e2e,
`cmd-verify`): each must seal **signed** AND inject `verifySignature` to still earn the claim. Any test
that asserted `tamper-evident` without a verified signature was asserting the very hole this closes and
must be updated to seal+verify (not loosened). Run the full `pnpm -r typecheck` + `pnpm -r test` before
done (the PR #66 lesson: example/consumer literals are only caught workspace-wide).

## 8. Scope

**In:** the `claimFor` signature + gate; both call-site updates; the red-green + downgrade + guard +
unit-table tests; auditing existing `tamper-evident` assertions to seal+verify. **Out:** version-binding,
seal re-order, any S3/anchor/interface change, KMS custody (#5), authz-in-evidence (#2). Pre-v1 → no
compatibility shims.
