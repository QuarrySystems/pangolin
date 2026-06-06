import { it, expect, describe } from 'vitest';
import { respawnLineage, parseAttempt } from '../../src/patterns/respawn.js';
import type { ItemState } from '../../src/contracts/types.js';
import type { GateConfig } from '../../src/contracts/pattern.js';

// ---------------------------------------------------------------------------
// parseAttempt
// ---------------------------------------------------------------------------

describe('parseAttempt', () => {
  it('returns attempt 1 for plain id', () => {
    expect(parseAttempt('review')).toEqual({ base: 'review', attempt: 1 });
  });

  it('returns attempt 2 for id~2', () => {
    expect(parseAttempt('review~2')).toEqual({ base: 'review', attempt: 2 });
  });

  it('returns attempt 10 for id~10', () => {
    expect(parseAttempt('review~10')).toEqual({ base: 'review', attempt: 10 });
  });

  it('handles base with dashes', () => {
    expect(parseAttempt('my-gate~3')).toEqual({ base: 'my-gate', attempt: 3 });
  });
});

// ---------------------------------------------------------------------------
// respawnLineage — guard cases (returns [])
// ---------------------------------------------------------------------------

describe('respawnLineage guard cases', () => {
  const baseItems: ItemState[] = [
    { id: 'implement', status: 'done', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [], runId: 'r1', queue: 'q' },
    { id: 'review', status: 'failed', reason: 'red', executor: 'x', inputs: {}, depends_on: ['implement'], resourceLocks: [], runId: 'r1', queue: 'q' },
    { id: 'package', status: 'skipped', executor: 'x', inputs: {}, depends_on: ['review'], resourceLocks: [], runId: 'r1', queue: 'q' },
  ];

  const baseConfig: GateConfig = {
    onRed: 'spawn-fix',
    subject: 'implement',
    fixTemplate: { executor: 'x', inputs: {} },
  };

  it('returns [] when fixTemplate is missing', () => {
    const result = respawnLineage({
      gate: baseItems[1]!,
      config: { onRed: 'spawn-fix', subject: 'implement' },
      runItems: baseItems,
    });
    expect(result).toEqual([]);
  });

  it('returns [] when attempt exceeds maxFixAttempts (default 1)', () => {
    // gate is review~2 -> attempt=2, maxFixAttempts defaults to 1
    const items: ItemState[] = [
      { id: 'implement', status: 'done', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [], runId: 'r1', queue: 'q' },
      { id: 'review~2', status: 'failed', reason: 'red', executor: 'x', inputs: {}, depends_on: ['review-fix-1'], resourceLocks: [], runId: 'r1', queue: 'q' },
    ];
    const result = respawnLineage({
      gate: items[1]!,
      config: baseConfig,
      runItems: items,
    });
    expect(result).toEqual([]);
  });

  it('returns [] when attempt exceeds explicit maxFixAttempts', () => {
    // review~4 = attempt 4, maxFixAttempts=3 -> 4 > 3 -> should not spawn
    const items: ItemState[] = [
      { id: 'implement', status: 'done', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [], runId: 'r1', queue: 'q' },
      { id: 'review~4', status: 'failed', reason: 'red', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [], runId: 'r1', queue: 'q' },
    ];
    const result = respawnLineage({
      gate: items[1]!,
      config: { ...baseConfig, maxFixAttempts: 3 },
      runItems: items,
    });
    expect(result).toEqual([]);
  });

  it('returns [] when gate itself is cancelled', () => {
    const items: ItemState[] = [
      { id: 'implement', status: 'done', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [], runId: 'r1', queue: 'q' },
      { id: 'review', status: 'cancelled', executor: 'x', inputs: {}, depends_on: ['implement'], resourceLocks: [], runId: 'r1', queue: 'q' },
    ];
    const result = respawnLineage({
      gate: items[1]!,
      config: baseConfig,
      runItems: items,
    });
    expect(result).toEqual([]);
  });

  it('returns [] when a skipped descendant is cancelled', () => {
    const items: ItemState[] = [
      { id: 'implement', status: 'done', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [], runId: 'r1', queue: 'q' },
      { id: 'review', status: 'failed', reason: 'red', executor: 'x', inputs: {}, depends_on: ['implement'], resourceLocks: [], runId: 'r1', queue: 'q' },
      { id: 'package', status: 'cancelled', executor: 'x', inputs: {}, depends_on: ['review'], resourceLocks: [], runId: 'r1', queue: 'q' },
    ];
    const result = respawnLineage({
      gate: items[1]!,
      config: baseConfig,
      runItems: items,
    });
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// respawnLineage — main acceptance criterion (task spec test)
// ---------------------------------------------------------------------------

it('failed gate respawns fix + gate~2 + skipped descendants~2 with edges remapped through S', () => {
  const items = [
    { id: 'implement', status: 'done', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] },
    { id: 'review', status: 'failed', reason: 'red', executor: 'x', inputs: {}, depends_on: ['implement'], resourceLocks: [],
      needs: { work: { from: 'implement', select: { kind: 'patch' } } } },
    { id: 'package', status: 'skipped', executor: 'x', inputs: {}, depends_on: ['review'], resourceLocks: [],
      needs: { work: { from: 'implement', select: { kind: 'patch' } } } },
  ] as never[];
  const out = respawnLineage({
    gate: items[1] as never,
    config: { onRed: 'spawn-fix', subject: 'implement', fixTemplate: { executor: 'x', inputs: {} } },
    runItems: items,
  });
  const ids = out.map((w) => w.id).sort();
  expect(ids).toEqual(['package~2', 'review-fix-1', 'review~2']);
  const pkg = out.find((w) => w.id === 'package~2')!;
  expect(pkg.depends_on).toEqual(['review~2']);                       // gate -> gate copy
  expect(pkg.needs!['work']!.from).toBe('review-fix-1');              // subject -> fix
});

// ---------------------------------------------------------------------------
// respawnLineage — attempt ~2 (second round)
// ---------------------------------------------------------------------------

it('review~2 failing yields review-fix-2 / review~3 / package~3', () => {
  const items: ItemState[] = [
    { id: 'implement', status: 'done', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [], runId: 'r1', queue: 'q' },
    { id: 'review-fix-1', status: 'done', executor: 'x', inputs: {}, depends_on: ['implement'], resourceLocks: [], runId: 'r1', queue: 'q' },
    { id: 'review~2', status: 'failed', reason: 'red', executor: 'x', inputs: {}, depends_on: ['review-fix-1'], resourceLocks: [], runId: 'r1', queue: 'q' },
    { id: 'package~2', status: 'skipped', executor: 'x', inputs: {}, depends_on: ['review~2'], resourceLocks: [], runId: 'r1', queue: 'q' },
  ];
  const out = respawnLineage({
    gate: items[2]!,
    config: { onRed: 'spawn-fix', subject: 'implement', fixTemplate: { executor: 'x', inputs: {} }, maxFixAttempts: 3 },
    runItems: items,
  });
  const ids = out.map((w) => w.id).sort();
  expect(ids).toEqual(['package~3', 'review-fix-2', 'review~3']);
});

// ---------------------------------------------------------------------------
// respawnLineage — failed gate has gateReason in fix inputs, NOT needs.findings
// ---------------------------------------------------------------------------

it('failed gate: fix has gateReason in inputs, no needs.findings', () => {
  const items: ItemState[] = [
    { id: 'implement', status: 'done', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [], runId: 'r1', queue: 'q' },
    { id: 'review', status: 'failed', reason: 'compilation error', executor: 'x', inputs: {}, depends_on: ['implement'], resourceLocks: [], runId: 'r1', queue: 'q' },
  ];
  const out = respawnLineage({
    gate: items[1]!,
    config: { onRed: 'spawn-fix', subject: 'implement', fixTemplate: { executor: 'x', inputs: {} } },
    runItems: items,
  });
  expect(out).toHaveLength(2); // fix + gate~2
  const fix = out.find((w) => w.id === 'review-fix-1')!;
  expect(fix.inputs['gateReason']).toBe('compilation error');
  expect(fix.needs?.['findings']).toBeUndefined();
});

// ---------------------------------------------------------------------------
// respawnLineage — done-but-red gate: fix gains needs.findings
// ---------------------------------------------------------------------------

it('done-but-red gate with outputRefs[findings]: fix gains needs.findings', () => {
  const items: ItemState[] = [
    { id: 'implement', status: 'done', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [], runId: 'r1', queue: 'q' },
    {
      id: 'review', status: 'done', executor: 'x', inputs: {}, depends_on: ['implement'], resourceLocks: [], runId: 'r1', queue: 'q',
      verify: { passed: false, report: 'red' },
      outputRefs: { findings: 'outputs/findings.json' },
    },
    { id: 'package', status: 'pending', executor: 'x', inputs: {}, depends_on: ['review'], resourceLocks: [], runId: 'r1', queue: 'q' },
  ];
  const out = respawnLineage({
    gate: items[1]!,
    config: { onRed: 'spawn-fix', subject: 'implement', fixTemplate: { executor: 'x', inputs: {} } },
    runItems: items,
  });
  const fix = out.find((w) => w.id === 'review-fix-1')!;
  expect(fix).toBeDefined();
  expect(fix.needs?.['findings']).toEqual({ from: 'review', select: { kind: 'output', path: 'findings' } });
  expect(fix.inputs['gateReason']).toBeUndefined();
});

it('done gate with green verify (passed: true) must NOT respawn', () => {
  const items: ItemState[] = [
    { id: 'implement', status: 'done', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [], runId: 'r1', queue: 'q' },
    {
      id: 'review', status: 'done', executor: 'x', inputs: {}, depends_on: ['implement'], resourceLocks: [], runId: 'r1', queue: 'q',
      verify: { passed: true },
    },
  ];
  const out = respawnLineage({
    gate: items[1]!,
    config: { onRed: 'spawn-fix', subject: 'implement', fixTemplate: { executor: 'x', inputs: {} } },
    runItems: items,
  });
  expect(out).toEqual([]);
});

// ---------------------------------------------------------------------------
// respawnLineage — fix needs.work binds subject's patch product
// ---------------------------------------------------------------------------

it('fix item needs.work binds subject patch product', () => {
  const items: ItemState[] = [
    { id: 'implement', status: 'done', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [], runId: 'r1', queue: 'q' },
    { id: 'review', status: 'failed', reason: 'red', executor: 'x', inputs: {}, depends_on: ['implement'], resourceLocks: [], runId: 'r1', queue: 'q' },
  ];
  const out = respawnLineage({
    gate: items[1]!,
    config: { onRed: 'spawn-fix', subject: 'implement', fixTemplate: { executor: 'x', inputs: {} } },
    runItems: items,
  });
  const fix = out.find((w) => w.id === 'review-fix-1')!;
  expect(fix.needs?.['work']).toEqual({ from: 'implement', select: { kind: 'patch' } });
});

// ---------------------------------------------------------------------------
// respawnLineage — determinism
// ---------------------------------------------------------------------------

it('is deterministic — two calls return deeply-equal arrays', () => {
  const items: ItemState[] = [
    { id: 'implement', status: 'done', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [], runId: 'r1', queue: 'q' },
    { id: 'review', status: 'failed', reason: 'red', executor: 'x', inputs: {}, depends_on: ['implement'], resourceLocks: [], runId: 'r1', queue: 'q' },
    { id: 'package', status: 'skipped', executor: 'x', inputs: {}, depends_on: ['review'], resourceLocks: [], runId: 'r1', queue: 'q' },
  ];
  const config: GateConfig = { onRed: 'spawn-fix', subject: 'implement', fixTemplate: { executor: 'x', inputs: {} } };
  const gate = items[1]!;
  const out1 = respawnLineage({ gate, config, runItems: items });
  const out2 = respawnLineage({ gate, config, runItems: items });
  expect(out1).toEqual(out2);
});

// ---------------------------------------------------------------------------
// respawnLineage — diamond downstream (copied exactly once)
// ---------------------------------------------------------------------------

it('diamond downstream: two skipped items depending on gate + one shared grandchild each copied once', () => {
  // Gate: review
  // review -> package-a (skipped)
  // review -> package-b (skipped)
  // package-a, package-b -> publish (skipped)
  const items: ItemState[] = [
    { id: 'implement', status: 'done', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [], runId: 'r1', queue: 'q' },
    { id: 'review', status: 'failed', reason: 'red', executor: 'x', inputs: {}, depends_on: ['implement'], resourceLocks: [], runId: 'r1', queue: 'q' },
    { id: 'package-a', status: 'skipped', executor: 'x', inputs: {}, depends_on: ['review'], resourceLocks: [], runId: 'r1', queue: 'q' },
    { id: 'package-b', status: 'skipped', executor: 'x', inputs: {}, depends_on: ['review'], resourceLocks: [], runId: 'r1', queue: 'q' },
    { id: 'publish', status: 'skipped', executor: 'x', inputs: {}, depends_on: ['package-a', 'package-b'], resourceLocks: [], runId: 'r1', queue: 'q' },
  ];
  const out = respawnLineage({
    gate: items[1]!,
    config: { onRed: 'spawn-fix', subject: 'implement', fixTemplate: { executor: 'x', inputs: {} } },
    runItems: items,
  });
  const ids = out.map((w) => w.id).sort();
  // fix + gate copy + 2 direct copies + 1 grandchild copy = 5 items
  expect(ids).toEqual(['package-a~2', 'package-b~2', 'publish~2', 'review-fix-1', 'review~2']);
  // verify publish~2 depends on both copies
  const publish = out.find((w) => w.id === 'publish~2')!;
  expect(publish.depends_on.sort()).toEqual(['package-a~2', 'package-b~2']);
});

// ---------------------------------------------------------------------------
// respawnLineage — copies preserve executor, inputs, subagentShape, resourceLocks
// ---------------------------------------------------------------------------

it('copies preserve static WorkItem fields from original', () => {
  const items: ItemState[] = [
    { id: 'implement', status: 'done', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [], runId: 'r1', queue: 'q' },
    { id: 'review', status: 'failed', reason: 'red', executor: 'gate-exec', inputs: { foo: 'bar' }, depends_on: ['implement'], resourceLocks: ['lock-a'], subagentShape: 'my-shape', runId: 'r1', queue: 'q' },
    { id: 'package', status: 'skipped', executor: 'pkg-exec', inputs: { baz: 1 }, depends_on: ['review'], resourceLocks: [], runId: 'r1', queue: 'q' },
  ];
  const out = respawnLineage({
    gate: items[1]!,
    config: { onRed: 'spawn-fix', subject: 'implement', fixTemplate: { executor: 'x', inputs: {} } },
    runItems: items,
  });
  const gateCopy = out.find((w) => w.id === 'review~2')!;
  expect(gateCopy.executor).toBe('gate-exec');
  expect(gateCopy.inputs).toEqual({ foo: 'bar' });
  expect(gateCopy.resourceLocks).toEqual(['lock-a']);
  expect(gateCopy.subagentShape).toBe('my-shape');
  // copies must NOT have runtime ItemState fields
  expect((gateCopy as Record<string, unknown>)['status']).toBeUndefined();
  expect((gateCopy as Record<string, unknown>)['runId']).toBeUndefined();
  expect((gateCopy as Record<string, unknown>)['reason']).toBeUndefined();

  const pkgCopy = out.find((w) => w.id === 'package~2')!;
  expect(pkgCopy.executor).toBe('pkg-exec');
  expect(pkgCopy.inputs).toEqual({ baz: 1 });
});

// ---------------------------------------------------------------------------
// respawnLineage — edges outside S are untouched
// ---------------------------------------------------------------------------

it('references to items outside S are untouched', () => {
  // package depends on both 'review' (in S) and 'shared-dep' (outside S, stays done)
  const items: ItemState[] = [
    { id: 'implement', status: 'done', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [], runId: 'r1', queue: 'q' },
    { id: 'shared-dep', status: 'done', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [], runId: 'r1', queue: 'q' },
    { id: 'review', status: 'failed', reason: 'red', executor: 'x', inputs: {}, depends_on: ['implement'], resourceLocks: [], runId: 'r1', queue: 'q' },
    {
      id: 'package', status: 'skipped', executor: 'x', inputs: {}, depends_on: ['review', 'shared-dep'], resourceLocks: [], runId: 'r1', queue: 'q',
      needs: { shared: { from: 'shared-dep', select: { kind: 'patch' } } },
    },
  ];
  const out = respawnLineage({
    gate: items[2]!,
    config: { onRed: 'spawn-fix', subject: 'implement', fixTemplate: { executor: 'x', inputs: {} } },
    runItems: items,
  });
  const pkg = out.find((w) => w.id === 'package~2')!;
  // review -> review~2, shared-dep stays as-is
  expect(pkg.depends_on.sort()).toEqual(['review~2', 'shared-dep']);
  // needs.shared.from points to shared-dep (not in S) → untouched
  expect(pkg.needs?.['shared']?.from).toBe('shared-dep');
});
