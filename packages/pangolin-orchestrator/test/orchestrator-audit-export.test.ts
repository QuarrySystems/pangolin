import { describe, it, expect } from 'vitest';
import { PangolinOrchestrator } from '../src/orchestrator.js';
import { ManualTrigger } from '../src/triggers/manual.js';
import { SqliteRunStateStore } from '../src/runstate/sqlite.js';
import { AuditLog } from '../src/audit/audit-log.js';
import { NoneSigner } from '../src/audit/signer.js';
import { LocalAnchor } from '../src/audit/anchor.js';
import type { Executor, Run } from '../src/contracts/index.js';

/** Executor that fires (returns a dispatchHash) and reconciles done with a resultRef. */
function makeResultExecutor(resultRef: string): Executor {
  let fired = false;
  return {
    id: 'result-exec',
    async fire() { fired = true; return { dispatchHash: `h-${resultRef}` }; },
    async reconcile() { return fired ? { status: 'done' as const, resultRef } : null; },
  };
}

function makeOrchWithAudit(store: SqliteRunStateStore) {
  const auditLog = new AuditLog({ store, signer: NoneSigner, anchor: new LocalAnchor(store) });
  const orch = new PangolinOrchestrator({
    store,
    executors: { 'result-exec': makeResultExecutor('pangolin://artifacts/result-1') },
    triggers: { manual: new ManualTrigger() },
    queues: { default: { concurrency: 5 } },
    auditLog,
  });
  return { orch, auditLog };
}

const oneItemRun: Run = {
  id: 'run-export-test',
  queue: 'default',
  items: [
    { id: 'step-a', executor: 'result-exec', inputs: {}, depends_on: [], resourceLocks: [] },
  ],
};

/** Wraps a SqliteRunStateStore but exposes it as a plain RunStateStore — no audit methods. */
function makeNonAuditStore(inner: SqliteRunStateStore) {
  // Proxy that hides getAuditEntries / getAuditRoot so the orchestrator treats it
  // as a store that does NOT implement AuditStore.
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'getAuditEntries' || prop === 'getAuditRoot') return undefined;
      const val = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof val === 'function' ? val.bind(target) : val;
    },
  });
}

function makeOrchNoAudit(store: SqliteRunStateStore) {
  return new PangolinOrchestrator({
    store: makeNonAuditStore(store) as unknown as SqliteRunStateStore,
    executors: { 'result-exec': makeResultExecutor('pangolin://artifacts/result-1') },
    triggers: { manual: new ManualTrigger() },
    queues: { default: { concurrency: 5 } },
    // no auditLog
  });
}

/** Executor that fires and reconciles done WITH outputRefs. */
function makeOutputRefsExecutor(outputRefs: Record<string, string>): Executor {
  let fired = false;
  return {
    id: 'output-refs-exec',
    async fire() { fired = true; return { dispatchHash: 'h-outputrefs' }; },
    async reconcile() {
      return fired ? { status: 'done' as const, resultRef: 'pangolin://ns/result/r1', outputRefs } : null;
    },
  };
}

