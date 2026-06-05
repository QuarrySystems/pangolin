import { describe, it, expect } from 'vitest';
import { normalizeRun, validateRun } from '../src/engine/run-validator.js';
import type { Run } from '../src/contracts/types.js';
import { devRegistry } from '../src/packs/dev.js';
import { PackRegistry } from '../src/packs/registry.js';
import { makeShape } from './support/make-shape.js';

// ---- helpers ----

function mkRun(items: Run['items']): Run {
  return { id: 'r', queue: 'q', items };
}

function mkItem(id: string, opts: {
  depends_on?: string[];
  subagentShape?: string;
  needs?: Run['items'][number]['needs'];
} = {}): Run['items'][number] {
  return {
    id,
    executor: 'x',
    inputs: {},
    depends_on: opts.depends_on ?? [],
    resourceLocks: [],
    subagentShape: opts.subagentShape,
    needs: opts.needs,
  };
}

// ---- normalizeRun ----

describe('normalizeRun', () => {
  it('unions needs[*].from into depends_on without duplicates (spec §3)', () => {
    const run = mkRun([
      mkItem('a'),
      mkItem('b', {
        depends_on: ['a'],
        needs: { patch: { from: 'a', select: { kind: 'patch' } } },
      }),
    ]);
    const result = normalizeRun(run);
    expect(result.items[1].depends_on).toEqual(['a']); // 'a' deduplicated
  });

  it('adds needs.from not already in depends_on', () => {
    const run = mkRun([
      mkItem('a'),
      mkItem('b', {
        depends_on: [],
        needs: { patch: { from: 'a', select: { kind: 'patch' } } },
      }),
    ]);
    const result = normalizeRun(run);
    expect(result.items[1].depends_on).toContain('a');
  });

  it('never drops existing depends_on entries', () => {
    const run = mkRun([
      mkItem('a'),
      mkItem('c'),
      mkItem('b', {
        depends_on: ['c'],
        needs: { patch: { from: 'a', select: { kind: 'patch' } } },
      }),
    ]);
    const result = normalizeRun(run);
    expect(result.items[2].depends_on).toContain('c');
    expect(result.items[2].depends_on).toContain('a');
  });

  it('is idempotent: normalizeRun(normalizeRun(r)) deep-equals normalizeRun(r)', () => {
    const run = mkRun([
      mkItem('a'),
      mkItem('b', {
        depends_on: ['a'],
        needs: { patch: { from: 'a', select: { kind: 'patch' } } },
      }),
    ]);
    const once = normalizeRun(run);
    const twice = normalizeRun(once);
    expect(twice).toEqual(once);
  });

  it('does not mutate input run (returns new Run)', () => {
    const run = mkRun([
      mkItem('a'),
      mkItem('b', {
        depends_on: [],
        needs: { patch: { from: 'a', select: { kind: 'patch' } } },
      }),
    ]);
    const originalDepends = [...run.items[1].depends_on];
    normalizeRun(run);
    expect(run.items[1].depends_on).toEqual(originalDepends);
  });

  it('leaves items without needs unchanged', () => {
    const run = mkRun([mkItem('a'), mkItem('b', { depends_on: ['a'] })]);
    expect(normalizeRun(run)).toEqual(run);
  });
});

// ---- validateRun — structural checks (no packs) ----

