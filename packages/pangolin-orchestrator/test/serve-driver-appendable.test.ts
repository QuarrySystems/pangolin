// packages/pangolin-orchestrator/test/serve-driver-appendable.test.ts
import { describe, it, expect } from 'vitest';
import { PangolinOrchestrator, SqliteRunStateStore, ManualTrigger } from '../src/index.js';
import type {
  SubmissionTransport,
  SubmissionEnvelope,
  ControlEnvelope,
  ExtendEnvelope,
  OutboxRecord,
} from '../src/index.js';
import type { ControlChannel, AppendChannel } from '../src/contracts/index.js';
import { AuditLog } from '../src/audit/audit-log.js';
import { NoneSigner } from '../src/audit/signer.js';
import { LocalAnchor } from '../src/audit/anchor.js';
import { serve } from '../src/serve/driver.js';
import { immediateExecutor } from './fixtures/executors.js';

const DONE_POLL_BUDGET_MS = 15_000;

/**
 * Build a fake transport that:
 *  - Implements SubmissionTransport (with a pre-loaded submission queue)
 *  - Implements Partial<ControlChannel> (optional)
 *  - Implements Partial<AppendChannel> (optional)
 */
function makeFakeAppendableTransport(opts: {
  submissions?: SubmissionEnvelope[];
  extends_?: ExtendEnvelope[];
  controls?: ControlEnvelope[];
}): SubmissionTransport &
  ControlChannel &
  AppendChannel & {
    published: OutboxRecord[];
    ackedIds: string[];
    deadLettered: string[];
    ackedControlTargets: string[];
    ackedExtendSeqs: Array<{ runId: string; seq: string }>;
  } {
  let inboxCalled = false;
  let extendsCalled = false;
  let controlCalled = false;

  const published: OutboxRecord[] = [];
  const ackedIds: string[] = [];
  const deadLettered: string[] = [];
  const ackedControlTargets: string[] = [];
  const ackedExtendSeqs: Array<{ runId: string; seq: string }> = [];

  return {
    published,
    ackedIds,
    deadLettered,
    ackedControlTargets,
    ackedExtendSeqs,

    // SubmissionTransport
    async submit() {
      return '';
    },
    async pollInbox() {
      if (!inboxCalled) {
        inboxCalled = true;
        return opts.submissions ?? [];
      }
      return [];
    },
    async ack(runId: string) {
      ackedIds.push(runId);
    },
    async deadLetter(runId: string) {
      deadLettered.push(runId);
    },
    async publish(rec: OutboxRecord) {
      published.push(rec);
    },
    async readOutbox() {
      return [];
    },

    // ControlChannel
    async control() {
      /* no-op */
    },
    async pollControl() {
      if (!controlCalled) {
        controlCalled = true;
        return opts.controls ?? [];
      }
      return [];
    },
    async ackControl(target: string) {
      ackedControlTargets.push(target);
    },

    // AppendChannel
    async extend() {
      /* no-op */
    },
    async pollExtends() {
      if (!extendsCalled) {
        extendsCalled = true;
        return opts.extends_ ?? [];
      }
      return [];
    },
    async ackExtend(runId: string, seq: string) {
      ackedExtendSeqs.push({ runId, seq });
    },
  };
}

