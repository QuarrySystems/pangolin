import { describe, it, expect } from 'vitest';
import { AgoraOrchestrator } from '../../src/orchestrator.js';
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

describe('engine-wiring audit integration', () => {
  it('accrues audit entries through a run and seals once on completion', async () => {
    const store = new SqliteRunStateStore();
    const auditLog = new AuditLog({ store, signer: NoneSigner, anchor: new LocalAnchor(store) });
    const orch = new AgoraOrchestrator({
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
    const orch = new AgoraOrchestrator({
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
});
