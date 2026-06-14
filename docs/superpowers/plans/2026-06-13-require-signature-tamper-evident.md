# Require a verified signature for the `tamper-evident` claim — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the same-second tamper-evidence residual from PR #69 by gating the `tamper-evident` claim on a *verified* signature, so a same-second forgery (which carries no valid signature) can never earn the top claim.

**Architecture:** One claim-rule change — `claimFor(intact, guarantee, sigOk)` requires `sigOk === true` for `tamper-evident`. Both (only) call sites pass the signature-check result. `intact` is unchanged (structural integrity stays separate from the claim). PR #69's earliest-version read and the entire seal flow are untouched. The change is a compile-time fence (new required param), so `pnpm -r typecheck` enumerates the blast radius.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, ed25519 (`node:crypto`), Merkle/hash-chain audit primitives in `pangolin-core`.

Spec: `docs/superpowers/specs/2026-06-13-require-signature-tamper-evident-design.md`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/pangolin-core/src/audit-verify.ts` | `claimFor` (single source of the claim rule) + `verify` | Add `sigOk` param + gate; pass `sigOk` at the call site |
| `packages/pangolin-core/src/audit-verify-bundle.ts` | `verifyBundle` re-derives the claim after the handoff check | Pass `base.checks.signature.ok` to `claimFor` |
| `packages/pangolin-orchestrator/test/audit/tamper-evident-contrast.test.ts` | Forge/anchor contrast tests (reusable test-local helpers) | Add the same-second-forgery + unsigned-downgrade red-green tests |
| `packages/pangolin-orchestrator/test/audit/verify.test.ts` | `claimFor` unit table | Update to the 3-arg signature + add `n/a`/`false` cases |
| `packages/pangolin-cli/test/cmd-verify.test.ts` | CLI verify command tests | Sign the fixture bundle + inject a verifier so "clean → TAMPER-EVIDENT" stays valid (the CLI-layer manifestation of the same hole) |

Unaffected (verified during planning — do NOT change): `acceptance.int.test.ts` test 2 (already seals signed + injects `verifySignature`), `test/e2e/tamper-evident-minio.test.ts` (signed + verified, env-gated), `examples/demo-claims-appeals-minio/test/recording-bundle.test.ts` (`guarantee: 'detect'`, asserts `intact` not `claim`).

---

## Task 1: Gate the `tamper-evident` claim on a verified signature

**Files:**
- Test: `packages/pangolin-orchestrator/test/audit/tamper-evident-contrast.test.ts` (add helper + 2 tests)
- Modify: `packages/pangolin-core/src/audit-verify.ts:8-12` (claimFor) and `:93` (call site)
- Modify: `packages/pangolin-core/src/audit-verify-bundle.ts:22` (call site)
- Test: `packages/pangolin-orchestrator/test/audit/verify.test.ts:214-226` (claimFor unit table)

- [ ] **Step 1: Write the failing tests (RED) — the same-second forgery closer + the unsigned downgrade**

Add the signer import to the existing imports at the top of `tamper-evident-contrast.test.ts`:

```typescript
import { createLocalSigner, verifyEd25519 } from '../../src/audit/signer.js';
```

Add this fake and the two tests at the end of the file (reusing the file's existing `buildRun`, `forgeInPlace`, `memStore`, `versionedFakeS3` helpers):

```typescript
// Fake modeling the SAME-SECOND tie WORST CASE: when an attacker writes a forged version in
// the SAME second as the seal, S3's version order at second-granularity is ambiguous, so the
// earliest-read CAN return the forgery. This fake returns the most-recently written version to
// model that worst case. (Contrast versionedFakeS3, which returns the earliest = later-second
// case that #69 already defeats.)
function sameSecondTieFakeS3(): S3LockClient {
  const m = new Map<string, Uint8Array[]>();
  return {
    async putObject(key, body) { const v = m.get(key) ?? []; v.push(body); m.set(key, v); },
    async getObject(key) { const v = m.get(key); return v?.[v.length - 1]; },
  };
}

