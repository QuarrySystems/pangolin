import { it, expect, describe } from 'vitest';
import { mapReduce } from '../../src/patterns/map-reduce.js';
import type { ItemState } from '../../src/contracts/types.js';
import type { Run } from '../../src/contracts/types.js';

// ---------------------------------------------------------------------------
// plan() — validation
// ---------------------------------------------------------------------------
describe('plan()', () => {
  it('passes through a run with zero splitters unchanged', () => {
    const run: Run = { id: 'r', queue: 'q', items: [{ id: 'a', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] }] };
    expect(mapReduce.plan(run)).toBe(run);
  });

  it('passes through a run with a valid MapReduceConfig splitter', () => {
    const run: Run = {
      id: 'r', queue: 'q',
      items: [{
        id: 'split', executor: 'x', depends_on: [], resourceLocks: [],
        inputs: { mapReduce: { map: { executor: 'x', inputs: {} }, reduce: { executor: 'x', inputs: {} } } },
      }],
    };
    expect(mapReduce.plan(run)).toBe(run);
  });

  it('throws a descriptive error when there are more than one splitter', () => {
    const run: Run = {
      id: 'r', queue: 'q',
      items: [
        { id: 'split1', executor: 'x', depends_on: [], resourceLocks: [], inputs: { mapReduce: { map: { executor: 'x', inputs: {} }, reduce: { executor: 'x', inputs: {} } } } },
        { id: 'split2', executor: 'x', depends_on: [], resourceLocks: [], inputs: { mapReduce: { map: { executor: 'x', inputs: {} }, reduce: { executor: 'x', inputs: {} } } } },
      ],
    };
    expect(() => mapReduce.plan(run)).toThrow(/map-reduce.*splitter/i);
  });

  it('throws when mapReduce config is not an object', () => {
    const run: Run = {
      id: 'r', queue: 'q',
      items: [{ id: 'split', executor: 'x', depends_on: [], resourceLocks: [], inputs: { mapReduce: 'bad' } }],
    };
    expect(() => mapReduce.plan(run)).toThrow();
  });

  it('throws a descriptive error when map template is missing', () => {
    const run: Run = {
      id: 'r', queue: 'q',
      items: [{ id: 'split', executor: 'x', depends_on: [], resourceLocks: [], inputs: { mapReduce: { reduce: { executor: 'x', inputs: {} } } } }],
    };
    expect(() => mapReduce.plan(run)).toThrow(/map/i);
  });

  it('throws a descriptive error when reduce template is missing', () => {
    const run: Run = {
      id: 'r', queue: 'q',
      items: [{ id: 'split', executor: 'x', depends_on: [], resourceLocks: [], inputs: { mapReduce: { map: { executor: 'x', inputs: {} } } } }],
    };
    expect(() => mapReduce.plan(run)).toThrow(/reduce/i);
  });

  it('throws when map template is missing executor', () => {
    const run: Run = {
      id: 'r', queue: 'q',
      items: [{ id: 'split', executor: 'x', depends_on: [], resourceLocks: [], inputs: { mapReduce: { map: { inputs: {} }, reduce: { executor: 'x', inputs: {} } } } }],
    };
    expect(() => mapReduce.plan(run)).toThrow(/executor/i);
  });

  it('throws when map template is missing inputs', () => {
    const run: Run = {
      id: 'r', queue: 'q',
      items: [{ id: 'split', executor: 'x', depends_on: [], resourceLocks: [], inputs: { mapReduce: { map: { executor: 'x' }, reduce: { executor: 'x', inputs: {} } } } }],
    };
    expect(() => mapReduce.plan(run)).toThrow(/inputs/i);
  });

  it('throws when reduce template is missing inputs', () => {
    const run: Run = {
      id: 'r', queue: 'q',
      items: [{ id: 'split', executor: 'x', depends_on: [], resourceLocks: [], inputs: { mapReduce: { map: { executor: 'x', inputs: {} }, reduce: { executor: 'x' } } } }],
    };
    expect(() => mapReduce.plan(run)).toThrow(/inputs/i);
  });

  it('throws when reduce template is missing executor', () => {
    const run: Run = {
      id: 'r', queue: 'q',
      items: [{ id: 'split', executor: 'x', depends_on: [], resourceLocks: [], inputs: { mapReduce: { map: { executor: 'x', inputs: {} }, reduce: { inputs: {} } } } }],
    };
    expect(() => mapReduce.plan(run)).toThrow(/executor/i);
  });
});

