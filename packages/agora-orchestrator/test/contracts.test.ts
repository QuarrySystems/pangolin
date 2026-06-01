import { describe, it, expect } from 'vitest';
import { RUN_STATUSES } from '../src/contracts/index.js';
import type { WorkItem } from '../src/contracts/index.js';
import type { Executor, FireContext } from '../src/contracts/index.js';

describe('contracts', () => {
  it('RUN_STATUSES covers the seven lifecycle states', () => {
    expect([...RUN_STATUSES]).toEqual(['pending', 'ready', 'running', 'done', 'failed', 'skipped', 'cancelled']);
  });
  it('WorkItem shape compiles', () => {
    const w: WorkItem = { id: 'a', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: [] };
    expect(w.id).toBe('a');
  });
});

it('a minimal fire(item)-only executor still type-checks', () => {
  const minimal: Executor = {
    id: 'min',
    async fire(_item) { return { dispatchHash: 'h2' }; },
    async reconcile() { return { status: 'done' }; },
  };
  expect(minimal.id).toBe('min');
});

it('a minimal executor satisfies the extended fire signature', async () => {
  const seen: FireContext[] = [];
  const ex: Executor = {
    id: 'x',
    async fire(_item, ctx) { if (ctx) seen.push(ctx); return { dispatchHash: 'h1', manifestRef: 'm1' }; },
    async reconcile() { return { status: 'done', resultRef: 'r1' }; },
  };
  const fired = await ex.fire({ id: 'a', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] },
    { runId: 'r', actor: 'human:brett' });
  expect(fired).toEqual({ dispatchHash: 'h1', manifestRef: 'm1' });
  expect(seen[0]).toEqual({ runId: 'r', actor: 'human:brett' });
  expect(await ex.reconcile('h1')).toEqual({ status: 'done', resultRef: 'r1' });
});
