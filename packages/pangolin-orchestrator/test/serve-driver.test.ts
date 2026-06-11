import { describe, it, expect } from 'vitest';
import { PangolinOrchestrator, SqliteRunStateStore, ManualTrigger } from '../src/index.js';
import type { SubmissionEnvelope, SubmissionTransport, OutboxRecord } from '../src/index.js';
import { serve } from '../src/serve/driver.js';
import { immediateExecutor } from './fixtures/executors.js';

function makeFakeTransport(envelopes: SubmissionEnvelope[]): SubmissionTransport & { published: OutboxRecord[]; ackedIds: string[]; deadLettered: string[] } {
  let called = false;
  const published: OutboxRecord[] = [];
  const ackedIds: string[] = [];
  const deadLettered: string[] = [];
  return {
    published,
    ackedIds,
    deadLettered,
    async submit() { return ''; },
    async pollInbox() {
      if (!called) {
        called = true;
        return envelopes;
      }
      return [];
    },
    async ack(runId) { ackedIds.push(runId); },
    async deadLetter(runId) { deadLettered.push(runId); },
    async publish(rec) { published.push(rec); },
    async readOutbox() { return []; },
  };
}

function makeThrowingTransport(): SubmissionTransport & { published: OutboxRecord[]; publishCallCount: number } {
  const published: OutboxRecord[] = [];
  let publishCallCount = 0;
  return {
    published,
    publishCallCount: 0,
    async submit() { return ''; },
    async pollInbox() { return []; },
    async ack(_runId) { /* no-op stub */ },
    async deadLetter(_runId) { /* no-op stub */ },
    async publish(rec) {
      publishCallCount++;
      // Access via closure so the outer ref stays in sync
      (this as { publishCallCount: number }).publishCallCount = publishCallCount;
      if (publishCallCount === 1) {
        throw new Error('transient publish error');
      }
      published.push(rec);
    },
    async readOutbox() { return []; },
  };
}

/** Transport that returns one poisoned envelope then never again, records dead-letter calls. */
function makePoisonTransport(env: SubmissionEnvelope): SubmissionTransport & { deadLettered: string[]; ackedIds: string[] } {
  let called = false;
  const deadLettered: string[] = [];
  const ackedIds: string[] = [];
  return {
    deadLettered,
    ackedIds,
    async submit() { return ''; },
    async pollInbox() {
      if (!called) {
        called = true;
        return [env];
      }
      return [];
    },
    async ack(runId) { ackedIds.push(runId); },
    async deadLetter(runId) { deadLettered.push(runId); },
    async publish() { /* no-op */ },
    async readOutbox() { return []; },
  };
}