it('same-second forgery (unsigned) selected by the tie -> tamper-evident claim collapses', async () => {
  const { rows, root } = buildRun('r');
  const store = memStore(rows);
  const signer = createLocalSigner();
  const anchor = new S3ObjectLockAnchor(sameSecondTieFakeS3(), 'bucket');

  // Honest SIGNED seal (version 0, lock-protected original).
  await anchor.anchor({ epochId: 'r', root, signature: await signer.sign(root) });

  // Attacker forges the chain and writes an UNSIGNED forged version in the same second (version 1).
  const forgedRoot = forgeInPlace(store.entries);
  await anchor.anchor({ epochId: 'r', root: forgedRoot }); // no signature

  const report = await verify('r', {
    store, anchor,
    verifySignature: (r, sig) => verifyEd25519(r, sig, signer.publicKey),
  });

  // The read returned the forgery: its root matches the forged entries (rootOk true), but it
  // carries NO signature -> sigOk 'n/a'. The tamper-evident claim MUST NOT be granted.
  expect(report.checks.root.ok).toBe(true);        // forgery is structurally self-consistent
  expect(report.checks.signature.ok).toBe('n/a');  // unsigned forgery — no verifiable authorship
  expect(report.claim).toBe('tamper-detecting');   // pre-fix BUG: returns 'tamper-evident'
});

it('clean external-immutable run verified without a signature verifier -> tamper-detecting', async () => {
  const { rows, root } = buildRun('r');
  const store = memStore(rows);
  const signer = createLocalSigner();
  const anchor = new S3ObjectLockAnchor(versionedFakeS3(), 'bucket');
  await anchor.anchor({ epochId: 'r', root, signature: await signer.sign(root) });

  // No verifySignature injected -> the verifier cannot confirm authorship -> not tamper-evident.
  const report = await verify('r', { store, anchor });
  expect(report.intact).toBe(true);
  expect(report.claim).toBe('tamper-detecting');   // pre-fix BUG: returns 'tamper-evident'
});
```

- [ ] **Step 2: Run the new tests to verify they FAIL (RED)**

Run: `pnpm --filter @quarry-systems/pangolin-orchestrator test -- tamper-evident-contrast`
Expected: BOTH new tests FAIL — `expected 'tamper-detecting', got 'tamper-evident'`. This proves the hole exists on current code (a same-second / unsigned external-immutable run is wrongly claimed tamper-evident).

- [ ] **Step 3: Implement the gate in `claimFor` (GREEN)**

In `packages/pangolin-core/src/audit-verify.ts`, replace the `claimFor` function (lines 7-12):

```typescript
/** DRY claim rule (spec §7): tamper-evident requires guarantee >= external-immutable, an intact
 *  structure, AND a VERIFIED signature. A same-second forgery carries no valid signature, so
 *  sigOk !== true collapses the claim to tamper-detecting (fail-safe). intact stays structural. */
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

- [ ] **Step 4: Pass `sigOk` at the `verify` call site (GREEN)**

In the same file, line 93, change:

```typescript
  const claim = claimFor(intact, g);
```
to:
```typescript
  const claim = claimFor(intact, g, sigOk);
```

- [ ] **Step 5: Pass the signature result at the `verifyBundle` call site (GREEN)**

In `packages/pangolin-core/src/audit-verify-bundle.ts`, line 22, change:

```typescript
      const claim = claimFor(intact, base.guarantee);
```
to:
```typescript
      const claim = claimFor(intact, base.guarantee, base.checks.signature.ok);
```

- [ ] **Step 6: Update the `claimFor` unit table to the 3-arg signature (GREEN)**

In `packages/pangolin-orchestrator/test/audit/verify.test.ts`, replace the `describe('claimFor', ...)` block (lines 214-226):

```typescript
describe('claimFor', () => {
  it('intact + external-immutable + verified signature -> tamper-evident', () => {
    expect(claimFor(true, 'external-immutable', true)).toBe('tamper-evident');
  });

  it('intact + external-immutable but signature n/a -> tamper-detecting', () => {
    expect(claimFor(true, 'external-immutable', 'n/a')).toBe('tamper-detecting');
  });

  it('intact + external-immutable but signature failed -> tamper-detecting', () => {
    expect(claimFor(true, 'external-immutable', false)).toBe('tamper-detecting');
  });

  it('not intact + external-immutable + verified signature -> tamper-detecting', () => {
    expect(claimFor(false, 'external-immutable', true)).toBe('tamper-detecting');
  });

  it('intact + detect + verified signature -> tamper-detecting', () => {
    expect(claimFor(true, 'detect', true)).toBe('tamper-detecting');
  });
});
```

- [ ] **Step 7: Run the orchestrator audit tests to verify GREEN**

Run: `pnpm --filter @quarry-systems/pangolin-orchestrator test -- audit`
Expected: PASS — the two new contrast tests pass, the `claimFor` table passes, and `acceptance.int.test.ts` test 2 (signed + verified) still reports `tamper-evident`.

- [ ] **Step 8: Commit**