// ---------------------------------------------------------------------------
// onTaskDone() — phase 1: splitter done → spawn maps
// ---------------------------------------------------------------------------
describe('onTaskDone() — phase 1: splitter done', () => {
  it('spawns one map per splitter outputRefs key with concrete needs bindings', () => {
    const splitter = {
      id: 'split', status: 'done', executor: 'x', depends_on: [], resourceLocks: [],
      inputs: { mapReduce: { map: { executor: 'x', inputs: {} }, reduce: { executor: 'x', inputs: {} } } },
      outputRefs: { 'b.json': 'agora://b', 'a.json': 'agora://a' },
    } as never as ItemState;
    const d = mapReduce.onTaskDone(splitter, { runItems: [splitter] });
    expect(d).not.toBeNull();
    expect(d!.items.map((i) => i.id)).toEqual(['map-a.json', 'map-b.json']);   // sorted, deterministic
    expect(d!.items[0]!.needs!['input']).toEqual({ from: 'split', select: { kind: 'output', path: 'a.json' } });
    expect(d!.items[1]!.needs!['input']).toEqual({ from: 'split', select: { kind: 'output', path: 'b.json' } });
  });

  it('uses custom needsKey when specified', () => {
    const splitter = {
      id: 'split', status: 'done', executor: 'x', depends_on: [], resourceLocks: [],
      inputs: { mapReduce: { map: { executor: 'x', inputs: {}, needsKey: 'item' }, reduce: { executor: 'x', inputs: {} } } },
      outputRefs: { 'x.json': 'agora://x' },
    } as never as ItemState;
    const d = mapReduce.onTaskDone(splitter, { runItems: [splitter] });
    expect(d!.items[0]!.needs!['item']).toBeDefined();
    expect(d!.items[0]!.needs!['input']).toBeUndefined();
  });

  it('sets empty depends_on and resourceLocks from config on map items', () => {
    const splitter = {
      id: 'split', status: 'done', executor: 'x', depends_on: [], resourceLocks: [],
      inputs: { mapReduce: { map: { executor: 'x', inputs: {}, resourceLocks: ['lock1'] }, reduce: { executor: 'x', inputs: {} } } },
      outputRefs: { 'f.json': 'agora://f' },
    } as never as ItemState;
    const d = mapReduce.onTaskDone(splitter, { runItems: [splitter] });
    expect(d!.items[0]!.depends_on).toEqual([]);
    expect(d!.items[0]!.resourceLocks).toEqual(['lock1']);
  });

  it('returns null when splitter is not yet done', () => {
    const splitter = {
      id: 'split', status: 'running', executor: 'x', depends_on: [], resourceLocks: [],
      inputs: { mapReduce: { map: { executor: 'x', inputs: {} }, reduce: { executor: 'x', inputs: {} } } },
      outputRefs: { 'a.json': 'agora://a' },
    } as never as ItemState;
    const d = mapReduce.onTaskDone(splitter, { runItems: [splitter] });
    expect(d).toBeNull();
  });

  it('returns null when outputRefs is empty', () => {
    const splitter = {
      id: 'split', status: 'done', executor: 'x', depends_on: [], resourceLocks: [],
      inputs: { mapReduce: { map: { executor: 'x', inputs: {} }, reduce: { executor: 'x', inputs: {} } } },
      outputRefs: {},
    } as never as ItemState;
    const d = mapReduce.onTaskDone(splitter, { runItems: [splitter] });
    expect(d).toBeNull();
  });

  it('returns null when outputRefs is absent', () => {
    const splitter = {
      id: 'split', status: 'done', executor: 'x', depends_on: [], resourceLocks: [],
      inputs: { mapReduce: { map: { executor: 'x', inputs: {} }, reduce: { executor: 'x', inputs: {} } } },
    } as never as ItemState;
    const d = mapReduce.onTaskDone(splitter, { runItems: [splitter] });
    expect(d).toBeNull();
  });

  it('returns null when item is cancelled', () => {
    const splitter = {
      id: 'split', status: 'cancelled', executor: 'x', depends_on: [], resourceLocks: [],
      inputs: { mapReduce: { map: { executor: 'x', inputs: {} }, reduce: { executor: 'x', inputs: {} } } },
      outputRefs: { 'a.json': 'agora://a' },
    } as never as ItemState;
    const d = mapReduce.onTaskDone(splitter, { runItems: [splitter] });
    expect(d).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// onTaskDone() — phase 2: all maps done → spawn reduce
// ---------------------------------------------------------------------------
describe('onTaskDone() — phase 2: all maps done → spawn reduce', () => {
  const makeSplitter = (overrides?: Partial<ItemState>) => ({
    id: 'split', status: 'done', executor: 'x', depends_on: [], resourceLocks: [],
    inputs: { mapReduce: { map: { executor: 'mapExec', inputs: { mapProp: 1 } }, reduce: { executor: 'reduceExec', inputs: { reduceProp: 2 } } } },
    outputRefs: { 'a.json': 'agora://a', 'b.json': 'agora://b' },
    ...overrides,
  } as never as ItemState);

  const makeMap = (key: string, status: string = 'done') => ({
    id: `map-${key}`, status, executor: 'mapExec', depends_on: [], resourceLocks: [],
    inputs: { mapProp: 1 },
  } as never as ItemState);

  it('spawns reduce when all maps are done and no reduce exists', () => {
    const splitter = makeSplitter();
    const mapA = makeMap('a.json');
    const mapB = makeMap('b.json');
    const ctx = { runItems: [splitter, mapA, mapB] };
    const d = mapReduce.onTaskDone(mapB, ctx);
    expect(d).not.toBeNull();
    expect(d!.items).toHaveLength(1);
    expect(d!.items[0]!.id).toBe('reduce');
    expect(d!.items[0]!.executor).toBe('reduceExec');
  });

  it('reduce needs cover all map keys with default keyPrefix "part" and default outputPath "result"', () => {
    const splitter = makeSplitter();
    const mapA = makeMap('a.json');
    const mapB = makeMap('b.json');
    const ctx = { runItems: [splitter, mapA, mapB] };
    const d = mapReduce.onTaskDone(mapB, ctx);
    expect(d!.items[0]!.needs!['part-a.json']).toEqual({ from: 'map-a.json', select: { kind: 'output', path: 'result' } });
    expect(d!.items[0]!.needs!['part-b.json']).toEqual({ from: 'map-b.json', select: { kind: 'output', path: 'result' } });
  });

  it('respects custom keyPrefix and outputPath', () => {
    const splitter = {
      id: 'split', status: 'done', executor: 'x', depends_on: [], resourceLocks: [],
      inputs: { mapReduce: {
        map: { executor: 'x', inputs: {}, outputPath: 'out.json' },
        reduce: { executor: 'x', inputs: {}, keyPrefix: 'chunk' },
      } },
      outputRefs: { 'f.json': 'agora://f' },
    } as never as ItemState;
    const mapF = makeMap('f.json');
    const ctx = { runItems: [splitter, mapF] };
    const d = mapReduce.onTaskDone(mapF, ctx);
    expect(d!.items[0]!.needs!['chunk-f.json']).toEqual({ from: 'map-f.json', select: { kind: 'output', path: 'out.json' } });
  });

  it('does not spawn reduce when a reduce already exists', () => {
    const splitter = makeSplitter();
    const mapA = makeMap('a.json');
    const mapB = makeMap('b.json');
    const existingReduce = { id: 'reduce', status: 'running', executor: 'x', depends_on: [], resourceLocks: [], inputs: {} } as never as ItemState;
    const ctx = { runItems: [splitter, mapA, mapB, existingReduce] };
    const d = mapReduce.onTaskDone(mapB, ctx);
    expect(d).toBeNull();
  });

  it('does not spawn reduce when not all maps are done', () => {
    const splitter = makeSplitter();
    const mapA = makeMap('a.json', 'done');
    const mapB = makeMap('b.json', 'running');
    const ctx = { runItems: [splitter, mapA, mapB] };
    const d = mapReduce.onTaskDone(mapA, ctx);
    expect(d).toBeNull();
  });

  it('does not spawn reduce when a map has failed', () => {
    const splitter = makeSplitter();
    const mapA = makeMap('a.json', 'failed');
    const mapB = makeMap('b.json', 'done');
    const ctx = { runItems: [splitter, mapA, mapB] };
    const d = mapReduce.onTaskDone(mapB, ctx);
    expect(d).toBeNull();
  });

  it('does not spawn reduce when a map is skipped', () => {
    const splitter = makeSplitter();
    const mapA = makeMap('a.json', 'skipped');
    const mapB = makeMap('b.json', 'done');
    const ctx = { runItems: [splitter, mapA, mapB] };
    const d = mapReduce.onTaskDone(mapB, ctx);
    expect(d).toBeNull();
  });

  it('is deterministic — same ctx produces deeply-equal results (idempotent)', () => {
    const splitter = makeSplitter();
    const mapA = makeMap('a.json');
    const mapB = makeMap('b.json');
    const ctx = { runItems: [splitter, mapA, mapB] };
    const d1 = mapReduce.onTaskDone(mapB, ctx);
    const d2 = mapReduce.onTaskDone(mapB, ctx);
    expect(d1).toEqual(d2);
  });

  it('spawned reduce carries executor and inputs from reduce template', () => {
    const splitter = makeSplitter();
    const mapA = makeMap('a.json');
    const mapB = makeMap('b.json');
    const ctx = { runItems: [splitter, mapA, mapB] };
    const d = mapReduce.onTaskDone(mapB, ctx);
    expect(d!.items[0]!.executor).toBe('reduceExec');
    expect(d!.items[0]!.inputs).toEqual({ reduceProp: 2 });
  });

  it('returns null when the current item is not a splitter and no splitter in runItems', () => {
    const someItem = { id: 'task1', status: 'done', executor: 'x', depends_on: [], resourceLocks: [], inputs: {} } as never as ItemState;
    const d = mapReduce.onTaskDone(someItem, { runItems: [someItem] });
    expect(d).toBeNull();
  });

  it('an unrelated done item does not trigger reduce even when all maps are done', () => {
    const splitter = makeSplitter();
    const mapA = makeMap('a.json');
    const mapB = makeMap('b.json');
    const preflight = { id: 'preflight', status: 'done', executor: 'x', depends_on: [], resourceLocks: [], inputs: {} } as never as ItemState;
    const ctx = { runItems: [splitter, mapA, mapB, preflight] };
    // The unrelated 'preflight' item completing should NOT spawn reduce
    const d = mapReduce.onTaskDone(preflight, ctx);
    expect(d).toBeNull();
    // But the last map's callback SHOULD spawn reduce
    const d2 = mapReduce.onTaskDone(mapB, ctx);
    expect(d2).not.toBeNull();
    expect(d2!.items[0]!.id).toBe('reduce');
  });
});