describe('validateRun — structural', () => {
  it('returns [] for a valid run with no dependencies', () => {
    const run = mkRun([mkItem('a'), mkItem('b')]);
    expect(validateRun(run)).toEqual([]);
  });

  it('returns [] for a valid run with linear deps', () => {
    const run = mkRun([mkItem('a'), mkItem('b', { depends_on: ['a'] })]);
    expect(validateRun(run)).toEqual([]);
  });

  it('flags duplicate item ids', () => {
    const run = mkRun([mkItem('a'), mkItem('a')]);
    const errors = validateRun(run);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /a/.test(e) && /duplicate/i.test(e))).toBe(true);
  });

  it('flags unknown depends_on reference', () => {
    const run = mkRun([mkItem('b', { depends_on: ['ghost'] })]);
    const errors = validateRun(run);
    expect(errors.some((e) => /ghost/.test(e))).toBe(true);
  });

  it('flags unknown needs.from reference', () => {
    const run = mkRun([
      mkItem('b', {
        needs: { patch: { from: 'ghost', select: { kind: 'patch' } } },
      }),
    ]);
    const errors = validateRun(run);
    expect(errors.some((e) => /ghost/.test(e))).toBe(true);
  });

  it('flags needs.from not in depends_on (pre-normalized input)', () => {
    // 'a' exists but is not in b's depends_on
    const run = mkRun([
      mkItem('a'),
      mkItem('b', {
        depends_on: [],
        needs: { patch: { from: 'a', select: { kind: 'patch' } } },
      }),
    ]);
    const errors = validateRun(run);
    // needs.from not in depends_on is an error on un-normalized input
    expect(errors.some((e) => /a/.test(e))).toBe(true);
  });

  it('detects a direct depends_on cycle', () => {
    // a -> b, b -> a
    const run = mkRun([
      mkItem('a', { depends_on: ['b'] }),
      mkItem('b', { depends_on: ['a'] }),
    ]);
    const errors = validateRun(run);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /cycle/i.test(e))).toBe(true);
  });

  it('detects an indirect depends_on cycle (a->b->c->a)', () => {
    const run = mkRun([
      mkItem('a', { depends_on: ['c'] }),
      mkItem('b', { depends_on: ['a'] }),
      mkItem('c', { depends_on: ['b'] }),
    ]);
    const errors = validateRun(run);
    expect(errors.some((e) => /cycle/i.test(e))).toBe(true);
  });

  it('names the item/edge in each structural error', () => {
    const run = mkRun([mkItem('b', { depends_on: ['missing'] })]);
    const errors = validateRun(run);
    // each error should name something (not be an empty string)
    expect(errors.every((e) => e.length > 0)).toBe(true);
  });

  it('reports both cycles in two disconnected cycle components (a->b->a and c->d->c)', () => {
    const run = mkRun([
      mkItem('a', { depends_on: ['b'] }),
      mkItem('b', { depends_on: ['a'] }),
      mkItem('c', { depends_on: ['d'] }),
      mkItem('d', { depends_on: ['c'] }),
    ]);
    const errors = validateRun(run);
    const cycleErrors = errors.filter((e) => /cycle/i.test(e));
    expect(cycleErrors.length).toBeGreaterThanOrEqual(2);
  });

  it('detects a self-cycle (a depends on itself)', () => {
    const run = mkRun([mkItem('a', { depends_on: ['a'] })]);
    const errors = validateRun(run);
    expect(errors.some((e) => /cycle/i.test(e) && /a/.test(e))).toBe(true);
  });

  it('suppresses cycle detection when structural ref errors exist (unknown-ref + separate cycle)', () => {
    // 'ghost' is unknown (structural error); c->d->c is a cycle
    // The cycle should NOT be reported because structural errors exist
    const run = mkRun([
      mkItem('a', { depends_on: ['ghost'] }),
      mkItem('c', { depends_on: ['d'] }),
      mkItem('d', { depends_on: ['c'] }),
    ]);
    const errors = validateRun(run);
    expect(errors.some((e) => /ghost/.test(e))).toBe(true);   // ref error IS reported
    expect(errors.every((e) => !/cycle/i.test(e))).toBe(true); // cycle is NOT reported
  });
});

// ---- validateRun — pack-aware checks ----

