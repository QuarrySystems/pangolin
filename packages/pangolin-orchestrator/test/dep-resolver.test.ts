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

// ---------------------------------------------------------------------------
// §7 gate-skip predicate tests (run-3 spec)
// ---------------------------------------------------------------------------

/** Object-literal helper that builds a fully-typed ItemState with sensible defaults.
 *  Accepts any subset of ItemState fields; `id` is required. */
function gateItem(over: Partial<ItemState> & { id: string }): ItemState {
  return {
    executor: 'fake',
    inputs: {},
    depends_on: [],
    resourceLocks: [],
    runId: 'r',
    queue: 'default',
    status: 'pending',
    ...over,
  } as ItemState;
}

/** Minimal gate inputs that satisfy the spawn-fix predicate. */
const SPAWN_FIX_GATE = {
  gate: {
    onRed: 'spawn-fix' as const,
    subject: 's',
    fixTemplate: { executor: 'dispatch', inputs: {} },
  },
};

describe('§7 gate-skip predicate', () => {
  it('a done-but-red GATE blocks readiness and cascades skip to its dependents', () => {
    const gate = gateItem({ id: 'g', status: 'done', verify: { passed: false }, inputs: SPAWN_FIX_GATE });
    const dep = gateItem({ id: 'd', status: 'pending', depends_on: ['g'] });
    expect(computeNewlyReady([gate, dep])).toEqual([]);
    expect(computeSkipped([gate, dep])).toEqual(['d']);
  });

  it('a done-but-red NON-gate item does NOT block (report-only verify)', () => {
    const red = gateItem({ id: 'n', status: 'done', verify: { passed: false } });
    const dep = gateItem({ id: 'd', status: 'pending', depends_on: ['n'] });
    expect(computeNewlyReady([red, dep])).toEqual(['d']);
    expect(computeSkipped([red, dep])).toEqual([]);
  });

  it('a green gate (verify absent) passes its dependent normally', () => {
    const gate = gateItem({ id: 'g', status: 'done', inputs: SPAWN_FIX_GATE }); // no verify field
    const dep = gateItem({ id: 'd', status: 'pending', depends_on: ['g'] });
    expect(computeNewlyReady([gate, dep])).toEqual(['d']);
    expect(computeSkipped([gate, dep])).toEqual([]);
  });

  it('a green gate (verify.passed === true) passes its dependent normally', () => {
    const gate = gateItem({ id: 'g', status: 'done', verify: { passed: true }, inputs: SPAWN_FIX_GATE });
    const dep = gateItem({ id: 'd', status: 'pending', depends_on: ['g'] });
    expect(computeNewlyReady([gate, dep])).toEqual(['d']);
    expect(computeSkipped([gate, dep])).toEqual([]);
  });

  it('a gate copy (id suffixed with ~2) carrying the same inputs.gate blocks identically', () => {
    const gate = gateItem({ id: 'g~2', status: 'done', verify: { passed: false }, inputs: SPAWN_FIX_GATE });
    const dep = gateItem({ id: 'd', status: 'pending', depends_on: ['g~2'] });
    expect(computeNewlyReady([gate, dep])).toEqual([]);
    expect(computeSkipped([gate, dep])).toEqual(['d']);
  });

  it('a done-but-red gate with onRed !== spawn-fix does NOT block (report-only)', () => {
    const gate = gateItem({ id: 'g', status: 'done', verify: { passed: false }, inputs: { gate: { onRed: 'report', subject: 's', fixTemplate: { executor: 'dispatch', inputs: {} } } } });
    const dep = gateItem({ id: 'd', status: 'pending', depends_on: ['g'] });
    expect(computeNewlyReady([gate, dep])).toEqual(['d']);
    expect(computeSkipped([gate, dep])).toEqual([]);
  });

  // §7 "Data-edge exemption" — per-edge predicate (run-3 spec)

  it('data-edge exemption: fix-item (needs kind=output from the red gate) IS readied and NOT skipped', () => {
    // The fix item depends on the gate (auto-unioned by normalizeRun) AND consumes its findings output.
    const gate = gateItem({ id: 'g', status: 'done', verify: { passed: false }, inputs: SPAWN_FIX_GATE });
    const fix = gateItem({
      id: 'fix',
      status: 'pending',
      depends_on: ['g'],
      needs: { findings: { from: 'g', select: { kind: 'output', path: 'findings' } } },
    });
    // The fix item is a data consumer of the gate's outputs — it should be readied, not blocked.
    expect(computeNewlyReady([gate, fix])).toEqual(['fix']);
    expect(computeSkipped([gate, fix])).toEqual([]);
  });

  it('data-edge exemption: needs binding with kind=patch from red gate is NOT exempt (still blocked)', () => {
    const gate = gateItem({ id: 'g', status: 'done', verify: { passed: false }, inputs: SPAWN_FIX_GATE });
    const consumer = gateItem({
      id: 'c',
      status: 'pending',
      depends_on: ['g'],
      needs: { patch: { from: 'g', select: { kind: 'patch' } } },
    });
    expect(computeNewlyReady([gate, consumer])).toEqual([]);
    expect(computeSkipped([gate, consumer])).toEqual(['c']);
  });

  it('data-edge exemption: needs kind=output from a DIFFERENT item does NOT exempt the red-gate edge', () => {
    // consumer has kind=output binding but from a different item — the gate edge is still blocking.
    const gate = gateItem({ id: 'g', status: 'done', verify: { passed: false }, inputs: SPAWN_FIX_GATE });
    const other = gateItem({ id: 'other', status: 'done' });
    const consumer = gateItem({
      id: 'c',
      status: 'pending',
      depends_on: ['g'],
      needs: { data: { from: 'other', select: { kind: 'output', path: 'result' } } },
    });
    expect(computeNewlyReady([gate, other, consumer])).toEqual([]);
    expect(computeSkipped([gate, other, consumer])).toEqual(['c']);
  });
});
