import { it, expect, describe } from 'vitest';
import { pipeline } from '../../src/patterns/pipeline.js';
import type { ItemState } from '../../src/contracts/types.js';
import type { GateConfig } from '../../src/contracts/pattern.js';

// ---------------------------------------------------------------------------
// plan — auto-chaining
// ---------------------------------------------------------------------------

describe('pipeline.plan — auto-chaining', () => {
  it('plan chains items lacking depends_on in submission order, leaving explicit deps alone', () => {
    const run = { id: 'r', queue: 'q', items: [
      { id: 'a', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] },
      { id: 'b', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] },
      { id: 'c', executor: 'x', inputs: {}, depends_on: ['a'], resourceLocks: [] },
    ] };
    const planned = pipeline.plan(run);
    expect(planned.items.map((i) => i.depends_on)).toEqual([[], ['a'], ['a']]);
  });

  it('first item always keeps empty depends_on', () => {
    const run = { id: 'r', queue: 'q', items: [
      { id: 'a', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] },
      { id: 'b', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] },
    ] };
    const planned = pipeline.plan(run);
    expect(planned.items[0]!.depends_on).toEqual([]);
    expect(planned.items[1]!.depends_on).toEqual(['a']);
  });

  it('does not mutate the input run object', () => {
    const item0 = { id: 'a', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] };
    const item1 = { id: 'b', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] };
    const run = { id: 'r', queue: 'q', items: [item0, item1] };
    pipeline.plan(run);
    expect(item0.depends_on).toEqual([]);
    expect(item1.depends_on).toEqual([]);
    expect(run.items.length).toBe(2);
  });

  it('single item keeps empty depends_on', () => {
    const run = { id: 'r', queue: 'q', items: [
      { id: 'a', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] },
    ] };
    const planned = pipeline.plan(run);
    expect(planned.items[0]!.depends_on).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// onTaskDone — gate policy
// ---------------------------------------------------------------------------

const makeGateItem = (
  id: string,
  status: ItemState['status'],
  overrides: Partial<ItemState> = {},
): ItemState => ({
  id,
  status,
  executor: 'x',
  inputs: {},
  depends_on: [],
  resourceLocks: [],
  runId: 'r1',
  queue: 'q',
  ...overrides,
});

const gateConfig: GateConfig = {
  onRed: 'spawn-fix',
  subject: 'implement',
  fixTemplate: { executor: 'fixer', inputs: {} },
};

describe('pipeline.onTaskDone — returns null (no spawn)', () => {
  it('returns null for non-gate items (no inputs.gate)', () => {
    const item = makeGateItem('step1', 'failed');
    const result = pipeline.onTaskDone(item, { runItems: [item] });
    expect(result).toBeNull();
  });

  it('returns null when onRed is "advance"', () => {
    const advanceConfig: GateConfig = { ...gateConfig, onRed: 'advance' };
    const item = makeGateItem('gate1', 'failed', { inputs: { gate: advanceConfig } });
    const result = pipeline.onTaskDone(item, { runItems: [item] });
    expect(result).toBeNull();
  });

  it('returns null for green gates (done + verify.passed === true)', () => {
    const item = makeGateItem('gate1', 'done', {
      inputs: { gate: gateConfig },
      verify: { passed: true },
    });
    const result = pipeline.onTaskDone(item, { runItems: [item] });
    expect(result).toBeNull();
  });

  it('returns null for green gates (done + no verify)', () => {
    const item = makeGateItem('gate1', 'done', {
      inputs: { gate: gateConfig },
    });
    const result = pipeline.onTaskDone(item, { runItems: [item] });
    expect(result).toBeNull();
  });

  it('returns null for cancelled causes', () => {
    const item = makeGateItem('gate1', 'cancelled', { inputs: { gate: gateConfig } });
    const result = pipeline.onTaskDone(item, { runItems: [item] });
    expect(result).toBeNull();
  });

  it('returns null when respawnLineage returns [] (no fixTemplate)', () => {
    const configNoTemplate: GateConfig = { onRed: 'spawn-fix', subject: 'implement' };
    const item = makeGateItem('gate1', 'failed', { inputs: { gate: configNoTemplate } });
    const implementItem = makeGateItem('implement', 'done');
    const result = pipeline.onTaskDone(item, { runItems: [item, implementItem] });
    expect(result).toBeNull();
  });
});

describe('pipeline.onTaskDone — spawns on red gate', () => {
  it('spawns when gate status is "failed"', () => {
    const implementItem = makeGateItem('implement', 'done');
    const gateItem = makeGateItem('gate1', 'failed', {
      inputs: { gate: gateConfig },
      depends_on: ['implement'],
    });
    const result = pipeline.onTaskDone(gateItem, { runItems: [implementItem, gateItem] });
    expect(result).not.toBeNull();
    expect(result!.items.length).toBeGreaterThan(0);
  });

  it('spawns when gate is done with verify.passed === false', () => {
    const implementItem = makeGateItem('implement', 'done');
    const gateItem = makeGateItem('gate1', 'done', {
      inputs: { gate: gateConfig },
      depends_on: ['implement'],
      verify: { passed: false },
    });
    const result = pipeline.onTaskDone(gateItem, { runItems: [implementItem, gateItem] });
    expect(result).not.toBeNull();
    expect(result!.items.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Replay: determinism
// ---------------------------------------------------------------------------

describe('pipeline.onTaskDone — determinism (replay)', () => {
  it('returns deeply-equal directives when called twice with same args', () => {
    const implementItem = makeGateItem('implement', 'done');
    const gateItem = makeGateItem('gate1', 'failed', {
      inputs: { gate: gateConfig },
      depends_on: ['implement'],
    });
    const ctx = { runItems: [implementItem, gateItem] };
    const r1 = pipeline.onTaskDone(gateItem, ctx);
    const r2 = pipeline.onTaskDone(gateItem, ctx);
    expect(r1).toEqual(r2);
  });
});
