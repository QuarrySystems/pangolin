import { describe, it, expect } from 'vitest';
import { PangolinOrchestrator } from '../../src/orchestrator.js';
import { tick } from '../../src/engine/tick.js';
import { SqliteRunStateStore } from '../../src/runstate/sqlite.js';
import { ManualTrigger } from '../../src/triggers/manual.js';
import { AuditLog } from '../../src/audit/audit-log.js';
import { NoneSigner } from '../../src/audit/signer.js';
import { LocalAnchor } from '../../src/audit/anchor.js';
import type { Executor } from '../../src/contracts/index.js';

function fakeExec(): Executor & { fired: boolean } {
  let fired = false;
  return {
    id: 'x',
    async fire() { fired = true; return { dispatchHash: 'd' }; },
    async reconcile() { return fired ? { status: 'done' as const } : null; },
  };
}

/** Executor that fails the first N reconciles then succeeds. */
function flakyExec(failCount: number): Executor {
  let fired = false;
  let reconcileCount = 0;
  return {
    id: 'flaky',
    async fire() { fired = true; return { dispatchHash: 'dh-flaky' }; },
    async reconcile() {
      if (!fired) return null;
      reconcileCount++;
      if (reconcileCount <= failCount) return { status: 'failed' as const };
      return { status: 'done' as const };
    },
  };
}

/** Executor that always fails on reconcile. */
function alwaysFailExec(): Executor {
  let fired = false;
  return {
    id: 'doomed',
    async fire() { fired = true; return { dispatchHash: 'dh-doomed' }; },
    async reconcile() {
      if (!fired) return null;
      return { status: 'failed' as const };
    },
  };
}

/** AuditLog-shaped object whose append always throws. */
function throwingAuditLog() {
  return {
    append(_entry: unknown): void { throw new Error('audit append exploded!'); },
    async sealEpoch(_runId: string): Promise<never> { throw new Error('audit seal exploded!'); },
  };
}

