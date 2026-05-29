import { describe, it, expect } from 'vitest';
import { tick } from '../src/engine/tick.js';
import { SqliteRunStateStore } from '../src/runstate/sqlite.js';
import type { Executor, Run } from '../src/contracts/index.js';

// Inline fake Executor (no real executor in PR2): fires immediately, finishes on next reconcile.
function fakeExecutor(): Executor & { fired: string[] } {
  const fired: string[] = [];
  return {
    id: 'fake', fired,
    async fire(item) { fired.push(item.id); return { dispatchHash: `h-${item.id}` }; },
    async reconcile() { return { status: 'done' as const }; },
  };
}

const run: Run = { id: 'r', queue: 'default', items: [
  { id: 'a', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: [] },
  { id: 'b', executor: 'fake', inputs: {}, depends_on: ['a'], resourceLocks: [] },
] };

describe('tick', () => {
  it('readies + fires roots, then readies + fires dependents after reconcile, respecting deps', async () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 5);
    store.saveRun(run);
    store.markReady(['a']); // manual trigger seeded the root

    const ex = fakeExecutor();
    const t1 = await tick(store, { fake: ex }, 'default');
    expect(t1.fired).toBe(1);                       // a fired
    expect(ex.fired).toEqual(['a']);
    expect(store.getItems('r').find((i) => i.id === 'b')!.status).toBe('pending'); // b still blocked

    const t2 = await tick(store, { fake: ex }, 'default');
    expect(t2.reconciled).toBe(1);                  // a -> done
    expect(store.getItems('r').find((i) => i.id === 'a')!.status).toBe('done');
    expect(ex.fired).toContain('b');                // b readied + fired now that a is done
    store.close();
  });

  it('honors the queue concurrency cap', async () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 1);
    store.saveRun({ id: 'r2', queue: 'default', items: [
      { id: 'x', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: [] },
      { id: 'y', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: [] },
    ] });
    store.markReady(['x', 'y']);
    // reconcile returns null (never finishes) so running items stay running
    const ex: Executor = { id: 'fake', async fire(i) { return { dispatchHash: `h-${i.id}` }; }, async reconcile() { return null; } };
    const t = await tick(store, { fake: ex }, 'default');
    expect(t.fired).toBe(1); // cap=1 → only one of x,y fires this pass
    store.close();
  });

  it('resource-lock serialization: two ready items sharing a lock key, only one fires per tick', async () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 10); // high concurrency — lock is the bottleneck
    store.saveRun({ id: 'r3', queue: 'default', items: [
      { id: 'p', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: ['shared-file.ts'] },
      { id: 'q', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: ['shared-file.ts'] },
    ] });
    store.markReady(['p', 'q']);
    // reconcile returns null so neither item completes — both stay running on second tick
    const ex: Executor = { id: 'fake', async fire(i) { return { dispatchHash: `h-${i.id}` }; }, async reconcile() { return null; } };
    const t = await tick(store, { fake: ex }, 'default');
    // Even though concurrency allows 10, the shared lock means only one can fire
    expect(t.fired).toBe(1);
    store.close();
  });

  it('throws a clear error when executor id is unregistered during fire', async () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 5);
    store.saveRun({ id: 'r4', queue: 'default', items: [
      { id: 'z', executor: 'nonexistent', inputs: {}, depends_on: [], resourceLocks: [] },
    ] });
    store.markReady(['z']);
    await expect(tick(store, {}, 'default')).rejects.toThrow("tick: no executor registered for 'nonexistent'");
    store.close();
  });

  it('throws a clear error when executor id is unregistered during reconcile', async () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 5);
    // Manually put an item into running state with an unknown executor
    store.saveRun({ id: 'r5', queue: 'default', items: [
      { id: 'w', executor: 'ghost', inputs: {}, depends_on: [], resourceLocks: [] },
    ] });
    store.markReady(['w']);
    store.setRunning('w', 'h-w');
    await expect(tick(store, {}, 'default')).rejects.toThrow("tick: no executor registered for 'ghost'");
    store.close();
  });

  it('reconcile: released locks allow next item to acquire on next tick', async () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 10);
    store.saveRun({ id: 'r6', queue: 'default', items: [
      { id: 'm', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: ['mutex'] },
      { id: 'n', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: ['mutex'] },
    ] });
    store.markReady(['m', 'n']);

    let reconcileCount = 0;
    const ex: Executor = {
      id: 'fake',
      async fire(i) { return { dispatchHash: `h-${i.id}` }; },
      async reconcile() {
        reconcileCount++;
        return { status: 'done' as const };
      },
    };

    // Tick 1: one of m or n fires (shared lock)
    const t1 = await tick(store, { fake: ex }, 'default');
    expect(t1.fired).toBe(1);

    // Tick 2: the running item is reconciled to done, its lock is released, and the other item fires
    const t2 = await tick(store, { fake: ex }, 'default');
    expect(t2.reconciled).toBe(1);
    expect(t2.fired).toBe(1); // second item fires after lock released
    store.close();
  });

  it('reconcile: failed status releases locks so the next item can fire', async () => {
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 10); // high concurrency — lock is the bottleneck
    store.saveRun({ id: 'r7', queue: 'default', items: [
      { id: 'm', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: ['shared'] },
      { id: 'n', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: ['shared'] },
    ] });
    store.markReady(['m', 'n']);

    const firedItems: string[] = [];
    const ex: Executor = {
      id: 'fake',
      async fire(i) { firedItems.push(i.id); return { dispatchHash: `h-${i.id}` }; },
      async reconcile() { return { status: 'failed' as const }; },
    };

    // Tick 1: m fires (acquires 'shared'), n is held by the lock
    const t1 = await tick(store, { fake: ex }, 'default');
    expect(t1.fired).toBe(1); // only one fires — lock blocks the second
    const firstFired = firedItems[0]; // either m or n (whichever was selected)

    // Tick 2: the running item reconciles → 'failed', lock released; the other item fires
    const t2 = await tick(store, { fake: ex }, 'default');
    expect(t2.reconciled).toBe(1);
    const firstItem = store.getItems('r7').find((i) => i.id === firstFired)!;
    expect(firstItem.status).toBe('failed'); // failed status set
    expect(t2.fired).toBe(1); // the other item fires now that lock is released
    expect(firedItems).toHaveLength(2); // both items have fired across the two ticks

    store.close();
  });
});