describe('serve driver — appendable (AppendChannel)', () => {
  it('ingests a polled extend then a polled close, and the openEnded run seals', async () => {
    const store = new SqliteRunStateStore();
    const auditLog = new AuditLog({ store, signer: NoneSigner, anchor: new LocalAnchor(store) });
    const orch = new PangolinOrchestrator({
      store,
      executors: { x: immediateExecutor() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 5 } },
      auditLog,
    });

    const runId = 'run-openended-extend';

    // Submit an openEnded run with one initial item
    const initialRun = {
      id: runId,
      queue: 'default',
      openEnded: true,
      items: [{ id: 'init-a', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] }],
    };
    const submissionEnv: SubmissionEnvelope = {
      run: initialRun,
      actor: 'human:test',
      submittedAt: new Date().toISOString(),
    };

    // The extend envelope: adds one more item after the initial submission
    const extendEnv: ExtendEnvelope = {
      runId,
      items: [
        { id: 'extended-b', executor: 'x', inputs: {}, depends_on: ['init-a'], resourceLocks: [] },
      ],
      actor: 'human:test',
      at: new Date().toISOString(),
      seq: 'seq-001',
    };

    // The close control: marks the run as closed so it can seal
    const closeEnvelope: ControlEnvelope = {
      kind: 'close',
      target: runId,
      actor: 'human:operator',
      at: new Date().toISOString(),
    };

    const ac = new AbortController();
    const transport = makeFakeAppendableTransport({
      submissions: [submissionEnv],
      extends_: [extendEnv],
      controls: [closeEnvelope],
    });

    const servePromise = serve({
      orchestrator: orch,
      transport,
      queue: 'default',
      tickIntervalMs: 5,
      signal: ac.signal,
    });

    // Poll until the audit export is sealed (root is defined)
    const start = Date.now();
    let isSealed = false;
    while (Date.now() - start < DONE_POLL_BUDGET_MS) {
      const exp = orch.getAuditExport(runId);
      if (exp.root !== undefined) {
        isSealed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }

    ac.abort();
    await servePromise;

    // The run should be sealed (root defined)
    expect(isSealed).toBe(true);

    // The extended item should have run to done
    const statuses = orch.getStatus(runId);
    const extB = statuses.find((s) => s.id === 'extended-b');
    expect(extB?.status).toBe('done');

    // The extend should have been acked
    expect(transport.ackedExtendSeqs).toContainEqual({ runId, seq: 'seq-001' });

    // The close control should have been acked
    expect(transport.ackedControlTargets).toContain(runId);

    store.close();
  });

  it('a throwing producerExtend is routed to deadLetter and does not abort the loop', async () => {
    const store = new SqliteRunStateStore();
    const orch = new PangolinOrchestrator({
      store,
      executors: { x: immediateExecutor() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 5 } },
    });

    // An extend for a run that does not exist — producerExtend will throw
    const badExtendEnv: ExtendEnvelope = {
      runId: 'run-does-not-exist',
      items: [{ id: 'phantom-item', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] }],
      actor: 'human:test',
      at: new Date().toISOString(),
      seq: 'seq-bad',
    };

    const ac = new AbortController();
    const errors: unknown[] = [];

    const transport = makeFakeAppendableTransport({ extends_: [badExtendEnv] });

    const servePromise = serve({
      orchestrator: orch,
      transport,
      queue: 'default',
      tickIntervalMs: 5,
      signal: ac.signal,
      onError: (err) => errors.push(err),
    });

    // Let a couple ticks pass so the extend is processed
    await new Promise((r) => setTimeout(r, 80));
    ac.abort();
    await servePromise;

    // Error was routed to onError, loop did not crash
    expect(errors.length).toBeGreaterThan(0);
    // The bad extend should have been dead-lettered
    expect(transport.deadLettered).toContain('run-does-not-exist');
    // The serve loop resolved normally (did not throw)

    store.close();
  });

  it('a transport without AppendChannel still type-checks and runs without errors', async () => {
    const store = new SqliteRunStateStore();
    const orch = new PangolinOrchestrator({
      store,
      executors: { x: immediateExecutor() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 5 } },
    });

    // Plain transport: no pollExtends, no ackExtend
    const transport: SubmissionTransport = {
      async submit() {
        return '';
      },
      async pollInbox() {
        return [];
      },
      async ack() {
        /* no-op */
      },
      async deadLetter() {
        /* no-op */
      },
      async publish() {
        /* no-op */
      },
      async readOutbox() {
        return [];
      },
    };

    const ac = new AbortController();
    ac.abort(); // abort immediately

    await expect(
      serve({ orchestrator: orch, transport, tickIntervalMs: 5, signal: ac.signal }),
    ).resolves.toBeUndefined();

    store.close();
  });
});
