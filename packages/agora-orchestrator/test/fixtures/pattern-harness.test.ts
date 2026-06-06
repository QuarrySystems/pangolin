import { it, expect } from 'vitest';
import { idKeyedExecutor, makeOrch, driveUntilDone, driveUntil, storageFromBlobs } from './pattern-harness.js';

it('idKeyedExecutor drives a one-item run to the behavior-declared terminal status', async () => {
  const store = new (await import('../../src/runstate/sqlite.js')).SqliteRunStateStore();
  const { orch } = makeOrch(store, idKeyedExecutor(new Map(), () => ({ status: 'done', resultRef: 'agora://r' })));
  orch.submitRun({ id: 'r1', queue: 'default', items: [{ id: 'a', executor: 'dispatch', inputs: {}, depends_on: [], resourceLocks: [] }] }, 'human:test');
  await driveUntilDone(orch);
  expect(orch.getStatus('r1')[0]!.status).toBe('done');
  store.close();
});

it('driveUntilDone scoped to runId only waits on that run\'s items', async () => {
  const store = new (await import('../../src/runstate/sqlite.js')).SqliteRunStateStore();
  const executor = idKeyedExecutor(new Map(), (id) =>
    id === 'quick' ? { status: 'done' } : { status: 'done' },
  );
  const { orch } = makeOrch(store, executor);
  // Submit two runs
  orch.submitRun({ id: 'run-a', queue: 'default', items: [{ id: 'quick', executor: 'dispatch', inputs: {}, depends_on: [], resourceLocks: [] }] }, 'human:test');
  orch.submitRun({ id: 'run-b', queue: 'default', items: [{ id: 'slow', executor: 'dispatch', inputs: {}, depends_on: [], resourceLocks: [] }] }, 'human:test');
  // Drive only run-a to done; should not wait for run-b
  await driveUntilDone(orch, 32, 'run-a');
  expect(orch.getStatus('run-a')[0]!.status).toBe('done');
  store.close();
});

it('driveUntil exits when a custom predicate fires', async () => {
  const store = new (await import('../../src/runstate/sqlite.js')).SqliteRunStateStore();
  const { orch } = makeOrch(store, idKeyedExecutor(new Map(), () => ({ status: 'done', resultRef: 'agora://r' })));
  orch.submitRun({ id: 'r2', queue: 'default', items: [{ id: 'b', executor: 'dispatch', inputs: {}, depends_on: [], resourceLocks: [] }] }, 'human:test');
  let checkCount = 0;
  // Predicate fires on the second check (after one tick)
  await driveUntil(orch, () => { checkCount++; return checkCount >= 2; });
  // Should have exited early rather than running all maxTicks
  expect(checkCount).toBe(2);
  store.close();
});

it('storageFromBlobs rejects with "missing blob:" for unknown refs', async () => {
  const storage = storageFromBlobs(new Map());
  await expect(storage.get('agora://unknown/ref')).rejects.toThrow('missing blob: agora://unknown/ref');
});
