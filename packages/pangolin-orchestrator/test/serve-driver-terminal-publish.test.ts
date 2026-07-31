// Regression test for KNOWN-ISSUES.md #6, fault (1) — write amplification.
//
// serve/driver.ts called getStatus() with NO argument. getStatus(runId) passes it
// straight through, and the SQLite store treats an absent runId as "everything",
// so the loop published one status OutboxRecord per run PER TICK — including for
// runs that reached a terminal state days earlier. Items are never deleted, so a
// run accrues outbox records for the rest of the stack's life: a 67-second run was
// measured holding 23,307 of them.
//
// The contract this pins has two halves, and the second is what keeps the fix
// honest — it would be trivial to bound growth by never publishing terminal runs
// at all, which would silently break every client waiting to observe completion.
import { describe, it, expect } from 'vitest';
import { PangolinOrchestrator, SqliteRunStateStore, ManualTrigger } from '../src/index.js';
import type { SubmissionEnvelope, SubmissionTransport, OutboxRecord } from '../src/index.js';
import type { Executor } from '../src/contracts/index.js';
import { AuditLog } from '../src/audit/audit-log.js';
import { NoneSigner } from '../src/audit/signer.js';
import { LocalAnchor } from '../src/audit/anchor.js';
import { serve } from '../src/serve/driver.js';
import { immediateExecutor } from './fixtures/executors.js';

/** Fires and reconciles done with a resultRef, so the epoch can seal (mirrors
 *  serve-audit-export.test.ts — sealing needs an auditLog + signer + anchor). */
function makeResultExecutor(): Executor {
  let fired = false;
  return {
    id: 'result-exec',
    async fire() { fired = true; return { dispatchHash: 'h-result' }; },
    async reconcile() {
      return fired ? { status: 'done' as const, resultRef: 'pangolin://artifacts/r1' } : null;
    },
  };
}

const POLL_BUDGET_MS = 15_000;

function makeFakeTransport(
  envelopes: SubmissionEnvelope[],
): SubmissionTransport & { published: OutboxRecord[] } {
  let called = false;
  const published: OutboxRecord[] = [];
  return {
    published,
    async submit() {
      return '';
    },
    async pollInbox() {
      if (!called) {
        called = true;
        return envelopes;
      }
      return [];
    },
    async ack() {},
    async deadLetter() {},
    async publish(rec) {
      published.push(rec);
    },
    async readOutbox() {
      return [];
    },
  };
}

const TERMINAL = new Set(['done', 'failed', 'skipped', 'cancelled', 'denied']);

describe('#6 (1) the serve loop stops republishing terminal runs', () => {
  it('publishes the terminal status exactly once, then goes quiet while ticking on', async () => {
    const store = new SqliteRunStateStore();
    const orch = new PangolinOrchestrator({
      store,
      executors: { x: immediateExecutor() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 5 } },
    });

    const env: SubmissionEnvelope = {
      run: {
        id: 'run-terminal',
        queue: 'default',
        items: [{ id: 'a', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] }],
      },
      actor: 'human:test',
      submittedAt: new Date().toISOString(),
    };
    const transport = makeFakeTransport([env]);
    const ac = new AbortController();

    const servePromise = serve({
      orchestrator: orch,
      transport,
      queue: 'default',
      tickIntervalMs: 5,
      signal: ac.signal,
    });

    // Wait until the item is terminal AND the loop has published its terminal status.
    const start = Date.now();
    let sawTerminalPublish = false;
    while (Date.now() - start < POLL_BUDGET_MS) {
      const done = orch.getStatus('run-terminal').every((s) => TERMINAL.has(s.status));
      sawTerminalPublish = transport.published.some(
        (r) =>
          r.kind === 'status' &&
          Array.isArray(r.body) &&
          (r.body as Array<{ status: string }>).length > 0 &&
          (r.body as Array<{ status: string }>).every((i) => TERMINAL.has(i.status)),
      );
      if (done && sawTerminalPublish) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(sawTerminalPublish).toBe(true); // the run's completion IS observable

    // Now let the loop keep ticking. Before the fix it published one status record
    // per tick forever; after it, the count must not move.
    const countAfterTerminal = transport.published.filter((r) => r.kind === 'status').length;
    await new Promise((r) => setTimeout(r, 200)); // ~40 ticks at 5ms
    const countLater = transport.published.filter((r) => r.kind === 'status').length;

    ac.abort();
    await servePromise;

    expect(countLater).toBe(countAfterTerminal);

    // And exactly one terminal status record was emitted — not zero, not per-tick.
    const terminalRecords = transport.published.filter(
      (r) =>
        r.kind === 'status' &&
        Array.isArray(r.body) &&
        (r.body as Array<{ status: string }>).length > 0 &&
        (r.body as Array<{ status: string }>).every((i) => TERMINAL.has(i.status)),
    );
    expect(terminalRecords).toHaveLength(1);

    store.close();
  });

  it('still publishes the sealed audit export after the run goes quiet', async () => {
    // The audit export is published on a LATER tick than the terminal status
    // (it needs the epoch sealed). Gating status publication must not gate that.
    const store = new SqliteRunStateStore();
    const orch = new PangolinOrchestrator({
      store,
      executors: { 'result-exec': makeResultExecutor() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 5 } },
      auditLog: new AuditLog({ store, signer: NoneSigner, anchor: new LocalAnchor(store) }),
    });

    const env: SubmissionEnvelope = {
      run: {
        id: 'run-audit-after-quiet',
        queue: 'default',
        items: [{ id: 'a', executor: 'result-exec', inputs: {}, depends_on: [], resourceLocks: [] }],
      },
      actor: 'human:test',
      submittedAt: new Date().toISOString(),
    };
    const transport = makeFakeTransport([env]);
    const ac = new AbortController();

    const servePromise = serve({
      orchestrator: orch,
      transport,
      queue: 'default',
      tickIntervalMs: 5,
      signal: ac.signal,
    });

    const start = Date.now();
    while (Date.now() - start < POLL_BUDGET_MS) {
      if (transport.published.some((r) => r.kind === 'audit')) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    ac.abort();
    await servePromise;

    const audits = transport.published.filter((r) => r.kind === 'audit');
    expect(audits).toHaveLength(1);
    expect(audits[0]?.runId).toBe('run-audit-after-quiet');

    store.close();
  });
});
