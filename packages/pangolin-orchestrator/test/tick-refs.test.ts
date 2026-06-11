// packages/pangolin-orchestrator/test/tick-refs.test.ts
import { describe, it, expect } from 'vitest';
import { tick } from '../src/engine/tick.js';
import { SqliteRunStateStore } from '../src/runstate/sqlite.js';
import type { Executor } from '../src/contracts/index.js';

it('persists manifestRef on fire and resultRef on a done reconcile', async () => {
  const store = new SqliteRunStateStore();
  store.ensureQueue('default', 1);
  store.saveRun({ id: 'r', queue: 'default', items: [
    { id: 'a', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] }] }, 'human:brett');
  store.markReady(['a']);
  const ex: Executor = { id: 'x',
    async fire() { return { dispatchHash: 'd', manifestRef: 'm' }; },
    async reconcile() { return { status: 'done' as const, resultRef: 'rr' }; } };
  await tick(store, { x: ex }, 'default', undefined, { maxAttempts: 1 }); // fires
  await tick(store, { x: ex }, 'default', undefined, { maxAttempts: 1 }); // reconciles
  const it = store.getItems().find((i) => i.id === 'a')!;
  expect(it.manifestRef).toBe('m');
  expect(it.resultRef).toBe('rr');
});

describe('tick refs — FireContext forwarding', () => {
  it('passes runId, actor, and submittedAt from the item to fire() as FireContext', async () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 1);
    // saveRun with actor + submittedAt so the item has those fields
    store.saveRun({ id: 'run-ctx', queue: 'default', items: [
      { id: 'ctx-item', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] },
    ] }, 'human:brett', '2026-05-31T00:00:00Z');
    store.markReady(['ctx-item']);

    let capturedCtx: unknown;
    const ex: Executor = {
      id: 'x',
      async fire(_item, ctx) {
        capturedCtx = ctx;
        return { dispatchHash: 'dh-ctx' };
      },
      async reconcile() { return { status: 'done' as const }; },
    };

    await tick(store, { x: ex }, 'default');
    expect(capturedCtx).toMatchObject({
      runId: 'run-ctx',
      actor: 'human:brett',
      submittedAt: '2026-05-31T00:00:00Z',
    });
  });

  it('does NOT persist resultRef on a failed reconcile', async () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 1);
    store.saveRun({ id: 'r-fail', queue: 'default', items: [
      { id: 'fail-item', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] },
    ] }, 'human:brett');
    store.markReady(['fail-item']);

    const ex: Executor = {
      id: 'x',
      async fire() { return { dispatchHash: 'dh-f', manifestRef: 'mf' }; },
      async reconcile() { return { status: 'failed' as const, resultRef: 'should-not-persist' }; },
    };

    await tick(store, { x: ex }, 'default', undefined, { maxAttempts: 1 }); // fire
    await tick(store, { x: ex }, 'default', undefined, { maxAttempts: 1 }); // reconcile -> failed

    const item = store.getItems().find((i) => i.id === 'fail-item')!;
    expect(item.status).toBe('failed');
    expect(item.resultRef).toBeUndefined();
    // manifestRef IS persisted on fire
    expect(item.manifestRef).toBe('mf');
  });

  it('does NOT persist outputRefs on a failed reconcile even if the result carries outputRefs', async () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 1);
    store.saveRun({ id: 'r-fail-orefs', queue: 'default', items: [
      { id: 'fail-orefs-item', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] },
    ] }, 'human:brett');
    store.markReady(['fail-orefs-item']);

    const ex: Executor = {
      id: 'x',
      async fire() { return { dispatchHash: 'dh-fo' }; },
      async reconcile() { return { status: 'failed' as const, outputRefs: { 'x.txt': 'pangolin://ns/artifact/d/sha256:ab' } }; },
    };

    await tick(store, { x: ex }, 'default', undefined, { maxAttempts: 1 }); // fire
    await tick(store, { x: ex }, 'default', undefined, { maxAttempts: 1 }); // reconcile -> failed (terminal)

    const item = store.getItems().find((i) => i.id === 'fail-orefs-item')!;
    expect(item.status).toBe('failed');
    expect(item.outputRefs).toBeUndefined();
  });

  it('persists outputRefs on a done reconcile that returns outputRefs', async () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 1);
    store.saveRun({ id: 'r-done-orefs', queue: 'default', items: [
      { id: 'done-orefs-item', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] },
    ] }, 'human:brett');
    store.markReady(['done-orefs-item']);

    const ex: Executor = {
      id: 'x',
      async fire() { return { dispatchHash: 'dh-do' }; },
      async reconcile() { return { status: 'done' as const, outputRefs: { 'report.txt': 'pangolin://ns/artifact/d/sha256:ab' } }; },
    };

    await tick(store, { x: ex }, 'default', undefined, { maxAttempts: 1 }); // fire
    await tick(store, { x: ex }, 'default', undefined, { maxAttempts: 1 }); // reconcile -> done with outputRefs

    const item = store.getItems().find((i) => i.id === 'done-orefs-item')!;
    expect(item.status).toBe('done');
    expect(item.outputRefs).toEqual({ 'report.txt': 'pangolin://ns/artifact/d/sha256:ab' });
  });

  it('does NOT persist outputRefs when a done reconcile has none', async () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 1);
    store.saveRun({ id: 'r-done-no-orefs', queue: 'default', items: [
      { id: 'done-no-orefs-item', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] },
    ] }, 'human:brett');
    store.markReady(['done-no-orefs-item']);

    const ex: Executor = {
      id: 'x',
      async fire() { return { dispatchHash: 'dh-dno' }; },
      async reconcile() { return { status: 'done' as const }; },
    };

    await tick(store, { x: ex }, 'default', undefined, { maxAttempts: 1 }); // fire
    await tick(store, { x: ex }, 'default', undefined, { maxAttempts: 1 }); // reconcile -> done, no outputRefs

    const item = store.getItems().find((i) => i.id === 'done-no-orefs-item')!;
    expect(item.status).toBe('done');
    expect(item.outputRefs).toBeUndefined();
  });

  it('does NOT persist resultRef on a requeued retry (not terminal done)', async () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 1);
    store.saveRun({ id: 'r-retry', queue: 'default', items: [
      { id: 'retry-item', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] },
    ] });
    store.markReady(['retry-item']);

    let callCount = 0;
    const ex: Executor = {
      id: 'x',
      async fire() { return { dispatchHash: 'dh-r' }; },
      async reconcile() {
        callCount++;
        if (callCount === 1) return { status: 'failed' as const, resultRef: 'interim-ref' };
        return { status: 'done' as const, resultRef: 'final-ref' };
      },
    };

    // fire
    await tick(store, { x: ex }, 'default', undefined, { maxAttempts: 2, now: 0 });
    // first reconcile -> failed with retry remaining (not terminal)
    await tick(store, { x: ex }, 'default', undefined, { maxAttempts: 2, now: 0 });

    const item = store.getItems().find((i) => i.id === 'retry-item')!;
    expect(item.status).toBe('ready'); // requeued
    expect(item.resultRef).toBeUndefined(); // not persisted on retry

    // advance past backoff gate and fire again
    await tick(store, { x: ex }, 'default', undefined, { maxAttempts: 2, now: 1_000_000_000 });
    // second reconcile -> done, resultRef persisted
    await tick(store, { x: ex }, 'default', undefined, { maxAttempts: 2, now: 1_000_000_000 });

    const finalItem = store.getItems().find((i) => i.id === 'retry-item')!;
    expect(finalItem.status).toBe('done');
    expect(finalItem.resultRef).toBe('final-ref');
  });
});