```bash
git add packages/pangolin-core/src/audit-verify.ts \
        packages/pangolin-core/src/audit-verify-bundle.ts \
        packages/pangolin-orchestrator/test/audit/tamper-evident-contrast.test.ts \
        packages/pangolin-orchestrator/test/audit/verify.test.ts
git commit -m "fix(audit): require a verified signature for the tamper-evident claim

Closes the same-second residual from PR #69. A missing signature was sigOk='n/a',
and 'n/a' did not block the tamper-evident claim, so a same-second forgery (no key
-> no valid signature) read via the earliest-tie was wrongly claimed tamper-evident.
claimFor now requires sigOk===true for tamper-evident; intact stays structural.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Restore the CLI auditor's signature check (cmd-verify fixture)

The CLI `verify` command already threads `verifySignature` from the config's `OrchContext` — but `cmd-verify.test.ts` builds an **unsigned** fixture bundle and provides **no** verifier, so its "clean bundle → TAMPER-EVIDENT" test was passing only because of the very hole Task 1 closes. After Task 1 it prints TAMPER-DETECTING. Fix: make the fixture genuinely signed and verify it (the correct auditor flow), so the claim is earned.

**Files:**
- Test: `packages/pangolin-cli/test/cmd-verify.test.ts` (`buildSealedBundle` + the clean-bundle test's `OrchContext`)

- [ ] **Step 1: Run cmd-verify tests to confirm the expected FAIL (RED, consequence of Task 1)**

Run: `pnpm --filter @quarry-systems/pangolin-cli test -- cmd-verify`
Expected: "prints TAMPER-EVIDENT and exits 0 for a clean exported bundle" FAILS — output now contains `TAMPER-DETECTING` (the unsigned fixture no longer earns the claim).

- [ ] **Step 2: Sign the fixture bundle in `buildSealedBundle`**

In `packages/pangolin-cli/test/cmd-verify.test.ts`, add the signer import alongside the existing imports:

```typescript
import { createLocalSigner, verifyEd25519 } from '@quarry-systems/pangolin-orchestrator';
```

Change `buildSealedBundle` to return the signer's public key and attach a real signature to the anchored root. Replace the `anchoredRoot` construction and the function's return (lines 58-62 and 82) so it reads:

```typescript
async function buildSealedBundle(
  runId: string = 'r',
): Promise<{ bundle: AuditBundle; root: Uint8Array; publicKey: Buffer }> {
  const { entries, root } = await buildEntries(runId);
  const signer = createLocalSigner();
  const anchoredRoot: AnchoredRoot = {
    epochId: runId,
    root,
    signature: await signer.sign(root),
    receipt: { anchorId: 'fake', epochId: runId, guarantee: 'external-immutable', at: 0 },
  };
```

and at the end of the function:

```typescript
  return { bundle, root, publicKey: signer.publicKey };
}
```

Also update the embedded fixture `report` (lines 68-80) so it is internally consistent with a verified signature (the CLI re-verifies, so this is scaffolding — but keep it honest):

```typescript
    report: {
      runId,
      anchorId: 'fake',
      guarantee: 'external-immutable',
      intact: true,
      claim: 'tamper-evident',
      checks: {
        chain: { ok: true },
        root: { ok: true },
        signature: { ok: true },
        anchor: { ok: true },
      },
    },
```

> If `@quarry-systems/pangolin-orchestrator` does not re-export `createLocalSigner`/`verifyEd25519`, import them from the orchestrator signer entrypoint the way `acceptance.int.test.ts` does (`../../src/audit/signer.js` is internal to the orchestrator package; from the CLI package use the package's public barrel). Verify the export exists with: `node -e "console.log(Object.keys(require('@quarry-systems/pangolin-orchestrator')).filter(k=>/Signer|Ed25519/.test(k)))"` before relying on it; if absent, add the re-export to the orchestrator barrel in this task.

- [ ] **Step 3: Inject the verifier into the clean-bundle test's OrchContext**

In the test "prints TAMPER-EVIDENT and exits 0 for a clean exported bundle" (around line 176), capture `publicKey` and provide a `verifySignature` on the `OrchContext`:

```typescript
    const { bundle, root, publicKey } = await buildSealedBundle('run-clean-1');
    const bundlePath = join(tmpDir, 'clean-bundle.json');
    await writeFile(bundlePath, serializeBundle(bundle));

    const oc: OrchContext = {
      transport: makeFakeTransport(),
      anchor: anchorOf(root, 'external-immutable'),
      verifySignature: (r: Uint8Array, sig: Signature) => verifyEd25519(r, sig, publicKey),
    };
