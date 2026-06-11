import { describe, it, expect } from 'vitest';
import { SqliteRunStateStore } from '../src/runstate/sqlite.js';
import type { Run } from '../src/contracts/index.js';

describe('run-state metadata', () => {
  it('stamps actor and starts attempts at zero', () => {
    const s = new SqliteRunStateStore(); s.ensureQueue('default', 1);
    s.saveRun({ id: 'r', queue: 'default', items: [
      { id: 'a', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] } ] }, 'human:brett');
    expect(s.getActor('a')).toBe('human:brett');
    expect(s.getAttempts('a')).toBe(0);
    s.bumpAttempt('a'); expect(s.getAttempts('a')).toBe(1);
  });
  it('round-trips an item saved without the new fields (backward compat)', () => {
    const s = new SqliteRunStateStore(); s.ensureQueue('default', 1);
    s.saveRun({ id: 'r', queue: 'default', items: [
      { id: 'a', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] } ] }); // no actor
    const item = s.getItems().find((i) => i.id === 'a')!;
    expect(item.actor).toBeUndefined();
    expect(item.attempts ?? 0).toBe(0);
    expect(item.nextAttemptAt).toBeUndefined();
  });
  it('requeue sets status to ready and stamps nextAttemptAt', () => {
    const s = new SqliteRunStateStore(); s.ensureQueue('default', 1);
    s.saveRun({ id: 'r', queue: 'default', items: [
      { id: 'a', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] } ] });
    const t = Date.now() + 5000;
    s.requeue('a', t);
    const item = s.getItems().find((i) => i.id === 'a')!;
    expect(item.status).toBe('ready');
    expect(item.nextAttemptAt).toBe(t);
  });
});

const run: Run = { id: 'r1', queue: 'default', items: [
  { id: 'a', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: ['f.ts'] },
] };

