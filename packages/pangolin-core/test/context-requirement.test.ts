import type { ContextRequirement } from '../src/context-requirement.js';
import { it, expect } from 'vitest';

it('the union admits all three observable kinds and rejects an intent claim', () => {
  const reqs: ContextRequirement[] = [
    { kind: 'paths', glob: 'node_modules/**', minCount: 1 },
    { kind: 'exec', bin: 'pnpm' },
    { kind: 'git', needs: 'history' },
  ];
  expect(reqs.map((r) => r.kind)).toEqual(['paths', 'exec', 'git']);
  // @ts-expect-error — 'patch-applied' is deliberately NOT expressible
  const rejected: ContextRequirement = { kind: 'patch-applied' };
  expect(rejected).toBeDefined();
});
