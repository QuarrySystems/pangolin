import { describe, it, expect } from 'vitest';
import { computeNewlyReady, computeSkipped, isSettled } from '../src/engine/dep-resolver.js';
import type { ItemState } from '../src/contracts/index.js';

const mk = (id: string, deps: string[], status: ItemState['status']): ItemState =>
  ({ id, executor: 'fake', inputs: {}, depends_on: deps, resourceLocks: [], runId: 'r', queue: 'default', status });

describe('computeNewlyReady', () => {
  it('readies roots (no deps) that are pending', () => {
    expect(computeNewlyReady([mk('a', [], 'pending')])).toEqual(['a']);
  });
  it('holds an item whose dep is not done', () => {
    expect(computeNewlyReady([mk('a', [], 'running'), mk('b', ['a'], 'pending')])).toEqual([]);
  });
  it('readies an item once all deps are done', () => {
    expect(computeNewlyReady([mk('a', [], 'done'), mk('b', ['a'], 'pending')])).toEqual(['b']);
  });
  it('does not return already-ready items', () => {
    expect(computeNewlyReady([mk('a', [], 'ready')])).toEqual([]);
  });
  it('does not return running items', () => {
    expect(computeNewlyReady([mk('a', [], 'running')])).toEqual([]);
  });
  it('does not return done items', () => {
    expect(computeNewlyReady([mk('a', [], 'done')])).toEqual([]);
  });
  it('does not mutate the input array', () => {
    const items = [mk('a', [], 'pending')];
    const copy = [...items];
    computeNewlyReady(items);
    expect(items).toEqual(copy);
  });
  it('returns all pending roots when multiple exist', () => {
    const result = computeNewlyReady([mk('a', [], 'pending'), mk('b', [], 'pending')]);
    expect(result).toEqual(['a', 'b']);
  });
  it('holds item if only some deps are done', () => {
    const items = [
      mk('a', [], 'done'),
      mk('b', [], 'running'),
      mk('c', ['a', 'b'], 'pending'),
    ];
    expect(computeNewlyReady(items)).toEqual([]);
  });
});

const item = (id: string, status: string, deps: string[] = []) => ({ id, runId: 'r', queue: 'q', executor: 'e', inputs: {}, depends_on: deps, resourceLocks: [], status } as any);

describe('computeSkipped', () => {
  it('cascades a pending item whose dep failed', () => {
    expect(computeSkipped([item('a', 'failed'), item('b', 'pending', ['a'])])).toEqual(['b']);
  });
  it('cascades a pending item whose dep is skipped', () => {
    expect(computeSkipped([item('a', 'skipped'), item('b', 'pending', ['a'])])).toEqual(['b']);
  });
  it('does not cascade when the dep is still pending/running/done', () => {
    expect(computeSkipped([item('a', 'running'), item('b', 'pending', ['a'])])).toEqual([]);
    expect(computeSkipped([item('a', 'done'), item('b', 'pending', ['a'])])).toEqual([]);
    expect(computeSkipped([item('a', 'pending'), item('b', 'pending', ['a'])])).toEqual([]);
  });
  it('does not cascade non-pending items even if dep failed', () => {
    expect(computeSkipped([item('a', 'failed'), item('b', 'done', ['a'])])).toEqual([]);
    expect(computeSkipped([item('a', 'failed'), item('b', 'running', ['a'])])).toEqual([]);
  });
  it('returns multiple items if multiple qualify', () => {
    const items = [item('a', 'failed'), item('b', 'pending', ['a']), item('c', 'pending', ['a'])];
    expect(computeSkipped(items)).toEqual(['b', 'c']);
  });
});

describe('isSettled', () => {
  it('isSettled is true only when nothing is pending/ready/running', () => {
    expect(isSettled([item('a', 'done'), item('b', 'skipped')])).toBe(true);
    expect(isSettled([item('a', 'failed'), item('b', 'skipped')])).toBe(true);
  });
  it('is false when an item is pending', () => {
    expect(isSettled([item('a', 'pending')])).toBe(false);
  });
  it('is false when an item is ready', () => {
    expect(isSettled([item('a', 'ready')])).toBe(false);
  });
  it('is false when an item is running', () => {
    expect(isSettled([item('a', 'running')])).toBe(false);
  });
  it('is true for an empty list', () => {
    expect(isSettled([])).toBe(true);
  });
});
