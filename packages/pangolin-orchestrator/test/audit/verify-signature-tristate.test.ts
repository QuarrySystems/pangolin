// Regression tests for KNOWN-ISSUES.md #4 — "a missing local public key reports
// TAMPERED, not unverifiable".
//
// `verifySignature` returned a bare boolean, so a verifier with no trust anchor had
// only one way to say so: `false` — the same answer it gives for a signature that
// genuinely does not match. A healthy run then verified as:
//
//     pangolin verify · smoke-…                    ✗ TAMPERED
//       ✓ chain      4 entries, hash-linked, no gaps
//       ✓ root       merkle = anchored root
//       ✗ signature  false
//       ✓ anchor     s3:pangolin-audit  (external-immutable)
//
// "I have no trust anchor" and "this signature does not match" are different facts,
// and a tamper-evidence tool that reports them identically cannot adjudicate the one
// case it exists for. It failed toward a FALSE ALARM, which is the safer direction —
// but it also trains an operator to read ✗ signature as "probably the missing key
// again", which is how a real tamper gets waved through.
//
// The verifier may now return 'n/a'. The states it separates:
//
//   true   — signature verified            => intact, claim may be tamper-evident
//   false  — signature does NOT match      => NOT intact, failure = 'signature'
//   'n/a'  — no trust anchor to check with => intact, claim capped at tamper-detecting
import { it, expect } from 'vitest';
import { verifyBundle } from '../../src/audit/verify-bundle.js';
import { SIG, anchorOf, buildSealedBundle } from './fixtures/sealed-bundle.js';

it("an absent trust anchor reports 'n/a', NOT a tamper", async () => {
  const { bundle, root } = buildSealedBundle();
  const r = await verifyBundle(bundle, {
    anchor: anchorOf(root, 'external-immutable', SIG),
    verifySignature: () => 'n/a', // verifier present, but it holds no key
  });

  expect(r.checks.signature.ok).toBe('n/a');
  // The decisive assertions: this is NOT a tamper report.
  expect(r.intact).toBe(true);
  expect(r.failure).toBeUndefined();
  // …but the tamper-EVIDENT claim is not earned without a verified signature.
  expect(r.claim).toBe('tamper-detecting');
});

it('the n/a signature row explains itself rather than printing a bare "n/a"', async () => {
  const { bundle, root } = buildSealedBundle();
  const r = await verifyBundle(bundle, {
    anchor: anchorOf(root, 'external-immutable', SIG),
    verifySignature: () => 'n/a',
  });
  // An operator seeing this must be able to tell it from "no signature was sealed".
  expect(r.checks.signature.detail).toMatch(/unverifiable/i);
  expect(r.checks.signature.detail).toMatch(/trust anchor|key/i);
});

it('a genuine mismatch is STILL a tamper — the false path must not be softened', async () => {
  const { bundle, root } = buildSealedBundle();
  const r = await verifyBundle(bundle, {
    anchor: anchorOf(root, 'external-immutable', SIG),
    verifySignature: () => false,
  });

  expect(r.checks.signature.ok).toBe(false);
  expect(r.intact).toBe(false);
  expect(r.failure).toBe('signature');
  expect(r.claim).toBe('tamper-detecting');
});

it('a verified signature still earns tamper-evident', async () => {
  const { bundle, root } = buildSealedBundle();
  const r = await verifyBundle(bundle, {
    anchor: anchorOf(root, 'external-immutable', SIG),
    verifySignature: () => true,
  });

  expect(r.checks.signature.ok).toBe(true);
  expect(r.intact).toBe(true);
  expect(r.claim).toBe('tamper-evident');
});

it('distinguishes "no verifier configured" from "verifier has no key"', async () => {
  const { bundle, root } = buildSealedBundle();
  const noVerifier = await verifyBundle(bundle, {
    anchor: anchorOf(root, 'external-immutable', SIG),
  });
  const noKey = await verifyBundle(bundle, {
    anchor: anchorOf(root, 'external-immutable', SIG),
    verifySignature: () => 'n/a',
  });

  // Both are 'n/a' — neither is a tamper — but they are not the same situation and
  // the detail must say which, or the operator cannot tell what to go and fix.
  expect(noVerifier.checks.signature.ok).toBe('n/a');
  expect(noKey.checks.signature.ok).toBe('n/a');
  expect(noVerifier.checks.signature.detail).not.toBe(noKey.checks.signature.detail);
});

it('an unsigned seal is reported as unsigned, not as unverifiable', async () => {
  const { bundle, root } = buildSealedBundle();
  const r = await verifyBundle(bundle, {
    anchor: anchorOf(root, 'external-immutable'), // no signature on the anchored root
    verifySignature: () => true,
  });

  expect(r.checks.signature.ok).toBe('n/a');
  expect(r.checks.signature.detail).toMatch(/no signature/i);
});
