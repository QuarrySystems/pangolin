import { describe, it, expect } from 'vitest';
import { PangolinOrchestrator } from '../src/orchestrator.js';
import { ManualTrigger } from '../src/triggers/manual.js';
import { SqliteRunStateStore } from '../src/runstate/sqlite.js';
import { AuditLog } from '../src/audit/audit-log.js';
import { NoneSigner } from '../src/audit/signer.js';
import { LocalAnchor } from '../src/audit/anchor.js';
import { computeSkipped } from '../src/engine/dep-resolver.js';
import type { Executor, ItemState, Run } from '../src/contracts/index.js';

const fakeExecutor = (): Executor => ({
  id: 'fake',
  async fire(i) { return { dispatchHash: `h-${i.id}` }; },
  async reconcile() { return { status: 'done' as const }; },
});

function makeOrch(store: SqliteRunStateStore) {
  return new PangolinOrchestrator({
    store,
    executors: { fake: fakeExecutor() },
    triggers: { manual: new ManualTrigger() },
    queues: { default: { concurrency: 5 } },
  });
}

function makeOrchWithAudit(store: SqliteRunStateStore) {
  const auditLog = new AuditLog({ store, signer: NoneSigner, anchor: new LocalAnchor(store) });
  const orch = new PangolinOrchestrator({
    store,
    executors: { fake: fakeExecutor() },
    triggers: { manual: new ManualTrigger() },
    queues: { default: { concurrency: 5 } },
    auditLog,
  });
  return { orch, auditLog };
}

const twoItemRun: Run = {
  id: 'r',
  queue: 'default',
  items: [
    { id: 'a', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: [] },
    { id: 'b', executor: 'fake', inputs: {}, depends_on: ['a'], resourceLocks: [] },
  ],
};

describe('cancelRun', () => {
  it('cancels all pending/ready items and leaves running items untouched', async () => {
    const store = new SqliteRunStateStore();
    const orch = makeOrch(store);
    const runId = orch.submitRun(twoItemRun, 'human:brett');

    // At this point: a=ready, b=pending
    const beforeCancel = orch.getStatus(runId);
    expect(beforeCancel.find((s) => s.id === 'a')!.status).toBe('ready');
    expect(beforeCancel.find((s) => s.id === 'b')!.status).toBe('pending');

    // Cancel the run — should mark all ready/pending items as cancelled
    orch.cancelRun(runId, 'human:brett');

    const afterCancel = orch.getStatus(runId);
    expect(afterCancel.find((s) => s.id === 'a')!.status).toBe('cancelled');
    // b is also pending, so it is directly cancelled by cancelRun
    expect(afterCancel.find((s) => s.id === 'b')!.status).toBe('cancelled');

    store.close();
  });

  it('does NOT cancel running items', async () => {
    const store = new SqliteRunStateStore();
    const orch = makeOrch(store);
    const runId = orch.submitRun(twoItemRun);

    // Manually put 'a' into running state (namespaced in store)
    store.setRunning(`${runId}\x1fa`, 'some-hash');

    orch.cancelRun(runId, 'human:brett');

    // 'a' is running — should NOT be touched
    const st = orch.getStatus(runId);
    expect(st.find((s) => s.id === 'a')!.status).toBe('running');
    // 'b' is pending — should be cancelled
    expect(st.find((s) => s.id === 'b')!.status).toBe('cancelled');

    store.close();
  });

  it('is idempotent — cancelling already-cancelled run does not throw', () => {
    const store = new SqliteRunStateStore();
    const orch = makeOrch(store);
    const runId = orch.submitRun(twoItemRun);

    orch.cancelRun(runId, 'human:brett');
    expect(() => orch.cancelRun(runId, 'human:brett')).not.toThrow();

    store.close();
  });
});

