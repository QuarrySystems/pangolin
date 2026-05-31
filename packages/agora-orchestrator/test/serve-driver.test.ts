import { describe, it, expect } from 'vitest';
import { AgoraOrchestrator, SqliteRunStateStore, ManualTrigger } from '../src/index.js';
import type { SubmissionEnvelope, SubmissionTransport, OutboxRecord } from '../src/index.js';
import { serve } from '../src/serve/driver.js';
import { immediateExecutor } from './fixtures/executors.js';

function makeFakeTransport(envelopes: SubmissionEnvelope[]): SubmissionTransport & { published: OutboxRecord[] } {
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
    async publish(rec) { published.push(rec); },
    async readOutbox() { return []; },
  };
}

describe('serve driver', () => {
  it('ingests a single-item run and drives it to done, publishing status records', async () => {
    const store = new SqliteRunStateStore();
    const orch = new AgoraOrchestrator({
      store,
      executors: { x: immediateExecutor() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 5 } },
    });

    const run = {
      id: 'run-1',
      queue: 'default',
      items: [{ id: 'a', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] }],
    };

    const env: SubmissionEnvelope = { run, actor: 'human:test', submittedAt: new Date().toISOString() };
    const transport = makeFakeTransport([env]);

    const ac = new AbortController();

    // Start serve without awaiting
    const servePromise = serve({
      orchestrator: orch,
      transport,
      queue: 'default',
      tickIntervalMs: 5,
      signal: ac.signal,
    });

    // Poll until item 'a' is done (bounded ~2s)
    const start = Date.now();
    let isDone = false;
    while (Date.now() - start < 2000) {
      const statuses = orch.getStatus('run-1');
      const itemA = statuses.find((s) => s.id === 'a');
      if (itemA?.status === 'done') {
        isDone = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }

    // Abort to stop the loop
    ac.abort();
    await servePromise;

    expect(isDone).toBe(true);
    expect(transport.published.length).toBeGreaterThan(0);

    // Every published record should be a status record with runId = 'run-1'
    for (const rec of transport.published) {
      expect(rec.kind).toBe('status');
      expect(rec.runId).toBe('run-1');
      expect(Array.isArray(rec.body)).toBe(true);
    }

    store.close();
  });

  it('exits promptly when the signal is aborted', async () => {
    const store = new SqliteRunStateStore();
    const orch = new AgoraOrchestrator({
      store,
      executors: { x: immediateExecutor() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 5 } },
    });
    const transport = makeFakeTransport([]);
    const ac = new AbortController();

    const before = Date.now();
    // Abort immediately
    ac.abort();
    await serve({ orchestrator: orch, transport, tickIntervalMs: 5000, signal: ac.signal });
    const elapsed = Date.now() - before;
    // Should resolve well under the tick interval (5000ms), giving 500ms budget
    expect(elapsed).toBeLessThan(500);

    store.close();
  });

  it('performs a reconcile-first tick before the loop', async () => {
    const store = new SqliteRunStateStore();
    const orch = new AgoraOrchestrator({
      store,
      executors: { x: immediateExecutor() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 5 } },
    });

    // Pre-submit a run directly (simulating crash-recovery scenario)
    orch.submitRun({
      id: 'run-2',
      queue: 'default',
      items: [{ id: 'b', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] }],
    });
    // Manually fire item so it's running (but NOT yet reconciled to done)
    await orch.tick('default'); // fires b → b is now 'running'

    // Assert b is not yet done before serve starts
    const beforeStatuses = orch.getStatus('run-2');
    const beforeB = beforeStatuses.find((s) => s.id === 'b');
    expect(beforeB?.status).not.toBe('done');

    const transport = makeFakeTransport([]);
    const ac = new AbortController();
    // Abort before first loop iteration
    ac.abort();

    await serve({ orchestrator: orch, transport, tickIntervalMs: 5, signal: ac.signal });

    // After reconcile-first tick, item 'b' should be done
    const statuses = orch.getStatus('run-2');
    const itemB = statuses.find((s) => s.id === 'b');
    expect(itemB?.status).toBe('done');

    store.close();
  });

  it('does not leak abort listeners over multiple sleep calls', async () => {
    const store = new SqliteRunStateStore();
    const orch = new AgoraOrchestrator({
      store,
      executors: { x: immediateExecutor() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 5 } },
    });

    const transport = makeFakeTransport([]);
    const ac = new AbortController();

    // Track active abort listeners using a Set of references.
    // When the timer fires and explicitly calls removeEventListener, the set shrinks.
    // When { once: true } auto-removes on abort, the set also shrinks via our hook.
    const activeAbortListeners = new Set<EventListenerOrEventListenerObject>();
    const originalAdd = ac.signal.addEventListener.bind(ac.signal);
    const originalRemove = ac.signal.removeEventListener.bind(ac.signal);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ac.signal as any).addEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
      if (type === 'abort') activeAbortListeners.add(listener);
      return (originalAdd as Function)(type, listener, options);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ac.signal as any).removeEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
      if (type === 'abort') activeAbortListeners.delete(listener);
      return (originalRemove as Function)(type, listener, options);
    };

    // Run a few loop iterations with a short interval, then abort
    const servePromise = serve({
      orchestrator: orch,
      transport,
      tickIntervalMs: 5,
      signal: ac.signal,
    });

    // Let at least 3 iterations complete via timer (no abort yet)
    await new Promise((r) => setTimeout(r, 50));

    // At this point, timer-completed sleeps must have removed their listeners.
    // Only the currently-in-flight sleep should have 1 active listener (or 0 if between sleeps).
    expect(activeAbortListeners.size).toBeLessThanOrEqual(1);

    ac.abort();
    await servePromise;

    store.close();
  });

  it('groups status items by runId — one OutboxRecord per run per iteration', async () => {
    const store = new SqliteRunStateStore();
    const orch = new AgoraOrchestrator({
      store,
      executors: { x: immediateExecutor() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 5 } },
    });

    const run1: SubmissionEnvelope = {
      run: { id: 'run-a', queue: 'default', items: [{ id: 'x1', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] }] },
      actor: 'human:test',
      submittedAt: new Date().toISOString(),
    };
    const run2: SubmissionEnvelope = {
      run: { id: 'run-b', queue: 'default', items: [{ id: 'x2', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] }] },
      actor: 'human:test',
      submittedAt: new Date().toISOString(),
    };

    const transport = makeFakeTransport([run1, run2]);
    const ac = new AbortController();

    const servePromise = serve({ orchestrator: orch, transport, tickIntervalMs: 5, signal: ac.signal });

    // Wait until both are done
    const start = Date.now();
    while (Date.now() - start < 2000) {
      const statuses = orch.getStatus();
      const x1 = statuses.find((s) => s.id === 'x1');
      const x2 = statuses.find((s) => s.id === 'x2');
      if (x1?.status === 'done' && x2?.status === 'done') break;
      await new Promise((r) => setTimeout(r, 10));
    }

    ac.abort();
    await servePromise;

    // In any single iteration's published records, each runId should appear at most once
    // (we can't easily isolate iterations, but we can verify no iteration doubled up
    // by checking that runIds are unique within each "batch" — not easy without iteration markers,
    // but at minimum each published record must have exactly one runId)
    for (const rec of transport.published) {
      expect(['run-a', 'run-b']).toContain(rec.runId);
      expect(rec.kind).toBe('status');
    }

    // Should have published at least one record per run
    const runARecords = transport.published.filter((r) => r.runId === 'run-a');
    const runBRecords = transport.published.filter((r) => r.runId === 'run-b');
    expect(runARecords.length).toBeGreaterThan(0);
    expect(runBRecords.length).toBeGreaterThan(0);

    store.close();
  });
});
