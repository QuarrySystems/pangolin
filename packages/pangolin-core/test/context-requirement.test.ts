import type { ContextRequirement } from '../src/index.js';
import { it, expect } from 'vitest';

it('the union admits all three observable kinds and rejects an intent claim', () => {
  const reqs: ContextRequirement[] = [
    { kind: 'paths', glob: 'node_modules/**', minCount: 1 },
    { kind: 'exec', bin: 'pnpm' },
    { kind: 'git', needs: 'history' },
  ];
  expect(reqs.map((r) => r.kind)).toEqual(['paths', 'exec', 'git']);
  // This guard is type-level only and unenforced at runtime in this package
  // until it has a tsconfig.test.json wired into typecheck.
  // @ts-expect-error — 'patch-applied' is deliberately NOT expressible
  const _rejected: ContextRequirement = { kind: 'patch-applied' };
});