describe('SqliteRunStateStore', () => {
  it('saves a run and round-trips items as pending', () => {
    const s = new SqliteRunStateStore();
    s.saveRun(run);
    expect(s.getItems('r1')[0]).toMatchObject({ id: 'a', status: 'pending', runId: 'r1' });
    s.close();
  });

  it('round-trips all WorkItem fields correctly', () => {
    const s = new SqliteRunStateStore();
    const multiRun: Run = {
      id: 'r2',
      queue: 'fast',
      items: [
        { id: 'b', executor: 'shell', inputs: { cmd: 'echo hi' }, depends_on: ['a'], resourceLocks: ['x', 'y'] },
      ],
    };
    s.saveRun(multiRun);
    const items = s.getItems('r2');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'b',
      runId: 'r2',
      queue: 'fast',
      executor: 'shell',
      inputs: { cmd: 'echo hi' },
      depends_on: ['a'],
      resourceLocks: ['x', 'y'],
      status: 'pending',
    });
    s.close();
  });

  it('getItems with no runId returns all items across runs', () => {
    const s = new SqliteRunStateStore();
    s.saveRun({ id: 'r1', queue: 'q', items: [{ id: 'a', executor: 'e', inputs: {}, depends_on: [], resourceLocks: [] }] });
    s.saveRun({ id: 'r2', queue: 'q', items: [{ id: 'b', executor: 'e', inputs: {}, depends_on: [], resourceLocks: [] }] });
    expect(s.getItems()).toHaveLength(2);
    s.close();
  });

  it('acquireLocks is exclusive: a second holder of the same key fails atomically', () => {
    const s = new SqliteRunStateStore();
    expect(s.acquireLocks('a', ['f.ts'])).toBe(true);
    expect(s.acquireLocks('b', ['f.ts'])).toBe(false);
    expect(s.heldLockKeys()).toEqual(['f.ts']);
    s.releaseLocks('a');
    expect(s.acquireLocks('b', ['f.ts'])).toBe(true);
    s.close();
  });

  it('acquireLocks is all-or-nothing: partial acquisition does not happen', () => {
    const s = new SqliteRunStateStore();
    // A holds 'f.ts'
    expect(s.acquireLocks('a', ['f.ts'])).toBe(true);
    // B wants ['x', 'f.ts'] — 'f.ts' is held, so B gets false AND 'x' must NOT be acquired
    expect(s.acquireLocks('b', ['x', 'f.ts'])).toBe(false);
    const held = s.heldLockKeys();
    expect(held).not.toContain('x');
    expect(held).toContain('f.ts');
    s.close();
  });

  it('acquireLocks returns true for empty key list', () => {
    const s = new SqliteRunStateStore();
    expect(s.acquireLocks('a', [])).toBe(true);
    s.close();
  });

  it('markReady only promotes pending to ready (not other statuses)', () => {
    const s = new SqliteRunStateStore();
    s.saveRun({
      id: 'r1',
      queue: 'q',
      items: [
        { id: 'p', executor: 'e', inputs: {}, depends_on: [], resourceLocks: [] },
        { id: 'q', executor: 'e', inputs: {}, depends_on: [], resourceLocks: [] },
      ],
    });
    // Mark q as running first
    s.markReady(['q']);
    s.setRunning('q', 'hash123');
    // Now markReady on q again (it's running, should NOT change to ready)
    s.markReady(['q', 'p']);
    const items = s.getItems('r1');
    const qItem = items.find((i) => i.id === 'q')!;
    const pItem = items.find((i) => i.id === 'p')!;
    expect(qItem.status).toBe('running'); // unchanged
    expect(pItem.status).toBe('ready');   // was pending, now ready
    s.close();
  });

  it('setRunning persists dispatchHash', () => {
    const s = new SqliteRunStateStore();
    s.saveRun(run);
    s.markReady(['a']);
    s.setRunning('a', 'abc123');
    const item = s.getItems('r1')[0];
    expect(item.status).toBe('running');
    expect(item.dispatchHash).toBe('abc123');
    s.close();
  });

  it('setStatus sets terminal statuses', () => {
    const s = new SqliteRunStateStore();
    s.saveRun(run);
    s.setStatus('a', 'done');
    expect(s.getItems('r1')[0].status).toBe('done');

    s.setStatus('a', 'failed');
    expect(s.getItems('r1')[0].status).toBe('failed');

    s.setStatus('a', 'skipped');
    expect(s.getItems('r1')[0].status).toBe('skipped');
    s.close();
  });

  it('runningCount returns correct count per queue', () => {
    const s = new SqliteRunStateStore();
    s.saveRun({
      id: 'r1',
      queue: 'default',
      items: [
        { id: 'a', executor: 'e', inputs: {}, depends_on: [], resourceLocks: [] },
        { id: 'b', executor: 'e', inputs: {}, depends_on: [], resourceLocks: [] },
      ],
    });
    expect(s.runningCount('default')).toBe(0);
    s.markReady(['a', 'b']);
    s.setRunning('a', 'h1');
    expect(s.runningCount('default')).toBe(1);
    s.setRunning('b', 'h2');
    expect(s.runningCount('default')).toBe(2);
    s.setStatus('a', 'done');
    expect(s.runningCount('default')).toBe(1);
    s.close();
  });

  it('ensureQueue and queueConcurrency store and retrieve concurrency', () => {
    const s = new SqliteRunStateStore();
    s.ensureQueue('default', 4);
    expect(s.queueConcurrency('default')).toBe(4);
    // Update: same name, different concurrency
    s.ensureQueue('default', 8);
    expect(s.queueConcurrency('default')).toBe(8);
    // Unknown queue returns 0
    expect(s.queueConcurrency('nonexistent')).toBe(0);
    s.close();
  });

  it('round-trips subagentShape: set value is preserved', () => {
    const s = new SqliteRunStateStore();
    const shapeRun: Run = {
      id: 'r-shape',
      queue: 'default',
      items: [
        { id: 'item-with-shape', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: [], subagentShape: 'dev.code-edit' },
      ],
    };
    s.saveRun(shapeRun);
    const items = s.getItems('r-shape');
    expect(items).toHaveLength(1);
    expect(items[0].subagentShape).toBe('dev.code-edit');
    s.close();
  });

  it('round-trips subagentShape: unset field comes back as undefined (not null)', () => {
    const s = new SqliteRunStateStore();
    const noShapeRun: Run = {
      id: 'r-noshape',
      queue: 'default',
      items: [
        { id: 'item-no-shape', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: [] },
      ],
    };
    s.saveRun(noShapeRun);
    const items = s.getItems('r-noshape');
    expect(items).toHaveLength(1);
    expect(items[0].subagentShape).toBeUndefined();
    s.close();
  });

  it('persists and round-trips a failure reason on setStatus', () => {
    const s = new SqliteRunStateStore();
    s.saveRun({ id: 'r-reason', queue: 'default', items: [
      { id: 'item-reason', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: [] },
    ] });
    s.setStatus('item-reason', 'failed', 'inputs failed dev.code-edit schema');
    const items = s.getItems('r-reason');
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('failed');
    expect(items[0].reason).toBe('inputs failed dev.code-edit schema');
    s.close();
  });

  it('setStatus without a reason leaves reason undefined (not null)', () => {
    const s = new SqliteRunStateStore();
    s.saveRun({ id: 'r-noreason', queue: 'default', items: [
      { id: 'item-noreason', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: [] },
    ] });
    s.setStatus('item-noreason', 'done');
    const items = s.getItems('r-noreason');
    expect(items).toHaveLength(1);
    expect(items[0].reason).toBeUndefined();
    s.close();
  });

  it('persists and reads back result_ref, manifest_ref and submitted_at', () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 1);
    store.saveRun({ id: 'r1', queue: 'default', items: [
      { id: 'a', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] }] },
      'human:brett', '2026-05-31T00:00:00.000Z');
    store.setResultRef('a', 'pangolin://ns/artifact/a/sha256:deadbeef');
    store.setManifestRef('a', 'pangolin://ns/manifest/a/sha256:cafe');
    const it = store.getItems('r1').find((i) => i.id === 'a')!;
    expect(it.resultRef).toBe('pangolin://ns/artifact/a/sha256:deadbeef');
    expect(it.manifestRef).toBe('pangolin://ns/manifest/a/sha256:cafe');
    expect(it.submittedAt).toBe('2026-05-31T00:00:00.000Z');
  });

  it('persists and reads back verify (self-verify signal)', () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 1);
    store.saveRun({ id: 'rv', queue: 'default', items: [
      { id: 'a', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] }] });
    store.setVerify('a', { passed: false, report: 'tsc failed', durationMs: 12 });
    const it = store.getItems('rv').find((i) => i.id === 'a')!;
    expect(it.verify).toEqual({ passed: false, report: 'tsc failed', durationMs: 12 });
  });

  it('item without verify reads back undefined', () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 1);
    store.saveRun({ id: 'rnv', queue: 'default', items: [
      { id: 'b', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] }] });
    const it = store.getItems('rnv').find((i) => i.id === 'b')!;
    expect(it.verify).toBeUndefined();
  });

  it('persists and reads back outputRefs', () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 1);
    store.saveRun({ id: 'ro', queue: 'default', items: [
      { id: 'a', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] }] });
    store.setOutputRefs('a', { 'report.txt': 'pangolin://ns/artifact/d1/sha256:abc' });
    expect(store.getItems('ro').find((i) => i.id === 'a')!.outputRefs)
      .toEqual({ 'report.txt': 'pangolin://ns/artifact/d1/sha256:abc' });
  });

  it('item without outputRefs reads back undefined', () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 1);
    store.saveRun({ id: 'rno', queue: 'default', items: [
      { id: 'b', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] }] });
    const it = store.getItems('rno').find((i) => i.id === 'b')!;
    expect(it.outputRefs).toBeUndefined();
  });

  it('saveRun without submittedAt stores NULL — reads back as undefined', () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 1);
    store.saveRun({ id: 'r-nosub', queue: 'default', items: [
      { id: 'b', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] }] });
    const it = store.getItems('r-nosub').find((i) => i.id === 'b')!;
    expect(it.submittedAt).toBeUndefined();
    expect(it.resultRef).toBeUndefined();
    expect(it.manifestRef).toBeUndefined();
  });

  it('persists and reads back needs through saveRun', () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 1);
    store.saveRun({ id: 'rn', queue: 'default', items: [
      { id: 'b', executor: 'x', inputs: {}, depends_on: ['a'], resourceLocks: [],
        needs: { patch: { from: 'a', select: { kind: 'patch' } } } }] });
    expect(store.getItems('rn').find((i) => i.id === 'b')!.needs)
      .toEqual({ patch: { from: 'a', select: { kind: 'patch' } } });
  });

  it('item without needs reads back undefined', () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 1);
    store.saveRun({ id: 'rnn', queue: 'default', items: [
      { id: 'b', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] }] });
    const it = store.getItems('rnn').find((i) => i.id === 'b')!;
    expect(it.needs).toBeUndefined();
  });
});
