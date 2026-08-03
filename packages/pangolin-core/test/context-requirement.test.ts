import type { ContextRequirement } from '../src/index.js';
import { it, expect } from 'vitest';

it('the union admits all three observable kinds and rejects an intent claim', () => {
  const reqs: ContextRequirement[] = [
    { kind: 'paths', glob: 'node_modules/**', minCount: 1 },
    { kind: 'exec', bin: 'pnpm' },
    { kind: 'git', needs: 'history' },
  ];
  expect(reqs.map((r) => r.kind)).toEqual(['paths', 'exec', 'git']);
  // This guard is type-level only. It has no runtime dimension at all — a
  // @ts-expect-error is erased before execution — and it is not enforced by any
  // typecheck in this package either, since pangolin-core has no
  // tsconfig.test.json wired into `pnpm -r typecheck`. The union itself IS
  // enforced wherever `src/` constructs one; pangolin-worker's context-check
  // does exactly that.
  // @ts-expect-error — 'patch-applied' is deliberately NOT expressible
  const _rejected: ContextRequirement = { kind: 'patch-applied' };
});