describe('tick refs — needs resolver integration', () => {
  it('resolves needs into inputs.inputRefs on the fired item', async () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 2);
    store.saveRun({ id: 'r', queue: 'default', items: [
      { id: 'a', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] },
      { id: 'b', executor: 'x', inputs: { workerInput: { go: 1 } }, depends_on: ['a'], resourceLocks: [],
        needs: { patch: { from: 'a', select: { kind: 'patch' } } } }] }, 'human:brett');
    store.markReady(['a']);
    const fired: Record<string, unknown>[] = [];
    const ex: Executor = { id: 'x',
      async fire(item) { fired.push(item.inputs); return { dispatchHash: 'd-' + item.id }; },
      async reconcile() { return { status: 'done' as const, resultRef: 'pangolin://ns/artifact/a/sha256:aa' }; } };
    await tick(store, { x: ex }, 'default', undefined, { maxAttempts: 1 }); // fires a
    await tick(store, { x: ex }, 'default', undefined, { maxAttempts: 1 }); // reconciles a, readies+fires b
    expect(fired[1].inputRefs).toEqual({ patch: 'pangolin://ns/artifact/a/sha256:aa' });
  });

  it('resolves needs with kind=output into inputs.inputRefs on the fired item', async () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 2);
    store.saveRun({ id: 'r2', queue: 'default', items: [
      { id: 'a2', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] },
      { id: 'b2', executor: 'x', inputs: {}, depends_on: ['a2'], resourceLocks: [],
        needs: { artifact: { from: 'a2', select: { kind: 'output', path: 'dist/bundle.js' } } } }] }, 'human:brett');
    store.markReady(['a2']);
    const fired: Record<string, unknown>[] = [];
    const ex: Executor = { id: 'x',
      async fire(item) { fired.push(item.inputs); return { dispatchHash: 'd-' + item.id }; },
      async reconcile() { return { status: 'done' as const, outputRefs: { 'dist/bundle.js': 'pangolin://ns/output/sha256:bb' } }; } };
    await tick(store, { x: ex }, 'default', undefined, { maxAttempts: 1 }); // fires a2
    await tick(store, { x: ex }, 'default', undefined, { maxAttempts: 1 }); // reconciles a2, readies+fires b2
    expect(fired[1].inputRefs).toEqual({ artifact: 'pangolin://ns/output/sha256:bb' });
  });

  it('fails an item with missing upstream product (no resultRef) and releases locks', async () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 2);
    store.saveRun({ id: 'r3', queue: 'default', items: [
      { id: 'a3', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] },
      { id: 'b3', executor: 'x', inputs: {}, depends_on: ['a3'], resourceLocks: [],
        needs: { patch: { from: 'a3', select: { kind: 'patch' } } } }] }, 'human:brett');
    store.markReady(['a3']);
    const ex: Executor = { id: 'x',
      async fire() { return { dispatchHash: 'd-a3' }; },
      // upstream done but no resultRef
      async reconcile() { return { status: 'done' as const }; } };
    await tick(store, { x: ex }, 'default', undefined, { maxAttempts: 1 }); // fires a3
    await tick(store, { x: ex }, 'default', undefined, { maxAttempts: 1 }); // reconciles a3 (done, no resultRef), readies b3
    // b3 is now ready; next tick should attempt to fire it but fail due to missing product
    const firedIds: string[] = [];
    const ex2: Executor = { id: 'x',
      async fire(item) { firedIds.push(item.id); return { dispatchHash: 'd-b3' }; },
      async reconcile() { return { status: 'done' as const }; } };
    await tick(store, { x: ex2 }, 'default', undefined, { maxAttempts: 1 }); // tries to fire b3
    const b3 = store.getItems().find((i) => i.id === 'b3')!;
    expect(b3.status).toBe('failed');
    expect(firedIds).not.toContain('b3'); // b3 never fired
    // locks should be released (no held locks for b3)
    expect(store.heldLockKeys()).not.toContain('b3');
  });

  it('does not mutate the submitted inputs in the store (immutability)', async () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 2);
    store.saveRun({ id: 'r4', queue: 'default', items: [
      { id: 'a4', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] },
      { id: 'b4', executor: 'x', inputs: { original: 'value' }, depends_on: ['a4'], resourceLocks: [],
        needs: { patch: { from: 'a4', select: { kind: 'patch' } } } }] }, 'human:brett');
    store.markReady(['a4']);
    const ex: Executor = { id: 'x',
      async fire() { return { dispatchHash: 'd-a4' }; },
      async reconcile() { return { status: 'done' as const, resultRef: 'pangolin://ref/sha256:cc' }; } };
    await tick(store, { x: ex }, 'default', undefined, { maxAttempts: 1 }); // fires a4
    await tick(store, { x: ex }, 'default', undefined, { maxAttempts: 1 }); // reconciles a4, readies+fires b4
    // Read b4 back from store — its inputs must not contain inputRefs
    const b4 = store.getItems().find((i) => i.id === 'b4')!;
    expect(b4.inputs).toEqual({ original: 'value' });
    expect((b4.inputs as Record<string, unknown>)['inputRefs']).toBeUndefined();
  });

  it('items without needs fire exactly as before (no inputRefs injected)', async () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 1);
    store.saveRun({ id: 'r5', queue: 'default', items: [
      { id: 'a5', executor: 'x', inputs: { foo: 'bar' }, depends_on: [], resourceLocks: [] }] }, 'human:brett');
    store.markReady(['a5']);
    const fired: Record<string, unknown>[] = [];
    const ex: Executor = { id: 'x',
      async fire(item) { fired.push(item.inputs); return { dispatchHash: 'd-a5' }; },
      async reconcile() { return { status: 'done' as const }; } };
    await tick(store, { x: ex }, 'default', undefined, { maxAttempts: 1 });
    expect(fired[0]).toEqual({ foo: 'bar' });
    expect(fired[0]['inputRefs']).toBeUndefined();
  });
});
