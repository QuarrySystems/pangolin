import { it, expect } from 'vitest';
import { staticDag } from '../../src/patterns/static-dag.js';

it('plan is identity (same reference) and onTaskDone never spawns', () => {
  const run = { id: 'r', queue: 'q', items: [] };
  expect(staticDag.plan(run)).toBe(run);
});

it('onTaskDone returns null for all terminal statuses', () => {
  expect(staticDag.onTaskDone({ status: 'done' } as never, { runItems: [] })).toBeNull();
  expect(staticDag.onTaskDone({ status: 'failed' } as never, { runItems: [] })).toBeNull();
  expect(staticDag.onTaskDone({ status: 'skipped' } as never, { runItems: [] })).toBeNull();
  expect(staticDag.onTaskDone({ status: 'cancelled' } as never, { runItems: [] })).toBeNull();
});

it('staticDag has correct id', () => {
  expect(staticDag.id).toBe('static-dag');
});