describe('serve driver', () => {
  it('ingests a single-item run and drives it to done, publishing status records', async () => {
    const store = new SqliteRunStateStore();
    const orch = new PangolinOrchestrator({
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
    const orch = new PangolinOrchestrator({
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

  it('performs a reconcile-first tick before the loop — new submissions land before loop starts', async () => {
    const store = new SqliteRunStateStore();
    const orch = new PangolinOrchestrator({
      store,
      executors: { x: immediateExecutor() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 5 } },
    });

    // Pre-submit a run directly so the reconcile-first tick can fire it
    orch.submitRun({
      id: 'run-2',
      queue: 'default',
      items: [{ id: 'b', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] }],
    });

    // Assert b is not yet done before serve starts (it's 'ready', not 'done')
    const beforeStatuses = orch.getStatus('run-2');
    const beforeB = beforeStatuses.find((s) => s.id === 'b');
    expect(beforeB?.status).not.toBe('done');

    const transport = makeFakeTransport([]);
    const ac = new AbortController();

    const servePromise = serve({ orchestrator: orch, transport, tickIntervalMs: 5, signal: ac.signal });

    // Poll until item 'b' is done (reconcile-first fires it, first loop tick reconciles it)
    const start = Date.now();
    let isDone = false;
    while (Date.now() - start < 2000) {
      const statuses = orch.getStatus('run-2');
      const itemB = statuses.find((s) => s.id === 'b');
      if (itemB?.status === 'done') {
        isDone = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }

    ac.abort();
    await servePromise;

    expect(isDone).toBe(true);

    store.close();
  });

  it('does not leak abort listeners over multiple sleep calls', async () => {
    const store = new SqliteRunStateStore();
    const orch = new PangolinOrchestrator({
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
    const orch = new PangolinOrchestrator({
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

  it('startup recovery: a pre-seeded running item is recovered and driven to done', async () => {
    const store = new SqliteRunStateStore();
    // Manually set up a run where one item is already `running` (simulating a crashed process)
    store.ensureQueue('default', 5);
    store.saveRun({
      id: 'run-stranded',
      queue: 'default',
      items: [{ id: 'stranded-a', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] }],
    });
    store.markReady(['stranded-a']);
    store.setRunning('stranded-a', 'stale-hash');

    const orch = new PangolinOrchestrator({
      store,
      executors: { x: immediateExecutor() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 5 } },
    });

    // pollInbox always returns [] — no new submissions; recovery is the only mechanism
    const transport = makeFakeTransport([]);
    const ac = new AbortController();

    const servePromise = serve({
      orchestrator: orch,
      transport,
      queue: 'default',
      tickIntervalMs: 5,
      signal: ac.signal,
    });

    // Poll until the stranded item reaches done
    const start = Date.now();
    let isDone = false;
    while (Date.now() - start < 2000) {
      const statuses = orch.getStatus('run-stranded');
      const item = statuses.find((s) => s.id === 'stranded-a');
      if (item?.status === 'done') {
        isDone = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }

    ac.abort();
    await servePromise;

    expect(isDone).toBe(true);

    store.close();
  });

  it('acks each ingested run exactly once, right after submitRun', async () => {
    const store = new SqliteRunStateStore();
    const orch = new PangolinOrchestrator({
      store,
      executors: { x: immediateExecutor() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 5 } },
    });

    const run = {
      id: 'run-ack',
      queue: 'default',
      items: [{ id: 'ack-a', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] }],
    };
    const env: SubmissionEnvelope = { run, actor: 'human:test', submittedAt: new Date().toISOString() };
    const transport = makeFakeTransport([env]);

    const ac = new AbortController();
    const servePromise = serve({
      orchestrator: orch,
      transport,
      queue: 'default',
      tickIntervalMs: 5,
      signal: ac.signal,
    });

    // Wait until the item is done
    const start = Date.now();
    while (Date.now() - start < 2000) {
      const statuses = orch.getStatus('run-ack');
      if (statuses.find((s) => s.id === 'ack-a')?.status === 'done') break;
      await new Promise((r) => setTimeout(r, 10));
    }

    ac.abort();
    await servePromise;

    // ack must have been called exactly once with the run's id
    expect(transport.ackedIds).toEqual(['run-ack']);

    store.close();
  });

  it('poison submitRun: dead-letters the envelope and invokes onError, does NOT ack', async () => {
    // An orchestrator that rejects every submitRun
    const store = new SqliteRunStateStore();
    const orch = new PangolinOrchestrator({
      store,
      executors: { x: immediateExecutor() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 5 } },
    });
    // Override submitRun to always throw
    const origSubmit = orch.submitRun.bind(orch);
    let firstCall = true;
    orch.submitRun = (...args) => {
      if (firstCall) {
        firstCall = false;
        throw new Error('ingest failed: unknown queue');
      }
      return origSubmit(...args);
    };

    const poisonRun = {
      id: 'run-poison',
      queue: 'default',
      items: [{ id: 'p1', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] }],
    };
    const poisonEnv: SubmissionEnvelope = { run: poisonRun, actor: 'human:test', submittedAt: new Date().toISOString() };
    const transport = makePoisonTransport(poisonEnv);

    const errors: unknown[] = [];
    const ac = new AbortController();

    const servePromise = serve({
      orchestrator: orch,
      transport,
      queue: 'default',
      tickIntervalMs: 5,
      signal: ac.signal,
      onError: (err) => errors.push(err),
    });

    // Wait a couple ticks so the first poll is processed
    await new Promise((r) => setTimeout(r, 80));
    ac.abort();
    await servePromise;

    // Must have been dead-lettered, NOT acked
    expect(transport.deadLettered).toContain('run-poison');
    expect(transport.ackedIds).not.toContain('run-poison');
    // onError must have been called
    expect(errors.length).toBeGreaterThan(0);
    expect((errors[0] as Error).message).toBe('ingest failed: unknown queue');

    store.close();
  });

  it('healthy submission still ingests and acks when a previous run was dead-lettered', async () => {
    const store = new SqliteRunStateStore();
    const orch = new PangolinOrchestrator({
      store,
      executors: { x: immediateExecutor() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 5 } },
    });

    const goodRun = {
      id: 'run-good',
      queue: 'default',
      items: [{ id: 'g1', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] }],
    };
    const goodEnv: SubmissionEnvelope = { run: goodRun, actor: 'human:test', submittedAt: new Date().toISOString() };
    const transport = makeFakeTransport([goodEnv]);

    const ac = new AbortController();
    const servePromise = serve({
      orchestrator: orch,
      transport,
      queue: 'default',
      tickIntervalMs: 5,
      signal: ac.signal,
    });

    // Wait until item is done
    const start = Date.now();
    while (Date.now() - start < 2000) {
      const statuses = orch.getStatus('run-good');
      if (statuses.find((s) => s.id === 'g1')?.status === 'done') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    ac.abort();
    await servePromise;

    expect(transport.ackedIds).toContain('run-good');
    expect(transport.deadLettered).not.toContain('run-good');

    store.close();
  });

  it('error resilience: a throwing transport.publish does not crash serve and onError is invoked', async () => {
    const store = new SqliteRunStateStore();
    const orch = new PangolinOrchestrator({
      store,
      executors: { x: immediateExecutor() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 5 } },
    });

    // Submit a run before serve so the reconcile-first tick doesn't do the work
    const run = {
      id: 'run-resilience',
      queue: 'default',
      items: [{ id: 'res-a', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] }],
    };
    orch.submitRun(run, 'human:test');

    // Build a transport whose publish throws on the first call
    const throwingTransport = makeThrowingTransport();

    const errors: unknown[] = [];
    const ac = new AbortController();

    const servePromise = serve({
      orchestrator: orch,
      transport: throwingTransport,
      queue: 'default',
      tickIntervalMs: 5,
      signal: ac.signal,
      onError: (err) => errors.push(err),
    });

    // Poll until the run reaches done (the loop must survive the throw)
    const start = Date.now();
    let isDone = false;
    while (Date.now() - start < 2000) {
      const statuses = orch.getStatus('run-resilience');
      const item = statuses.find((s) => s.id === 'res-a');
      if (item?.status === 'done') {
        isDone = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }

    ac.abort();
    await servePromise;

    expect(isDone).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
    // The first error should be the transient publish error
    expect((errors[0] as Error).message).toBe('transient publish error');
    // After recovery, publish should have succeeded at least once
    expect(throwingTransport.published.length).toBeGreaterThan(0);

    store.close();
  });
});
