import { it, expect } from 'vitest';
import type { Pattern } from '../../src/contracts/index.js';   // reachable via contracts barrel
import type { Run } from '../../src/contracts/index.js';

it('a no-op object satisfies the Pattern contract and plan can be identity', () => {
  const noop: Pattern = { id: 'noop', plan: (r: Run) => r, onTaskDone: () => null };
  const run: Run = { id: 'r1', queue: 'default', items: [] };
  expect(noop.plan(run)).toBe(run);
  expect(noop.onTaskDone({} as never, { runItems: [] })).toBeNull();
});
