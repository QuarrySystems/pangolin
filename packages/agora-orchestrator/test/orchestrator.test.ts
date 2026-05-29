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

function makeOrch(store: SqliteRunStateStore) {
  return new AgoraOrchestrator({ store, executors: { fake: fake() }, triggers: { manual: new ManualTrigger() }, queues: { default: { concurrency: 5 } } });
}

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
});
