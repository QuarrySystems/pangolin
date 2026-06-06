import { it, expect } from 'vitest';
import { collectSpawns } from '../../src/patterns/scan.js';
import type { Pattern } from '../../src/contracts/pattern.js';

it('invokes onTaskDone only for terminal items and collects non-empty directives', () => {
  const seen: string[] = [];
  const pattern: Pattern = {
    id: 'probe',
    plan: (r) => r,
    onTaskDone: (item) => { seen.push(item.id); return item.id === 'a' ? { items: [{ id: 'spawned', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] }] } : null; },
  };
  const items = [
    { id: 'a', status: 'done' }, { id: 'b', status: 'running' }, { id: 'c', status: 'failed' },
  ] as never[];
  const collected = collectSpawns(items, pattern);
  expect(seen).toEqual(['a', 'c']);              // 'b' is not terminal
  expect(collected).toEqual([{ causeItemId: 'a', items: [expect.objectContaining({ id: 'spawned' })] }]);
});
