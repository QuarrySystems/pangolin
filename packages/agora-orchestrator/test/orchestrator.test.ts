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
    expect(store.getActor('r\x1fa')).toBe('agent:claude'); // namespaced id in store
    expect(orch.getStatus().find((s) => s.id === 'a')?.runId).toBe('r'); // de-namespaced output
  });
  it('submitRun without actor still works', () => {
    const store = new SqliteRunStateStore();
    const orch = new AgoraOrchestrator({ store, executors: {}, triggers: { manual: new ManualTrigger() }, queues: { default: { concurrency: 1 } } });
    orch.submitRun({ id: 'r2', queue: 'default', items: [ { id: 'b', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] } ] });
    expect(store.getActor('r2\x1fb')).toBeUndefined(); // namespaced id in store
    expect(orch.getStatus().find((s) => s.id === 'b')?.runId).toBe('r2'); // de-namespaced output
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
    store.setRunning('r\x1fa', 'hash-crash'); // namespaced id in store

    const now = 1_700_000_000_000;
    const count = orch.recoverStranded(now);

    expect(count).toBe(1);
    const itemA = store.getItems().find((i) => i.id === 'r\x1fa')!; // namespaced in store
    expect(itemA.status).toBe('ready');
    expect(store.getAttempts('r\x1fa')).toBe(1); // namespaced id in store
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
    expect(st.find((i) => i.id === 'r\x1fa')!.status).toBe('ready'); // namespaced in store
    expect(st.find((i) => i.id === 'r\x1fb')!.status).toBe('pending'); // namespaced in store
    store.close();
  });

  it('is idempotent: calling twice when nothing is running the second time returns 0', () => {
    const store = new SqliteRunStateStore();
    const orch = makeOrch(store);
    orch.submitRun(run);
    store.setRunning('r\x1fa', 'hash-crash'); // namespaced id in store

    const now = 1_700_000_000_000;
    orch.recoverStranded(now); // first call recovers 'a'
    const count2 = orch.recoverStranded(now); // second call: nothing running

    expect(count2).toBe(0);
    store.close();
  });
});

describe('run-scoped item ids', () => {
  it('two runs can share an item id without colliding (run-scoped ids)', () => {
    const store = new SqliteRunStateStore();
    const orch = new AgoraOrchestrator({ store, executors: {}, triggers: { manual: new ManualTrigger() }, queues: { default: { concurrency: 2 } } });
    const mk = (rid: string) => ({ id: rid, queue: 'default', items: [ { id: 't', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] } ] });
    orch.submitRun(mk('r1')); orch.submitRun(mk('r2')); // both item 't' — must NOT throw
    expect(orch.getStatus('r1').map((s) => s.id)).toEqual(['t']); // de-namespaced output
    expect(orch.getStatus('r2').map((s) => s.id)).toEqual(['t']);
  });

  it('within-run dependency blockedBy shows de-namespaced ids', () => {
    const store = new SqliteRunStateStore();
    const orch = new AgoraOrchestrator({ store, executors: {}, triggers: { manual: new ManualTrigger() }, queues: { default: { concurrency: 2 } } });
    const depRun = { id: 'dep-run', queue: 'default', items: [
      { id: 'step1', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] },
      { id: 'step2', executor: 'x', inputs: {}, depends_on: ['step1'], resourceLocks: [] },
    ]};
    orch.submitRun(depRun);
    const st = orch.getStatus('dep-run');
    expect(st.find((s) => s.id === 'step1')!.status).toBe('ready');
    expect(st.find((s) => s.id === 'step2')!.blockedBy).toEqual(['step1']); // de-namespaced
    expect(st.find((s) => s.id === 'step2')!.runId).toBe('dep-run');
  });
});

describe('submitRun validation gate', () => {
  it('rejects a run whose needs reference a missing item', () => {
    const store = new SqliteRunStateStore();
    const orch = makeOrch(store);
    expect(() => orch.submitRun({ id: 'r', queue: 'default', items: [
      { id: 'b', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [],
        needs: { patch: { from: 'ghost', select: { kind: 'patch' } } } }] }, 'human:t'))
      .toThrow(/ghost/);
    expect(store.getItems('r')).toHaveLength(0); // nothing persisted on validation failure
  });

  it('auto-unions and namespaces needs.from so resolution works post-ingestion', () => {
    const store = new SqliteRunStateStore();
    const orch = makeOrch(store);
    // submit a->b via needs only (no explicit depends_on on b)
    orch.submitRun({ id: 'r', queue: 'default', items: [
      { id: 'a', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: [] },
      { id: 'b', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: [],
        needs: { patch: { from: 'a', select: { kind: 'patch' } } } },
    ] });
    // after ingestion the stored 'b' should have depends_on containing the namespaced 'a' id
    const items = store.getItems('r');
    const storedB = items.find((i) => i.id === 'r\x1fb')!;
    expect(storedB.depends_on).toContain('r\x1fa'); // namespaced upstream
    // and needs.patch.from must be the same namespaced id so tick's resolver finds it
    expect(storedB.needs?.patch.from).toBe('r\x1fa');
    store.close();
  });
});