describe('validateRun — with packs', () => {
  it('flags unknown subagentShape id', () => {
    const run = mkRun([mkItem('a', { subagentShape: 'dev.no-exist' })]);
    const errors = validateRun(run, devRegistry());
    expect(errors.some((e) => /dev\.no-exist/.test(e))).toBe(true);
  });

  it('does not flag a valid subagentShape', () => {
    const run = mkRun([mkItem('a', { subagentShape: 'dev.code-edit' })]);
    expect(validateRun(run, devRegistry())).toEqual([]);
  });

  it('items without subagentShape are never flagged for shape issues', () => {
    const run = mkRun([mkItem('a')]);
    expect(validateRun(run, devRegistry())).toEqual([]);
  });

  it('flags an edge whose declared tags mismatch', () => {
    // upstream shape outputEdgeType 'patch-ref'; downstream inputEdgeTypes.x = 'dataset-ref'
    const upstreamShape = makeShape({ id: 'dev.up', outputEdgeType: 'patch-ref' });
    const downstreamShape = makeShape({ id: 'dev.down', inputEdgeTypes: { x: 'dataset-ref' } });
    const packs = new PackRegistry([upstreamShape, downstreamShape]);

    const run = normalizeRun(mkRun([
      mkItem('upstream-item', { subagentShape: 'dev.up' }),
      mkItem('downstream-item', {
        subagentShape: 'dev.down',
        depends_on: ['upstream-item'],
        needs: { x: { from: 'upstream-item', select: { kind: 'patch' } } },
      }),
    ]));

    const errors = validateRun(run, packs);
    expect(errors.some((e) => /incompatible.*adapter block/i.test(e) || /incompatible/i.test(e) && /adapter block/i.test(e))).toBe(true);
  });

  it('names the edge in a tag mismatch error', () => {
    const upstreamShape = makeShape({ id: 'dev.up', outputEdgeType: 'patch-ref' });
    const downstreamShape = makeShape({ id: 'dev.down', inputEdgeTypes: { x: 'dataset-ref' } });
    const packs = new PackRegistry([upstreamShape, downstreamShape]);

    const run = normalizeRun(mkRun([
      mkItem('up', { subagentShape: 'dev.up' }),
      mkItem('down', {
        subagentShape: 'dev.down',
        depends_on: ['up'],
        needs: { x: { from: 'up', select: { kind: 'patch' } } },
      }),
    ]));

    const errors = validateRun(run, packs);
    // error should mention the edge and the key
    expect(errors.some((e) => /up->down/.test(e) || (/up/.test(e) && /down/.test(e)))).toBe(true);
    expect(errors.some((e) => /x/.test(e))).toBe(true);
  });

  it('no tag error when upstream lacks outputEdgeType (permissive)', () => {
    const upstreamShape = makeShape({ id: 'dev.up' }); // no outputEdgeType
    const downstreamShape = makeShape({ id: 'dev.down', inputEdgeTypes: { patch: 'patch-ref' } });
    const packs = new PackRegistry([upstreamShape, downstreamShape]);

    const run = normalizeRun(mkRun([
      mkItem('up', { subagentShape: 'dev.up' }),
      mkItem('down', {
        subagentShape: 'dev.down',
        depends_on: ['up'],
        needs: { patch: { from: 'up', select: { kind: 'patch' } } },
      }),
    ]));

    expect(validateRun(run, packs)).toEqual([]);
  });

  it('no tag error when downstream lacks inputEdgeTypes (permissive)', () => {
    const upstreamShape = makeShape({ id: 'dev.up', outputEdgeType: 'patch-ref' });
    const downstreamShape = makeShape({ id: 'dev.down' }); // no inputEdgeTypes
    const packs = new PackRegistry([upstreamShape, downstreamShape]);

    const run = normalizeRun(mkRun([
      mkItem('up', { subagentShape: 'dev.up' }),
      mkItem('down', {
        subagentShape: 'dev.down',
        depends_on: ['up'],
        needs: { patch: { from: 'up', select: { kind: 'patch' } } },
      }),
    ]));

    expect(validateRun(run, packs)).toEqual([]);
  });

  it('no tag error when BOTH tags match', () => {
    const upstreamShape = makeShape({ id: 'dev.up', outputEdgeType: 'patch-ref' });
    const downstreamShape = makeShape({ id: 'dev.down', inputEdgeTypes: { patch: 'patch-ref' } });
    const packs = new PackRegistry([upstreamShape, downstreamShape]);

    const run = normalizeRun(mkRun([
      mkItem('up', { subagentShape: 'dev.up' }),
      mkItem('down', {
        subagentShape: 'dev.down',
        depends_on: ['up'],
        needs: { patch: { from: 'up', select: { kind: 'patch' } } },
      }),
    ]));

    expect(validateRun(run, packs)).toEqual([]);
  });

  it('no tag error when either/both items lack subagentShape', () => {
    // upstream has no shape at all, downstream has inputEdgeTypes
    const downstreamShape = makeShape({ id: 'dev.down', inputEdgeTypes: { patch: 'patch-ref' } });
    const packs = new PackRegistry([downstreamShape]);

    const run = normalizeRun(mkRun([
      mkItem('up'), // no subagentShape
      mkItem('down', {
        subagentShape: 'dev.down',
        depends_on: ['up'],
        needs: { patch: { from: 'up', select: { kind: 'patch' } } },
      }),
    ]));

    expect(validateRun(run, packs)).toEqual([]);
  });

  it('validateRun on a valid normalized dev-pack run returns []', () => {
    // code-edit -> verify via needs.patch
    const run = normalizeRun(mkRun([
      mkItem('edit', {
        subagentShape: 'dev.code-edit',
        inputs: { baseCommit: 'abc', instructions: 'fix bug' },
      }),
      mkItem('verify', {
        subagentShape: 'dev.verify',
        depends_on: ['edit'],
        needs: { patch: { from: 'edit', select: { kind: 'patch' } } },
      }),
    ]));

    expect(validateRun(run, devRegistry())).toEqual([]);
  });
});