describe('engine-wiring audit integration', () => {
  it('accrues audit entries through a run and seals once on completion', async () => {
    const store = new SqliteRunStateStore();
    const auditLog = new AuditLog({ store, signer: NoneSigner, anchor: new LocalAnchor(store) });
    const orch = new PangolinOrchestrator({
      store,
      executors: { x: fakeExec() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 1 } },
      auditLog,
    });
    const runId = orch.submitRun(
      { id: 'r', queue: 'default', items: [{ id: 'a', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] }] },
      'human:brett',
    );
    for (let i = 0; i < 6; i++) await orch.tick('default');

    const kinds = store.getAuditEntries(runId).map((e) => e.kind);
    expect(kinds).toContain('run.submitted');
    expect(kinds).toContain('item.fired');
    expect(kinds).toContain('item.reconciled');
    expect(kinds).toContain('run.completed');
    expect(store.getAuditRoot(runId)).toBeDefined();

    // exactly one run.completed (no double-seal):
    expect(kinds.filter((k) => k === 'run.completed').length).toBe(1);

    // itemId is the LOGICAL id, not namespaced:
    const firedEntry = store.getAuditEntries(runId).find((e) => e.kind === 'item.fired');
    expect(firedEntry).toBeDefined();
    expect(firedEntry!.itemId).toBe('a');
  });

  it('with no auditLog injected, no audit entries are written (behavior unchanged)', async () => {
    const store = new SqliteRunStateStore();
    const orch = new PangolinOrchestrator({
      store,
      executors: { x: fakeExec() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 1 } },
    });
    const runId = orch.submitRun({
      id: 'r2',
      queue: 'default',
      items: [{ id: 'a', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] }],
    });
    for (let i = 0; i < 6; i++) await orch.tick('default');

    expect(store.getAuditEntries(runId)).toEqual([]);
  });

  it('records item.retried when an executor fails then succeeds with maxAttempts >= 2', async () => {
    // Use tick() directly so we can control `now` and jump past the exponential backoff gate
    // without sleeping real time. The orchestrator submits the run; tick drives execution.
    const store = new SqliteRunStateStore();
    const auditLog = new AuditLog({ store, signer: NoneSigner, anchor: new LocalAnchor(store) });
    const orch = new PangolinOrchestrator({
      store,
      executors: { flaky: flakyExec(1) },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 1 } },
      maxAttempts: 3,
      auditLog,
    });
    const runId = orch.submitRun(
      { id: 'r3', queue: 'default', items: [{ id: 'b', executor: 'flaky', inputs: {}, depends_on: [], resourceLocks: [] }] },
      'human:brett',
    );
    // Drive ticks via tick() with advancing now to bypass backoff (backoff(1) = 2000ms; jump 5s).
    // The executor id is 'flaky'; orchestrator wraps it to denamespace, so we must pass the
    // wrapped executor directly to tick() for correct id resolution. Use orchestrator for
    // submitRun but low-level tick() for time-controlled driving.
    const flakyEx = flakyExec(1);
    const store2 = new SqliteRunStateStore();
    const auditLog2 = new AuditLog({ store: store2, signer: NoneSigner, anchor: new LocalAnchor(store2) });
    // Standalone store — submit the run directly so we can drive with tick() + controlled now.
    store2.ensureQueue('default', 1);
    const trigger2 = new ManualTrigger();
    const run2 = { id: 'r3b', queue: 'default', items: [{ id: 'b', executor: 'flaky', inputs: {}, depends_on: [] as string[], resourceLocks: [] as string[] }] };
    store2.saveRun(run2);
    store2.markReady(trigger2.initialReady(run2));
    const executors2 = { flaky: flakyEx };
    const t0 = Date.now();
    // Tick 1: fire (now = t0)
    await tick(store2, executors2, 'default', undefined, { maxAttempts: 3, auditLog: auditLog2, now: t0 });
    // Tick 2: reconcile -> fails first time -> item.retried emitted; item requeued with nextAttemptAt = t0 + 2000
    await tick(store2, executors2, 'default', undefined, { maxAttempts: 3, auditLog: auditLog2, now: t0 + 1 });
    // Tick 3: now = t0 + 5000 — past the backoff gate -> re-fire
    await tick(store2, executors2, 'default', undefined, { maxAttempts: 3, auditLog: auditLog2, now: t0 + 5000 });
    // Tick 4: reconcile -> succeeds (second call) -> item.reconciled done
    await tick(store2, executors2, 'default', undefined, { maxAttempts: 3, auditLog: auditLog2, now: t0 + 5001 });
    // Tick 5: skip-cascade + seal (via a final orchestrator tick won't seal since we're using raw tick;
    // just verify the audit entries are correct — sealEpoch is tested separately)
    const kinds = store2.getAuditEntries('r3b').map((e) => e.kind);
    expect(kinds).toContain('item.retried');
    expect(kinds).toContain('item.reconciled');

    // The final item.reconciled should be for status=done
    const reconciledDone = store2.getAuditEntries('r3b').find((e) => e.kind === 'item.reconciled' && e.status === 'done');
    expect(reconciledDone).toBeDefined();
    // itemId should be the logical id (no namespacing at this level since we're using tick() directly)
    expect(store2.getAuditEntries('r3b').find((e) => e.kind === 'item.retried')?.itemId).toBe('b');
  });

  it('records item.skipped when a dependent item\'s dependency fails terminally', async () => {
    const store = new SqliteRunStateStore();
    const auditLog = new AuditLog({ store, signer: NoneSigner, anchor: new LocalAnchor(store) });
    const orch = new PangolinOrchestrator({
      store,
      executors: { doomed: alwaysFailExec() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 1 } },
      maxAttempts: 1, // exhaust immediately — one attempt is terminal
      auditLog,
    });
    const runId = orch.submitRun(
      {
        id: 'r4',
        queue: 'default',
        items: [
          { id: 'a', executor: 'doomed', inputs: {}, depends_on: [], resourceLocks: [] },
          { id: 'b', executor: 'doomed', inputs: {}, depends_on: ['a'], resourceLocks: [] },
        ],
      },
      'human:brett',
    );
    for (let i = 0; i < 10; i++) await orch.tick('default');

    const kinds = store.getAuditEntries(runId).map((e) => e.kind);
    expect(kinds).toContain('item.skipped');

    // The skipped entry should reference item b (logical id)
    const skippedEntry = store.getAuditEntries(runId).find((e) => e.kind === 'item.skipped');
    expect(skippedEntry).toBeDefined();
    expect(skippedEntry!.itemId).toBe('b');
  });

  it('a throwing auditLog does NOT abort the run — tick never throws and run reaches done', async () => {
    // Use tick() directly so we can inject the throwing auditLog into tick opts without going
    // through the orchestrator (which would also perform the AuditStore constructor check).
    // The key invariant: a failing audit append must NEVER abort a tick or corrupt run state.
    const store = new SqliteRunStateStore();
    store.ensureQueue('default', 1);
    const throwLog = throwingAuditLog();
    const exec = fakeExec();
    const trigger = new ManualTrigger();
    const run = { id: 'r5', queue: 'default', items: [{ id: 'c', executor: 'x', inputs: {}, depends_on: [] as string[], resourceLocks: [] as string[] }] };
    store.saveRun(run);
    store.markReady(trigger.initialReady(run));
    const executors = { x: exec };

    // Tick 1: fire — audit.append(item.fired) throws; item must still reach 'running'
    await tick(store, executors, 'default', undefined, { auditLog: throwLog as unknown as AuditLog });
    expect(store.getItems('r5')[0]?.status).toBe('running');

    // Tick 2: reconcile — audit.append(item.reconciled) throws; item must reach 'done'
    await tick(store, executors, 'default', undefined, { auditLog: throwLog as unknown as AuditLog });
    expect(store.getItems('r5')[0]?.status).toBe('done');
  });

  it('constructor throws a clear error when auditLog is provided but store does not implement AuditStore', () => {
    // A store that is MISSING getAuditRoot (not a full AuditStore)
    const bareStore = {
      getItems: () => [],
      getItems_: () => [],
      saveRun: () => {},
      markReady: () => {},
      setStatus: () => {},
      releaseLocks: () => {},
      acquireLocks: () => true,
      heldLockKeys: () => [],
      queueConcurrency: () => 1,
      runningCount: () => 0,
      setRunning: () => {},
      bumpAttempt: () => {},
      getAttempts: () => 0,
      requeue: () => {},
      ensureQueue: () => {},
      setResultRef: () => {},
      setManifestRef: () => {},
    } as unknown as import('../../src/contracts/index.js').RunStateStore;

    const fakeAudit = new AuditLog({
      store: new SqliteRunStateStore(),
      signer: NoneSigner,
      anchor: new LocalAnchor(new SqliteRunStateStore()),
    });

    expect(() => new PangolinOrchestrator({
      store: bareStore,
      executors: { x: fakeExec() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 1 } },
      auditLog: fakeAudit,
    })).toThrow('PangolinOrchestrator: auditLog requires a store implementing AuditStore (getAuditRoot)');
  });
});