describe('getAuditExport', () => {
  it('audit export items carry outputRefs when the item produced them', async () => {
    const store = new SqliteRunStateStore();
    const outputRefs = { 'report.txt': 'pangolin://ns/artifact/d/sha256:ab' };
    const auditLog = new AuditLog({ store, signer: NoneSigner, anchor: new LocalAnchor(store) });
    const orch = new PangolinOrchestrator({
      store,
      executors: { 'output-refs-exec': makeOutputRefsExecutor(outputRefs) },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 5 } },
      auditLog,
    });

    const run: Run = {
      id: 'run-export-test',
      queue: 'default',
      items: [
        { id: 'step-a', executor: 'output-refs-exec', inputs: {}, depends_on: [], resourceLocks: [] },
      ],
    };

    orch.submitRun(run);
    // fire + reconcile
    await orch.tick('default');
    await orch.tick('default');

    const exp = orch.getAuditExport('run-export-test');
    expect(exp.items.find((i) => i.id === 'step-a')!.outputRefs)
      .toEqual({ 'report.txt': 'pangolin://ns/artifact/d/sha256:ab' });

    store.close();
  });

  it('items without outputRefs have no outputRefs key in their outcome', async () => {
    const store = new SqliteRunStateStore();
    const { orch } = makeOrchWithAudit(store);

    const runId = orch.submitRun(oneItemRun, 'human:brett');

    // Drive to completion
    for (let i = 0; i < 8; i++) await orch.tick('default');

    const exp = orch.getAuditExport(runId);
    const outcome = exp.items.find((i) => i.id === 'step-a')!;
    expect('outputRefs' in outcome).toBe(false);

    store.close();
  });

  it('does not crash and returns empty entries when orchestrator has no auditLog', async () => {
    const store = new SqliteRunStateStore();
    const orch = makeOrchNoAudit(store);

    const run: Run = {
      id: 'run-no-audit',
      queue: 'default',
      items: [
        { id: 'step-x', executor: 'result-exec', inputs: {}, depends_on: [], resourceLocks: [] },
      ],
    };

    const runId = orch.submitRun(run, 'human:brett');

    // Drive to completion
    for (let i = 0; i < 8; i++) await orch.tick('default');

    // Must not throw even though store has no getAuditEntries / getAuditRoot
    let exp: ReturnType<typeof orch.getAuditExport> | undefined;
    expect(() => { exp = orch.getAuditExport(runId); }).not.toThrow();

    expect(exp!.runId).toBe(runId);
    expect(exp!.entries).toEqual([]);
    expect(exp!.root).toBeUndefined();
    // items still populated from store
    expect(exp!.items.length).toBe(1);
    expect(exp!.items[0]!.id).toBe('step-x');
    expect(exp!.items[0]!.status).toBe('done');

    store.close();
  });

  it('exports refs-only entries, sealed root, and per-item outcomes after a run completes', async () => {
    const store = new SqliteRunStateStore();
    const { orch } = makeOrchWithAudit(store);

    const runId = orch.submitRun(oneItemRun, 'human:brett');

    // Drive to completion (fire + reconcile + seal)
    for (let i = 0; i < 8; i++) await orch.tick('default');

    const exp = orch.getAuditExport(runId);

    // Shape: all four fields present
    expect(exp.runId).toBe(runId);

    // entries: non-empty — at least run.submitted and run.completed
    expect(exp.entries.length).toBeGreaterThan(0);
    const kinds = exp.entries.map((e) => e.kind);
    expect(kinds).toContain('run.submitted');
    expect(kinds).toContain('run.completed');

    // root: defined once sealed
    expect(exp.root).toBeDefined();
    expect(exp.root!.receipt.epochId).toBe(runId);

    // items: one item with DE-NAMESPACED logical id
    expect(exp.items.length).toBe(1);
    const item = exp.items[0]!;
    expect(item.id).toBe('step-a');           // logical id, not namespaced
    expect(item.status).toBe('done');
    expect(item.resultRef).toBe('pangolin://artifacts/result-1');

    // No value-bearing fields beyond the refs contract
    expect(Object.keys(item)).not.toContain('inputs');
    expect(Object.keys(item)).not.toContain('secret');

    store.close();
  });

  it('returns undefined root and empty entries for an unknown/unsealed run', () => {
    const store = new SqliteRunStateStore();
    const { orch } = makeOrchWithAudit(store);

    // Do NOT submit any run — 'nope' is unknown
    const exp = orch.getAuditExport('nope');

    expect(exp.runId).toBe('nope');
    expect(exp.entries).toEqual([]);
    expect(exp.root).toBeUndefined();
    expect(exp.items).toEqual([]);

    store.close();
  });
});
