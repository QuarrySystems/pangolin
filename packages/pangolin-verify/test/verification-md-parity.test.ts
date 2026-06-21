import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Parity guard: VERIFICATION.md is the auditor's reimplementation contract ("trust the artifact,
// not the vendor"). If the shipped verifier rejects a forgery that a spec-faithful reimplementation
// would accept, the spec licenses forged bundles. This guard fails when the spec drifts BELOW the
// verifier — specifically, when a `failure` variant or a load-bearing check the verifier enforces
// is not documented. Adding a new check to verifyBundle MUST update VERIFICATION.md in the same
// change, or this test breaks.

const SPEC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'VERIFICATION.md'),
  'utf8',
);

// Mirror of VerificationReport['failure'] (core audit.ts). Kept here deliberately: the test's job
// is to assert the SPEC mentions every variant the TYPE defines. If you add a variant to the type,
// add it here AND document it in VERIFICATION.md — that coupling is the point.
const FAILURE_VARIANTS = [
  'chain',
  'anchor-missing',
  'root-mismatch',
  'signature',
  'handoff',
  'manifest',
] as const;

describe('VERIFICATION.md parity with the shipped verifier', () => {
  for (const variant of FAILURE_VARIANTS) {
    it(`documents the '${variant}' failure variant`, () => {
      expect(SPEC).toContain(variant);
    });
  }

  it('documents the manifest-integrity check (manifest ↔ chain binding)', () => {
    expect(SPEC.toLowerCase()).toContain('manifest integrity');
  });

  it('documents that the provenance producer set is chain-derived, NOT from items[]', () => {
    // The exact hole closed 2026-06-19: producers must come from item.reconciled chain entries.
    expect(SPEC).toContain('item.reconciled');
    expect(SPEC.toLowerCase()).toMatch(/do not derive the producer set from the top-level `items/);
  });

  it('documents that canonEntry seals outputRefs (else it would be forgeable)', () => {
    expect(SPEC).toContain('outputRefs');
  });

  it('documents that the tamper-evident claim requires a verified signature', () => {
    // claimFor requires signature === true, not just intact + external-immutable.
    expect(SPEC.toLowerCase()).toMatch(/signature check passed|verified signature|signature === true/);
  });
});
