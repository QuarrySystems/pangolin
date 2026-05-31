// packages/agora-orchestrator/test/tick-refs.test.ts
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
