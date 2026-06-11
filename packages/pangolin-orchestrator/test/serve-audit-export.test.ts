// packages/pangolin-orchestrator/test/serve-audit-export.test.ts
import { describe, it, expect } from 'vitest';
import { PangolinOrchestrator, SqliteRunStateStore, ManualTrigger } from '../src/index.js';
import type { SubmissionEnvelope, SubmissionTransport, OutboxRecord } from '../src/index.js';
import { AuditLog } from '../src/audit/audit-log.js';
import { NoneSigner } from '../src/audit/signer.js';
import { LocalAnchor } from '../src/audit/anchor.js';
import type { Executor, Run } from '../src/contracts/index.js';
import { serve } from '../src/serve/driver.js';

/** Executor that fires immediately and reconciles done with a resultRef. */
function makeResultExecutor(): Executor {
  let fired = false;
  return {
    id: 'result-exec',
    async fire() { fired = true; return { dispatchHash: 'h-result' }; },
    async reconcile() { return fired ? { status: 'done' as const, resultRef: 'pangolin://artifacts/r1' } : null; },
  };
}

function makeOrchWithAudit() {
  const store = new SqliteRunStateStore();
  const auditLog = new AuditLog({ store, signer: NoneSigner, anchor: new LocalAnchor(store) });
  const orch = new PangolinOrchestrator({
    store,
    executors: { 'result-exec': makeResultExecutor() },
    triggers: { manual: new ManualTrigger() },
    queues: { default: { concurrency: 5 } },
    auditLog,
  });
  return { store, orch };
}

function makeRecordingTransport(
  envelopes: SubmissionEnvelope[],
): SubmissionTransport & { published: OutboxRecord[] } {
  let called = false;
  const published: OutboxRecord[] = [];
  return {
    published,
    async submit() { return ''; },
    async pollInbox() {
      if (!called) {
        called = true;
        return envelopes;
      }
      return [];
    },
    async ack() { /* no-op */ },
    async deadLetter() { /* no-op */ },
    async publish(rec) { published.push(rec); },
    async readOutbox() { return []; },
  };
}

const oneItemRun: Run = {
  id: 'run-audit-serve-test',
  queue: 'default',
  items: [
    { id: 'step-a', executor: 'result-exec', inputs: {}, depends_on: [], resourceLocks: [] },
  ],
};

describe('serve audit export', () => {
  it('publishes a kind:audit export once a run seals, exactly once', async () => {
    const { store, orch } = makeOrchWithAudit();

    const env: SubmissionEnvelope = {
      run: oneItemRun,
      actor: 'human:test',
      submittedAt: new Date().toISOString(),
    };
    const transport = makeRecordingTransport([env]);
    const ac = new AbortController();

    // Run serve; let it run for enough iterations that the run seals and a
    // couple more iterations follow (to prove idempotency).
    const servePromise = serve({
      orchestrator: orch,
      transport,
      queue: 'default',
      tickIntervalMs: 5,
      signal: ac.signal,
    });

    // Wait until at least one kind:'audit' record is published (or 3s timeout)
    const start = Date.now();
    while (Date.now() - start < 3000) {
      const auditRecs = transport.published.filter((r) => r.kind === 'audit');
      if (auditRecs.length > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    // Let a few more iterations run to prove idempotency
    await new Promise((r) => setTimeout(r, 50));

    ac.abort();
    await servePromise;

    const auditRecs = transport.published.filter((r) => r.kind === 'audit');

    // Exactly ONE audit record for this run
    expect(auditRecs.length).toBe(1);

    const auditRec = auditRecs[0]!;
    expect(auditRec.runId).toBe('run-audit-serve-test');

    // Body must be an AuditExport: entries non-empty, root defined
    const body = auditRec.body as { entries: unknown[]; root: unknown; items: unknown[] };
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.root).toBeDefined();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);

    store.close();
  });

  it('does not publish an audit record for an unsealed run', async () => {
    // We need a run that stays in-progress (never reaches done).
    // Use an executor that never resolves reconcile during our observation window.
    const store = new SqliteRunStateStore();
    const auditLog = new AuditLog({ store, signer: NoneSigner, anchor: new LocalAnchor(store) });

    // This executor fires but never reconciles done — keeps the run active
    const stalledExecutor: Executor = {
      id: 'stalled-exec',
      async fire() { return { dispatchHash: 'h-stall' }; },
      async reconcile() { return null; },  // null = still running
    };

    const orch = new PangolinOrchestrator({
      store,
      executors: { 'stalled-exec': stalledExecutor },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 5 } },
      auditLog,
    });

    const stalledRun: Run = {
      id: 'run-audit-stalled',
      queue: 'default',
      items: [
        { id: 'stall-a', executor: 'stalled-exec', inputs: {}, depends_on: [], resourceLocks: [] },
      ],
    };

    const env: SubmissionEnvelope = {
      run: stalledRun,
      actor: 'human:test',
      submittedAt: new Date().toISOString(),
    };
    const transport = makeRecordingTransport([env]);
    const ac = new AbortController();

    const servePromise = serve({
      orchestrator: orch,
      transport,
      queue: 'default',
      tickIntervalMs: 5,
      signal: ac.signal,
    });

    // Let several iterations run — the run should be in 'running' state (never seals)
    await new Promise((r) => setTimeout(r, 80));

    ac.abort();
    await servePromise;

    const auditRecs = transport.published.filter((r) => r.kind === 'audit');
    // No audit record because the run never sealed (root === undefined)
    expect(auditRecs.length).toBe(0);

    store.close();
  });
});