describe('cancelItem', () => {
  it('cancels a single pending item by logical id, leaves other items untouched', () => {
    const store = new SqliteRunStateStore();
    const orch = makeOrch(store);
    const runId = orch.submitRun(twoItemRun);

    // Cancel only 'b' (which is pending)
    orch.cancelItem(runId, 'b', 'human:brett');

    const st = orch.getStatus(runId);
    expect(st.find((s) => s.id === 'a')!.status).toBe('ready');    // untouched
    expect(st.find((s) => s.id === 'b')!.status).toBe('cancelled'); // cancelled

    store.close();
  });

  it('does NOT cancel a running item', async () => {
    const store = new SqliteRunStateStore();
    const orch = makeOrch(store);
    const runId = orch.submitRun(twoItemRun);

    // Fire 'a' so it goes running
    store.setRunning(`${runId}\x1fa`, 'some-hash');

    // Attempt to cancel 'a' — should be ignored since it's running
    orch.cancelItem(runId, 'a', 'human:brett');

    const st = orch.getStatus(runId);
    expect(st.find((s) => s.id === 'a')!.status).toBe('running'); // unchanged

    store.close();
  });

  it('tick cascades a cancelled item\'s pending dependent to skipped', async () => {
    // Use cancelItem to cancel just 'a', leaving 'b' pending.
    // Then tick should cascade b -> skipped via computeSkipped.
    const store = new SqliteRunStateStore();
    const orch = makeOrch(store);
    const runId = orch.submitRun(twoItemRun);

    // Cancel only 'a' (which is ready)
    orch.cancelItem(runId, 'a', 'human:brett');

    const afterCancel = orch.getStatus(runId);
    expect(afterCancel.find((s) => s.id === 'a')!.status).toBe('cancelled');
    expect(afterCancel.find((s) => s.id === 'b')!.status).toBe('pending'); // b not yet cascaded

    // After a tick, b should be skipped (via computeSkipped seeing a cancelled dep)
    await orch.tick('default');
    const afterTick = orch.getStatus(runId);
    expect(afterTick.find((s) => s.id === 'b')!.status).toBe('skipped');

    store.close();
  });

  it('does NOT append an audit entry when itemId does not exist', () => {
    // Guard: calling cancelItem with a non-existent itemId must be a no-op
    // and must NOT write phantom entries to the tamper-evident audit log.
    const store = new SqliteRunStateStore();
    const { orch } = makeOrchWithAudit(store);
    const runId = orch.submitRun(twoItemRun, 'human:brett');

    // Baseline: only 'run.submitted' entry exists
    const beforeCount = store.getAuditEntries(runId).length;

    // Cancel a non-existent item — should be a complete no-op
    orch.cancelItem(runId, 'does-not-exist', 'human:brett');

    // Audit log length must be unchanged — no phantom cancellation entry
    expect(store.getAuditEntries(runId).length).toBe(beforeCount);

    store.close();
  });

  it('does NOT append an audit entry when item is already terminal (cancelled)', () => {
    // Guard: cancelling an already-cancelled item must not write a second phantom entry.
    const store = new SqliteRunStateStore();
    const { orch } = makeOrchWithAudit(store);
    const runId = orch.submitRun(twoItemRun, 'human:brett');

    // First cancel — legitimate; should append one run.cancelled entry
    orch.cancelItem(runId, 'a', 'human:brett');
    const afterFirst = store.getAuditEntries(runId).length;

    // Second cancel on already-cancelled item — must be a no-op, no second entry
    orch.cancelItem(runId, 'a', 'human:brett');
    expect(store.getAuditEntries(runId).length).toBe(afterFirst);

    store.close();
  });
});

describe('computeSkipped — cancelled dependency cascade', () => {
  const item = (id: string, status: string, deps: string[] = []) =>
    ({ id, runId: 'r', queue: 'q', executor: 'e', inputs: {}, depends_on: deps, resourceLocks: [], status } as unknown as ItemState);

  it('cascades a pending item whose dep is cancelled', () => {
    const result = computeSkipped([item('a', 'cancelled'), item('b', 'pending', ['a'])]);
    expect(result).toEqual(['b']);
  });

  it('does not cascade when dep is only running (not cancelled)', () => {
    const result = computeSkipped([item('a', 'running'), item('b', 'pending', ['a'])]);
    expect(result).toEqual([]);
  });

  it('cascades when dep is cancelled alongside failed', () => {
    const result = computeSkipped([
      item('a', 'failed'),
      item('b', 'cancelled'),
      item('c', 'pending', ['a']),
      item('d', 'pending', ['b']),
    ]);
    expect(result).toContain('c');
    expect(result).toContain('d');
  });
});

describe('TERMINAL_STATUSES includes cancelled', () => {
  it('a fully-cancelled run is considered settled (all items are terminal)', async () => {
    const store = new SqliteRunStateStore();
    const orch = makeOrch(store);
    const runId = orch.submitRun(twoItemRun);

    orch.cancelRun(runId, 'human:brett');
    await orch.tick('default'); // cascade b to skipped

    const st = orch.getStatus(runId);
    // Both items should be in terminal state — a=cancelled, b=skipped
    const allTerminal = st.every((s) => ['done', 'failed', 'skipped', 'cancelled'].includes(s.status));
    expect(allTerminal).toBe(true);

    store.close();
  });
});
