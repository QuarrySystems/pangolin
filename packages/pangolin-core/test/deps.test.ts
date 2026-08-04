import type { DepsEvidence } from '../src/deps.js';
import type { OutputSentinel } from '../src/product.js';
import type { AuditItemOutcome } from '../src/audit.js';
import { it, expect } from 'vitest';

it('a differing pre/post pair is representable — the mid-run change case', () => {
  const e: DepsEvidence = { atSetup: 'sha256:aaa', atFinish: 'sha256:bbb', tier: 'recorded' };
  expect(e.atSetup).not.toBe(e.atFinish);
  expect(e.tier).toBe('recorded');
});

it('deps is optional on OutputSentinel — a sentinel without it is still valid', () => {
  const withoutDeps: OutputSentinel = { schemaVersion: 1 };
  expect(withoutDeps.deps).toBeUndefined();

  const withDeps: OutputSentinel = {
    schemaVersion: 1,
    deps: { atSetup: 'sha256:a', atFinish: 'sha256:a', tier: 'recorded' },
  };
  // The equal-hash case is the "agent did not touch the dependency set" report,
  // which must be distinguishable from absence rather than collapsing into it.
  expect(withDeps.deps?.atSetup).toBe(withDeps.deps?.atFinish);
});

it('deps is optional on AuditItemOutcome', () => {
  const outcome: AuditItemOutcome = {
    deps: { atSetup: 'sha256:a', atFinish: 'sha256:b', tier: 'recorded' },
  } as AuditItemOutcome;
  expect(outcome.deps?.tier).toBe('recorded');
});

it("the tier union admits only 'recorded' — widening it is a security decision", () => {
  // Type-level only; a @ts-expect-error is erased before execution. This package
  // has no `typecheck:test` script and its tsconfig includes only `src/**/*`, so
  // this is documentation-grade, matching the existing unenforced idiom at
  // test/refs.test.ts:7-8. The literal IS build-enforced at every `src/`
  // assignment site, which is where it actually protects anything.
  // @ts-expect-error — 'attested' is deliberately NOT expressible: spec §5.4
  const _rejected: DepsEvidence = { atSetup: 'sha256:a', atFinish: 'sha256:b', tier: 'attested' };
});
