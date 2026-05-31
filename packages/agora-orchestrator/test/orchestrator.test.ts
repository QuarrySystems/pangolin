import { describe, it, expect } from 'vitest';
import { AgoraOrchestrator } from '../src/orchestrator.js';
import { ManualTrigger } from '../src/triggers/manual.js';
import { SqliteRunStateStore } from '../src/runstate/sqlite.js';
import type { Executor, Run } from '../src/contracts/index.js';

const fake = (): Executor => ({ id: 'fake', async fire(i) { return { dispatchHash: `h-${i.id}` }; }, async reconcile() { return { status: 'done' as const }; } });
const run: Run = { id: 'r', queue: 'default', items: [
  { id: 'a', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: [] },
  { id: 'b', executor: 'fake', inputs: {}, depends_on: ['a'], resourceLocks: [] },
] };

function makeOrch(store: SqliteRunStateStore, executors?: Record<string, Executor>, maxAttempts?: number) {
  return new AgoraOrchestrator({ store, executors: executors ?? { fake: fake() }, triggers: { manual: new ManualTrigger() }, queues: { default: { concurrency: 5 } }, maxAttempts });
}

describe('submitRun attribution', () => {
  it('records the submitter actor and exposes runId on status', () => {
    const store = new SqliteRunStateStore();
    const orch = new AgoraOrchestrator({ store, executors: {}, triggers: { manual: new ManualTrigger() }, queues: { default: { concurrency: 1 } } });
    orch.submitRun({ id: 'r', queue: 'default', items: [ { id: 'a', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] } ] }, 'agent:claude');
    expect(store.getActor('a')).toBe('agent:claude');
    expect(orch.getStatus().find((s) => s.id === 'a')?.runId).toBe('r');
  });
  it('submitRun without actor still works', () => {
    const store = new SqliteRunStateStore();
    const orch = new AgoraOrchestrator({ store, executors: {}, triggers: { manual: new ManualTrigger() }, queues: { default: { concurrency: 1 } } });
    orch.submitRun({ id: 'r2', queue: 'default', items: [ { id: 'b', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] } ] });
    expect(store.getActor('b')).toBeUndefined();
    expect(orch.getStatus().find((s) => s.id === 'b')?.runId).toBe('r2');
  });
});

describe('AgoraOrchestrator', () => {
  it('throws if the default queue is not configured', () => {
    expect(() => new AgoraOrchestrator({ store: new SqliteRunStateStore(), executors: {}, triggers: {}, queues: {} })).toThrow(/default queue/);
  });
  it('submitRun seeds roots; getStatus reports blocking reasons', () => {
    const store = new SqliteRunStateStore();
    const o = makeOrch(store);
    o.submitRun(run);
    const st = o.getStatus('r');
    expect(st.find((s) => s.id === 'a')!.status).toBe('ready');
    expect(st.find((s) => s.id === 'b')!.blockedBy).toEqual(['a']); // b waits on a
    store.close();
  });
  it('drives a run to completion across ticks, and a fresh orchestrator over the same store resumes (crash-recovery)', async () => {
    const store = new SqliteRunStateStore();
    makeOrch(store).submitRun(run);
    await makeOrch(store).tick();              // fires a
    await makeOrch(store).tick();              // reconciles a -> done, fires b (NEW instance, same store)
    await makeOrch(store).tick();              // reconciles b -> done
    const statuses = makeOrch(store).getStatus('r').map((s) => s.status);
    expect(statuses).toEqual(['done', 'done']);
    store.close();
  });
  it('a terminally-failed dependency cascades to dependents — b becomes skipped when a fails', async () => {
    const failExecutor: Executor = {
      id: 'fail',
      async fire(i) { return { dispatchHash: `h-${i.id}` }; },
      async reconcile() { return { status: 'failed' as const }; },
    };
    const failRun: Run = { id: 'r', queue: 'default', items: [
      { id: 'a', executor: 'fail', inputs: {}, depends_on: [], resourceLocks: [] },
      { id: 'b', executor: 'fail', inputs: {}, depends_on: ['a'], resourceLocks: [] },
    ] };
    const store = new SqliteRunStateStore();
    const o = makeOrch(store, { fail: failExecutor }, 1);
    o.submitRun(failRun);
    await o.tick(); // fires a
    await o.tick(); // reconciles a -> failed, cascades b -> skipped
    const st = o.getStatus('r');
    expect(st.find((s) => s.id === 'a')!.status).toBe('failed');
    expect(st.find((s) => s.id === 'b')!.status).toBe('skipped'); // b is skipped, not pending
    store.close();
  });
});

describe('submitRun idempotency', () => {
  it('submitRun is idempotent for an already-ingested run', () => {
    const store = new SqliteRunStateStore();
    const orch = new AgoraOrchestrator({ store, executors: {}, triggers: { manual: new ManualTrigger() }, queues: { default: { concurrency: 1 } } });
    const run = { id: 'r', queue: 'default', items: [ { id: 'a', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] } ] };
    orch.submitRun(run, 'human:b');
    orch.submitRun(run, 'human:b');           // re-delivery
    expect(store.getItems('r').length).toBe(1);   // not duplicated
  });
});

describe('recoverStranded', () => {
  it('requeues a running item to ready with bumped attempts and nextAttemptAt=now, returns count 1', () => {
    const store = new SqliteRunStateStore();
    const orch = makeOrch(store);
    orch.submitRun(run);
    store.setRunning('a', 'hash-crash');

    const now = 1_700_000_000_000;
    const count = orch.recoverStranded(now);

    expect(count).toBe(1);
    const itemA = store.getItems().find((i) => i.id === 'a')!;
    expect(itemA.status).toBe('ready');
    expect(store.getAttempts('a')).toBe(1);
    expect(itemA.nextAttemptAt).toBe(now);
    store.close();
  });

  it('does not touch non-running items and returns 0 when nothing is running', () => {
    const store = new SqliteRunStateStore();
    const orch = makeOrch(store);
    orch.submitRun(run);
    // 'a' is ready, 'b' is pending — neither is running

    const now = 1_700_000_000_000;
    const count = orch.recoverStranded(now);

    expect(count).toBe(0);
    const st = store.getItems();
    expect(st.find((i) => i.id === 'a')!.status).toBe('ready');
    expect(st.find((i) => i.id === 'b')!.status).toBe('pending');
    store.close();
  });

  it('is idempotent: calling twice when nothing is running the second time returns 0', () => {
    const store = new SqliteRunStateStore();
    const orch = makeOrch(store);
    orch.submitRun(run);
    store.setRunning('a', 'hash-crash');

    const now = 1_700_000_000_000;
    orch.recoverStranded(now); // first call recovers 'a'
    const count2 = orch.recoverStranded(now); // second call: nothing running

    expect(count2).toBe(0);
    store.close();
  });
});
