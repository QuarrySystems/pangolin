// The serve loop publishes a run's status only when that status has CHANGED.
//
// KNOWN-ISSUES #6 change 1 stopped terminal runs republishing forever, and that
// bounded growth for runs that FINISH. It does nothing for a run that does not:
// `publishedTerminal` suppresses only when every item is terminal, so a run with one
// permanently-stuck item re-published identical bytes every tick, indefinitely. That
// is exactly the stranded-queue case of issue 7, and any run whose executor never
// reconciles — the runs most likely to be left sitting for days.
//
// Publishing on change is the more general rule and largely subsumes the terminal
// special case: a finished run's status stops changing on its own, so it goes quiet
// without needing to be recognised as terminal. The terminal guard stays as a cheap
// belt-and-braces and because it also skips the equality check entirely.
//
// The contract has two halves, and the second is what stops this becoming a bug:
// unchanged status must not be republished, but EVERY change must still be observable,
// including a change that reverts a run to a body it held before.
import { describe, it, expect } from 'vitest';
import { PangolinOrchestrator, SqliteRunStateStore, ManualTrigger } from '../src/index.js';
import type {
  SubmissionEnvelope,
  SubmissionTransport,
  OutboxRecord,
  Executor,
} from '../src/index.js';
import { serve } from '../src/serve/driver.js';

const POLL_BUDGET_MS = 15_000;

function makeTransport(
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

/** Fires, then never reconciles — the run is permanently non-terminal. */
function stuckExecutor(): Executor {
  return {
    id: 'stuck',
    async fire() {
      return { dispatchHash: 'h-stuck' };
    },
    async reconcile() {
      return null;
    }, // never settles
  };
}

/** Reconciles done only once `release()` is called, so a change can be timed. */
function gatedExecutor(): Executor & { release(): void } {
  let released = false;
  return {
    id: 'gated',
    release() {
      released = true;
    },
    async fire() {
      return { dispatchHash: 'h-gated' };
    },
    async reconcile() {
      return released ? { status: 'done' as const } : null;
    },
  };
}

function envFor(runId: string, executor: string): SubmissionEnvelope {
  return {
    run: {
      id: runId,
      queue: 'default',
      items: [{ id: 'a', executor, inputs: {}, depends_on: [], resourceLocks: [] }],
    },
    actor: 'human:test',
    submittedAt: new Date().toISOString(),
  };
}

const statusRecords = (t: { published: OutboxRecord[] }) =>
  t.published.filter((r) => r.kind === 'status');

describe('#6: status is published on change, not every tick', () => {
  it('a permanently STUCK run stops republishing once its status settles', async () => {
    // The gap change 1 left: this run never becomes terminal, so publishedTerminal never
    // suppresses it. Before this fix it emitted one identical record per tick forever.
    const store = new SqliteRunStateStore();
    const orch = new PangolinOrchestrator({
      store,
      executors: { stuck: stuckExecutor() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 2 } },
    });
    const transport = makeTransport([envFor('run-stuck', 'stuck')]);
    const ac = new AbortController();
    const p = serve({
      orchestrator: orch,
      transport,
      queue: 'default',
      tickIntervalMs: 5,
      signal: ac.signal,
      onError: () => {},
    });

    // Let it reach `running` and settle there.
    const start = Date.now();
    while (Date.now() - start < POLL_BUDGET_MS) {
      if (orch.getStatus('run-stuck').some((s) => s.status === 'running')) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 60)); // let any in-flight change publish

    const settled = statusRecords(transport).length;
    await new Promise((r) => setTimeout(r, 250)); // ~50 further ticks at 5ms
    const later = statusRecords(transport).length;

    ac.abort();
    await p;

    expect(later).toBe(settled);
    store.close();
  });

  it('still publishes every distinct status change', async () => {
    // The half that keeps the optimisation honest. A client that misses a transition
    // because it happened to look identical is worse than a large outbox.
    const store = new SqliteRunStateStore();
    const exec = gatedExecutor();
    const orch = new PangolinOrchestrator({
      store,
      executors: { gated: exec },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 2 } },
    });
    const transport = makeTransport([envFor('run-changes', 'gated')]);
    const ac = new AbortController();
    const p = serve({
      orchestrator: orch,
      transport,
      queue: 'default',
      tickIntervalMs: 5,
      signal: ac.signal,
      onError: () => {},
    });

    const start = Date.now();
    while (Date.now() - start < POLL_BUDGET_MS) {
      if (orch.getStatus('run-changes').some((s) => s.status === 'running')) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 60));
    const beforeRelease = statusRecords(transport).length;

    exec.release(); // running -> done: a real change, must be published
    const t2 = Date.now();
    while (Date.now() - t2 < POLL_BUDGET_MS) {
      if (orch.getStatus('run-changes').every((s) => s.status === 'done')) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 60));

    ac.abort();
    await p;

    expect(statusRecords(transport).length).toBeGreaterThan(beforeRelease);
    // And the terminal state is observable, which is the whole point of publishing.
    const last = statusRecords(transport).at(-1);
    expect((last?.body as Array<{ status: string }>).every((i) => i.status === 'done')).toBe(true);
    store.close();
  });

  it("publishes a run's first status exactly once, not once per tick", async () => {
    const store = new SqliteRunStateStore();
    const orch = new PangolinOrchestrator({
      store,
      executors: { stuck: stuckExecutor() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 2 } },
    });
    const transport = makeTransport([envFor('run-first', 'stuck')]);
    const ac = new AbortController();
    const p = serve({
      orchestrator: orch,
      transport,
      queue: 'default',
      tickIntervalMs: 5,
      signal: ac.signal,
      onError: () => {},
    });

    const start = Date.now();
    while (Date.now() - start < POLL_BUDGET_MS) {
      if (statusRecords(transport).length > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 200));
    ac.abort();
    await p;

    // ready -> running is one legitimate change, so allow a small number of DISTINCT
    // bodies; what must not happen is one record per tick (~40+ over this window).
    expect(statusRecords(transport).length).toBeLessThanOrEqual(4);
    store.close();
  });
});
