# VersionId-binding: bind the sealed S3 version into the signature (layered with earliest-read)

> **STATUS: SUPERSEDED 2026-06-13** by
> [`2026-06-13-require-signature-tamper-evident-design.md`](./2026-06-13-require-signature-tamper-evident-design.md).
> Retained as the rejected-alternative record. Tracing the same-second attack against the actual
> `verify()` logic showed the *load-bearing* fix is far smaller: the `tamper-evident` claim must
> require a **verified signature** (a same-second forgery carries no valid signature → the claim
> collapses, fail-safe). VersionId-binding ALSO needs that require-sig rule to close the hole (a
> stripped-signature forgery still hits the `sigOk === 'n/a'` path), and adds a seal re-order +
> moving the signature out of the WORM object for **no additional realistic coverage** — overkill.
> The earliest-version read (this doc's correct insight) is kept by the superseding design.
>
> **Original status:** design, approved-in-principle 2026-06-13, **revised after security audit**. Closes
> the same-second residual left by PR #69 **without regressing** the malicious-operator defense
> that #69's independent earliest-version read provides.
>
> **Audit-driven course-correction:** an earlier draft of this spec proposed *replacing* the
> earliest-version read with "pin to the versionId supplied in the bundle." The spec audit
> proved that is a **regression-that-looks-like-an-improvement**: a malicious/compromised operator
> (holding the signing key) could forge a root, PUT it as a new version, validly sign
> `(forgedRoot ‖ forgedVersionId)`, and a verifier trusting the bundle's versionId would read and
> accept the forgery. The independent earliest-read defeats that; we must **keep it**. This spec
> is the corrected, **layered** design.

## 1. Why

PR #69 made `S3ObjectLockAnchor` read the **earliest** (original, COMPLIANCE-locked) S3 version,
defeating an attacker who re-PUTs a forged root as a *later* version. Residual: S3 `LastModified`
is second-granular, so a **same-second** forgery could tie for "earliest" and be selected. Closing
that residual is the goal here — but the fix must not weaken the independent-anchor property.

## 2. Threat model (the bar the design must clear)

| Adversary | Attack | Must |
|---|---|---|
| External attacker, bucket write, **no key** | re-PUT forged root as a **later** version | reject |
| External attacker, bucket write, **no key** | re-PUT forged root **same second** as seal | reject |
| Malicious/compromised **operator** (holds key) | forge root, PUT new version, validly sign it, present a fresh bundle | reject |

The owned GTM position is *"the auditor verifies independently — trust the artifact, not the
vendor."* So trust must reduce to **(published signer key + WORM bucket)** with **no new trusted
artifact** and **no reliance on an operator-supplied value** for what the verifier reads.

## 3. Design — layered: earliest-read (independent anchor) + signed version-binding (backstop)

Two independent mechanisms, neither sufficient alone:

1. **Independent earliest-version read (kept from #69).** The verifier ALWAYS reads the earliest
   S3 version of `audit/roots/<epochId>.json`. The original is COMPLIANCE-locked (undeletable) and
   no version can be created before it server-side, so the earliest **surviving** version is the
   original — regardless of what any bundle claims. This is the defense against a malicious operator
   and any later-second forgery; the verifier never trusts a bundle/operator-supplied versionId for
   *which* version to read.
2. **Signed version-binding (new — the same-second backstop).** The seal signs over
   **`root ‖ versionId`**, where `versionId` is the S3 VersionId of the object it just wrote. The
   verifier reads the earliest version, takes **that object's** root and VersionId **from S3**, and
   verifies the bundle's signature over `(root ‖ versionId)` with the published key. A same-second
   external forgery that ties for "earliest" carries a root/versionId the attacker could not sign
   (no key) → signature fails → **fail-safe reject** (never a false accept).

**The versionId used for the signature check always comes from S3, never from the bundle.** The
bundle carries only the *signature* (verified against the out-of-band pubkey — a forged signature
fails). Nothing the operator supplies steers the read.

### 3.1 Seal flow — anchor, then sign
`AuditLog.sealEpoch` re-orders to **anchor → sign**:
1. `anchor.anchor({ epochId, root })` writes the root to S3 (COMPLIANCE) and returns an
   `AnchorReceipt` carrying the just-written object's **`versionId`** (from `putObject`'s response).
2. Sign over **`signedPayload(root, versionId)`** = `root` bytes ‖ UTF-8 `versionId`.
3. `putAuditRoot({ epochId, root, signature, receipt /* incl. versionId */, timestamp? })`.

### 3.2 What S3 stores vs the bundle
- S3 object: `{ epochId, rootHex, receipt }` — the immutable **root** witness. It does **not**
  carry the signature (computed after the write; re-writing would create a new version).
- The signature (over `root ‖ versionId`) lives in the bundle's `AnchoredRoot.signature`.
- **Documented trade-off (audit):** authorship is *bundle-mediated*, not verifiable from S3 alone.
  A third party with only S3 access can confirm the immutable root but not the signature — they
  need the bundle + pubkey. This is intentional (binding the versionId requires anchor-then-sign);
  it does not weaken the auditor flow, which always has the bundle.

### 3.3 Read / verify flow
`S3ObjectLockAnchor.fetch(epochId)` (and `pangolin-verify`'s anchor-checked `buildAnchor`):
1. `getObject(key)` → reads the **earliest** version → returns its bytes **and its VersionId**.
2. Returns `AnchoredRoot { root: <S3 earliest root>, signature: <from bundle>, receipt: { versionId: <S3 earliest VersionId> } }`.
3. `verify`: recompute Merkle root from entries → must equal the S3 root; verify the signature over
   `signedPayload(S3root, S3versionId)` with the pubkey. **No bundle-supplied versionId is trusted
   for the read** — the versionId in the signed payload is the one read from S3.

If the earliest version fails the signature check (a same-second forgery tied ahead), the verifier
**rejects** (fail-safe) rather than searching for a passing version — searching could let a
validly-signed operator forgery through.

## 4. Interface changes (bounded)

- `S3LockClient` (`pangolin-core`): `putObject(...)` → returns `{ versionId?: string }`.
  `getObject(key)` is **kept** (still reads the earliest version) but now returns
  `{ body: Uint8Array; versionId?: string } | undefined` so the anchor can build the signed
  payload. (Earliest-read is NOT removed; `getObject` does NOT take a versionId argument.)
- `AwsS3LockClient` (`pangolin-storage-s3`): `putObject` returns `r.VersionId`; the existing
  `ListObjectVersions` earliest-version logic stays and additionally returns the chosen VersionId.
  The fail-loud `IsTruncated` guard stays.
- `AnchorReceipt` (`pangolin-core`): add `versionId?: string`.
- `S3ObjectLockAnchor` (`pangolin-orchestrator`): `anchor` captures the `versionId` into the
  receipt; the anchored S3 JSON drops the signature; `fetch` surfaces the earliest VersionId into
  the returned `AnchoredRoot.receipt.versionId`.
- `verify` (`pangolin-core`): the injected signature check becomes
  `verifySignature?: (root: Uint8Array, versionId: string | undefined, sig: Signature) => boolean`,
  and the verifier passes the **S3-read** versionId. When `versionId` is undefined (detect tier /
  no anchor), the payload is `root` alone — behavior identical to today.
- `pangolin-verify` `verify-context.ts`: `makeVerifySignature` verifies over
  `signedPayload(root, versionId)`; `buildAnchor` (anchor-checked) returns the earliest version's
  root + VersionId from S3 (it does **not** read the versionId from the bundle).

## 5. The signed-payload helper (single source — DRY)

One exported `signedPayload(root: Uint8Array, versionId: string | undefined): Uint8Array` in
`pangolin-core`, used by `AuditLog.sealEpoch` (sign side) and every verifier (check side) so the
signed bytes cannot drift. `signedPayload(root, undefined) === root` (the detect tier / pre-anchor).

## 6. Detect tier (LocalAnchor) unaffected

`LocalAnchor` (detect) has no S3 versions; it signs `root` alone (`versionId` undefined) and stays
`tamper-detecting`. Version-binding is an external-immutable-tier property only.

## 7. Offline verify is tamper-detecting only

`pangolin-verify` offline mode (no S3 access) cannot read the WORM version and therefore **cannot
claim `tamper-evident`** — its ceiling is `tamper-detecting`, unchanged. Only anchor-checked mode
(real S3 read of the earliest version) earns `tamper-evident`. The spec makes this explicit so an
offline bundle can never be presented as version-bound-immutable.

## 8. TDD (genuine red-green — new capability)

- **Same-second external forgery (the closer) — deterministic:** a versioned fake S3 where the
  forged version is timestamped **≤** the original and has NO valid signature. Assert the verifier,
  reading earliest (which may tie to the forgery) + checking the signature, **rejects** (`root-mismatch`
  or a signature failure) — never accepts. With #69's sign-root-only, a tie that selects the forgery
  would NOT be caught by signature → demonstrates the new binding closes it.
- **CRITICAL — malicious-operator rejection (the audit's required test):** an operator WITH the
  signing key forges a root, PUTs it as a NEW version, validly signs `(forgedRoot ‖ forgedVersionId)`,
  and presents a bundle. Assert the verifier reads the **earliest** (original) version and **rejects**
  the forgery (recomputed forged root ≠ original S3 root). Proves the independent anchor is intact —
  the regression the proposed-then-rejected design would have introduced.
- **Signature-binding:** swapping either the root or the versionId in the signed payload breaks
  verification.
- **Gap A contrast (updated):** chain-consistent forge under the layered anchor is caught.
- **MinIO e2e (updated):** seal → forge + attacker re-anchors a new version (later AND same-second
  variants) → verify reads earliest + checks the bound signature → caught.
- **Detect tier:** `LocalAnchor` clean run still `intact: true`, `tamper-detecting`.

## 9. Scope (YAGNI) — pre-v1, no back-compat

**In:** capture the sealed `versionId`; sign `root ‖ versionId`; keep + extend the earliest-version
read to surface its VersionId; the `signedPayload` helper; the malicious-operator + same-second
tests; offline=tamper-detecting clarification. **Out:** a new anchor tier, KMS key custody (#5),
authz-in-evidence (#2), retention/access-log (#3/#4), re-writing the signature into S3, and any
"trust a bundle-supplied versionId" path (rejected by the audit). Pre-v1 → no compatibility shims.

## 10. Risks

- **Seal re-order touches the most security-critical path.** Mitigated by the `signedPayload`
  single-source helper + the full audit suite + the explicit malicious-operator test.
- **Same-second-tie can fail-safe-REJECT a legitimate verify** if an attacker injects a same-second
  version (DoS, not forgery). Acceptable: a false reject is safe and visible; a false accept is not.
  The residual "operator races a forgery against their own honest seal in the same second" is
  contrived and out of scope.
- **Signature not in S3** (§3.2) — documented trade-off; the auditor flow always has the bundle.
