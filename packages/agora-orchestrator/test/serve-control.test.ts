// packages/agora-orchestrator/test/serve-control.test.ts
import { describe, it, expect } from 'vitest';
import { AgoraOrchestrator, SqliteRunStateStore, ManualTrigger } from '../src/index.js';
import type { SubmissionTransport, SubmissionEnvelope, ControlEnvelope } from '../src/index.js';
import type { ControlChannel } from '../src/contracts/index.js';
import { serve } from '../src/serve/driver.js';
import { immediateExecutor } from './fixtures/executors.js';

/** Build a plain SubmissionTransport with no control methods. */
function makePlainTransport(): SubmissionTransport {
  return {
    async submit() { return ''; },
    async pollInbox() { return []; },
    async ack() { /* no-op */ },
    async deadLetter() { /* no-op */ },
    async publish() { /* no-op */ },
    async readOutbox() { return []; },
  };
}

describe('serve control ingestion', () => {
  it('applies a queued cancel before the next tick and acks it', async () => {
    const store = new SqliteRunStateStore();
    const orch = new AgoraOrchestrator({
      store,
      executors: { x: immediateExecutor() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 1 } },
    });

    // The run to be submitted via pollInbox (not pre-submitted to orchestrator)
    const run = {
      id: 'run-cancel-test',
      queue: 'default',
      items: [
        { id: 'a', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] },
        { id: 'b', executor: 'x', inputs: {}, depends_on: ['a'], resourceLocks: [] },
      ],
    };
    const submissionEnv: SubmissionEnvelope = {
      run,
      actor: 'human:test',
      submittedAt: new Date().toISOString(),
    };
    const cancelEnvelope: ControlEnvelope = {
      kind: 'cancel',
      target: 'run-cancel-test',
      actor: 'human:operator',
      at: new Date().toISOString(),
    };

    // Transport that delivers submission and cancel in the FIRST iteration only.
    // pollInbox delivers the run, pollControl delivers the cancel — both on first call.
    // After the first iteration, we abort.
    let inboxPolled = false;
    let controlPolled = false;
    const ackedControlTargets: string[] = [];
    const ackedSubmissionIds: string[] = [];
    const ac = new AbortController();

    const transport: SubmissionTransport & ControlChannel & { ackedControlTargets: string[] } = {
      ackedControlTargets,
      async submit() { return ''; },
      async pollInbox() {
        if (!inboxPolled) {
          inboxPolled = true;
          return [submissionEnv];
        }
        return [];
      },
      async ack(runId: string) { ackedSubmissionIds.push(runId); },
      async deadLetter() { /* no-op */ },
      async publish() { /* no-op */ },
      async readOutbox() { return []; },
      async control() { /* no-op */ },
      async pollControl() {
        if (!controlPolled) {
          controlPolled = true;
          return [cancelEnvelope];
        }
        // Abort after control has been polled so we get exactly one loop iteration
        setTimeout(() => ac.abort(), 10);
        return [];
      },
      async ackControl(target: string) {
        ackedControlTargets.push(target);
      },
    };

    await serve({
      orchestrator: orch,
      transport,
      queue: 'default',
      tickIntervalMs: 5,
      signal: ac.signal,
    });

    // After the iteration: control was polled, cancel was applied before tick.
    // Items 'a' (was ready) should be cancelled; 'b' (was pending) should also be cancelled.
    const afterStatus = orch.getStatus('run-cancel-test');
    const afterA = afterStatus.find((s) => s.id === 'a');
    const afterB = afterStatus.find((s) => s.id === 'b');
    // 'a' was ready → cancelled
    expect(afterA?.status).toBe('cancelled');
    // 'b' was pending → cancelled
    expect(afterB?.status).toBe('cancelled');

    // The control envelope should have been acked
    expect(transport.ackedControlTargets).toContain('run-cancel-test');

    store.close();
  });

  it('a transport without a control channel ingests nothing and does not crash', async () => {
    const store = new SqliteRunStateStore();
    const orch = new AgoraOrchestrator({
      store,
      executors: { x: immediateExecutor() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 1 } },
    });

    const transport = makePlainTransport();
    const ac = new AbortController();

    // Abort immediately — should not throw
    ac.abort();
    await expect(
      serve({ orchestrator: orch, transport, tickIntervalMs: 5, signal: ac.signal }),
    ).resolves.toBeUndefined();

    store.close();
  });

  it('control error is routed to onError and does not crash the loop', async () => {
    const store = new SqliteRunStateStore();
    const orch = new AgoraOrchestrator({
      store,
      executors: { x: immediateExecutor() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 1 } },
    });

    let controlPolled = false;
    const ac = new AbortController();

    // Transport whose pollControl returns a cancel but ackControl throws.
    // On second pollControl call, abort so the test ends.
    const transport: SubmissionTransport & ControlChannel = {
      async submit() { return ''; },
      async pollInbox() { return []; },
      async ack() { /* no-op */ },
      async deadLetter() { /* no-op */ },
      async publish() { /* no-op */ },
      async readOutbox() { return []; },
      async control() { /* no-op */ },
      async pollControl() {
        if (!controlPolled) {
          controlPolled = true;
          return [{ kind: 'cancel', target: 'no-such-run', actor: 'human:op', at: new Date().toISOString() }];
        }
        setTimeout(() => ac.abort(), 10);
        return [];
      },
      async ackControl() {
        throw new Error('ack failed');
      },
    };

    const errors: unknown[] = [];

    // Should not throw; onError receives the ack error
    await expect(
      serve({
        orchestrator: orch,
        transport,
        tickIntervalMs: 5,
        signal: ac.signal,
        onError: (err) => errors.push(err),
      }),
    ).resolves.toBeUndefined();

    expect(errors.length).toBeGreaterThan(0);
    expect((errors[0] as Error).message).toBe('ack failed');

    store.close();
  });
});
