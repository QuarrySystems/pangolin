import { describe, it, expect } from 'vitest';
import { selectRunnable } from '../src/engine/lock-manager.js';
import type { ItemState } from '../src/contracts/index.js';

const mk = (id: string, locks: string[]): ItemState =>
  ({ id, executor: 'fake', inputs: {}, depends_on: [], resourceLocks: locks, runId: 'r', queue: 'default', status: 'ready' });

describe('selectRunnable', () => {
  it('skips a candidate contending on an already-held key', () => {
    expect(selectRunnable([mk('a', ['f'])], ['f'], 5).map((i) => i.id)).toEqual([]);
  });
  it('serializes two candidates sharing a key (only the first runs this pass)', () => {
    expect(selectRunnable([mk('a', ['f']), mk('b', ['f'])], [], 5).map((i) => i.id)).toEqual(['a']);
  });
  it('fans out disjoint-lock candidates up to the slot limit', () => {
    expect(selectRunnable([mk('a', ['x']), mk('b', ['y']), mk('c', ['z'])], [], 2).map((i) => i.id)).toEqual(['a', 'b']);
  });
  it('fans out lock-free items up to the slot limit', () => {
    const candidates = [mk('a', []), mk('b', []), mk('c', []), mk('d', [])];
    expect(selectRunnable(candidates, [], 3).map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });
  it('does not mutate the heldKeys array', () => {
    const held = ['x'];
    selectRunnable([mk('a', ['y'])], held, 5);
    expect(held).toEqual(['x']);
  });
  it('does not mutate the candidates array', () => {
    const candidates = [mk('a', ['f']), mk('b', ['f'])];
    const copy = candidates.map((c) => ({ ...c }));
    selectRunnable(candidates, [], 5);
    expect(candidates).toEqual(copy);
  });
  it('returns empty when slots is 0', () => {
    expect(selectRunnable([mk('a', [])], [], 0).map((i) => i.id)).toEqual([]);
  });
  it('returns empty when candidates is empty', () => {
    expect(selectRunnable([], ['x'], 5)).toEqual([]);
  });
});