```

Add the `Signature` type import if not present (from `@quarry-systems/pangolin-orchestrator`). Update the other `buildSealedBundle` call sites in this file (e.g. the "altered bundle" test at line 199) to destructure only what they use — `const { bundle } = await buildSealedBundle('run-tampered-1');` remains valid since the return is a superset.

- [ ] **Step 4: Run cmd-verify tests to verify GREEN**

Run: `pnpm --filter @quarry-systems/pangolin-cli test -- cmd-verify`
Expected: PASS — "clean exported bundle" prints `TAMPER-EVIDENT` again, now because a real ed25519 signature was verified; the "altered bundle" test still prints `TAMPERED` / exits 1.

- [ ] **Step 5: Commit**

```bash
git add packages/pangolin-cli/test/cmd-verify.test.ts
git commit -m "test(cli): sign the verify fixture so TAMPER-EVIDENT is earned, not assumed

The clean-bundle CLI test asserted TAMPER-EVIDENT on an UNSIGNED bundle with no
verifier injected — the CLI-layer form of the same-second hole. Sign the fixture
and inject a verifySignature so the claim is earned via a real ed25519 check, the
correct independent-auditor flow.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Full-workspace gate (blast-radius sweep)

**Files:** none changed unless the sweep surfaces a regression.

- [ ] **Step 1: Typecheck the whole workspace (the compile-time fence)**

Run: `pnpm -r typecheck`
Expected: PASS. The new required `claimFor` param makes any missed caller a type error. The only two callers (`audit-verify.ts`, `audit-verify-bundle.ts`) were updated in Task 1; this confirms there are no others (including example/consumer code — the PR #66 lesson that per-package checks miss consumer literals).

- [ ] **Step 2: Run the full test suite**

Run: `pnpm -r test`
Expected: PASS. Specifically confirm no surviving test asserts `tamper-evident` on an unsigned/unverified path. Expected-green tamper-evident assertions: `acceptance.int.test.ts` test 2 and `tamper-evident-minio` (both seal signed + inject `verifySignature`); `recording-bundle` is `detect`-tier and asserts `intact`. If any other test fails by now printing/returning `tamper-detecting`, it was asserting the hole — fix it by sealing signed + injecting a verifier (NEVER by loosening the assertion to accept the unsigned claim).

- [ ] **Step 3: Lint the changed packages**

Run: `pnpm --filter @quarry-systems/pangolin-core lint && pnpm --filter @quarry-systems/pangolin-orchestrator lint && pnpm --filter @quarry-systems/pangolin-cli lint`
Expected: PASS (per-package `eslint src`; tests are unlinted).

- [ ] **Step 4: Update the ROADMAP known-gap note (if present)**

Run: `git grep -n "same-second" -- 'docs/**' 'ROADMAP*' '*.md' || true`
If a ROADMAP/docs entry names the same-second residual as an open gap, update it to "closed — `tamper-evident` requires a verified signature (`claimFor` gate), so a same-second forgery cannot earn the claim." If no such entry exists, skip (do not invent one). Commit only if a file changed:

```bash
git commit -am "docs: mark the same-second tamper-evidence residual closed" || true
```

---

## Self-Review

**1. Spec coverage:**
- §3 claim-gate change → Task 1 Steps 3-5. ✅
- §6.1 same-second forgery red-green → Task 1 Steps 1-2 (test 1). ✅
- §6.2 unsigned downgrade → Task 1 Step 1 (test 2). ✅
- §6.3 clean signed run still tamper-evident (regression guard) → covered by the untouched `acceptance.int.test.ts` test 2, re-confirmed in Task 1 Step 7 / Task 3 Step 2. ✅
- §6.4 claimFor unit table → Task 1 Step 6. ✅
- §6.5 detect tier unaffected → `claimFor(true,'detect',true)` case (Task 1 Step 6) + existing detect tests. ✅
- §7 blast-radius (typecheck + audit tamper-evident assertions, sign+verify not loosen) → Task 2 (cmd-verify) + Task 3. ✅
- §4 "what stays the same" (no seal/anchor/interface change) → honored; no task touches those files. ✅

**2. Placeholder scan:** No TBD/TODO/"handle edge cases". Every code step shows the literal edit. The one conditional (Task 2 Step 2 export-location note) gives an exact verification command and a concrete fallback. ✅

**3. Type consistency:** `claimFor(intact: boolean, guarantee: Guarantee, sigOk: boolean | 'n/a')` is used identically in the definition (Task 1 Step 3), both call sites (Steps 4-5 pass `sigOk` / `base.checks.signature.ok`, both typed `boolean | 'n/a'`), and the unit table (Step 6). `signer.sign(root): Promise<Signature>` and `verifyEd25519(root, sig, publicKey): boolean` match their usage in Tasks 1-2. ✅
