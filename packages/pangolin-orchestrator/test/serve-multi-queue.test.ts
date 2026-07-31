// Regression tests for KNOWN-ISSUES.md #7 — "serve() drives exactly one queue, so a
// multi-queue config is half-inert".
//
// serve() read `opts.queue ?? 'default'` and ticked that ONE name, while
// PangolinOrchestrator accepted and validated the full queue map. An item submitted
// to a configured, validated queue other than the ticked one sat `ready` forever:
// no error in the serve log, in `orch status`, or in the audit chain, while the loop
// dispatched unrelated work normally throughout. Observed at 20+ minutes on `gated`;
// the same run resubmitted unchanged to `default` completed in 67 seconds.
//
// What made it worse than an ordinary misconfiguration: the config is VALID, so there is
// no startup warning and no obvious place to look.
//
// (KNOWN-ISSUES #7 also claimed `orch cancel` could not rescue a stranded run, leaving no
// exit but to abandon the run id. That was wrong — cancelRun walks a run's items directly
// and is not queue-scoped, and the live stack's two `gated` items are recorded as
// `cancelled (operator cancelled)` despite `gated` never having been ticked.)
//
// The contract now: an EXPLICIT `queue` drives exactly that queue (one process per
// queue stays possible), and OMITTING it drives every configured queue.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PangolinOrchestrator, SqliteRunStateStore, ManualTrigger } from '../src/index.js';
import type { SubmissionEnvelope, SubmissionTransport, OutboxRecord } from '../src/index.js';
import type { ControlChannel } from '../src/contracts/index.js';
import { serve } from '../src/serve/driver.js';
import { immediateExecutor } from './fixtures/executors.js';

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

/** Two configured queues, mirroring deploy/serve-stack's own config. */
function makeTwoQueueOrch() {
  const store = new SqliteRunStateStore();
  const orch = new PangolinOrchestrator({
    store,
    executors: { x: immediateExecutor() },
    triggers: { manual: new ManualTrigger() },
    queues: { default: { concurrency: 2 }, gated: { concurrency: 2 } },
  });
  return { store, orch };
}

function envFor(runId: string, queue: string): SubmissionEnvelope {
  return {
    run: {
      id: runId,
      queue,
      items: [{ id: 'a', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] }],
    },
    actor: 'human:test',
    submittedAt: new Date().toISOString(),
  };
}

async function runUntil(
  orch: PangolinOrchestrator,
  transport: SubmissionTransport,
  opts: { queue?: string },
  predicate: () => boolean,
): Promise<void> {
  const ac = new AbortController();
  const p = serve({ orchestrator: orch, transport, tickIntervalMs: 5, signal: ac.signal, ...opts });
  const start = Date.now();
  while (Date.now() - start < POLL_BUDGET_MS) {
    if (predicate()) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  ac.abort();
  await p;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('#7 serve() and multi-queue configs', () => {
  it('with NO explicit queue, drives a run on a non-default configured queue', async () => {
    const { store, orch } = makeTwoQueueOrch();
    const transport = makeTransport([envFor('run-gated', 'gated')]);

    await runUntil(orch, transport, {}, () =>
      orch.getStatus('run-gated').some((s) => s.status === 'done'),
    );

    // Before the fix this item sat `ready` with blockedBy: [] until the budget expired.
    expect(orch.getStatus('run-gated').map((s) => s.status)).toEqual(['done']);
    store.close();
  });

  it('still drives the default queue when no queue is given', async () => {
    const { store, orch } = makeTwoQueueOrch();
    const transport = makeTransport([envFor('run-default', 'default')]);

    await runUntil(orch, transport, {}, () =>
      orch.getStatus('run-default').some((s) => s.status === 'done'),
    );

    expect(orch.getStatus('run-default').map((s) => s.status)).toEqual(['done']);
    store.close();
  });

  it('an EXPLICIT queue still drives only that queue (one process per queue)', async () => {
    const { store, orch } = makeTwoQueueOrch();
    const transport = makeTransport([envFor('run-gated-2', 'gated')]);

    // Explicitly scoped to `default`, so `gated` must NOT be driven by this process.
    await runUntil(orch, transport, { queue: 'default' }, () => false);

    expect(orch.getStatus('run-gated-2').every((s) => s.status !== 'done')).toBe(true);
    store.close();
  });

  it('names the configured-but-undriven queues at startup when scoped explicitly', async () => {
    // The failure produces no signal to correlate with a doc, which is what made it
    // expensive to diagnose. Scoping to one queue is legitimate, so this is a notice,
    // not a refusal — but the operator must learn it at boot, not from a stuck run.
    const { store, orch } = makeTwoQueueOrch();
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const transport = makeTransport([]);

    await runUntil(orch, transport, { queue: 'default' }, () => log.mock.calls.length > 0);

    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('gated');
    store.close();
  });

  it('says nothing when the explicit queue is the only configured one', async () => {
    const store = new SqliteRunStateStore();
    const orch = new PangolinOrchestrator({
      store,
      executors: { x: immediateExecutor() },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 2 } },
    });
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runUntil(orch, makeTransport([envFor('run-solo', 'default')]), { queue: 'default' }, () =>
      orch.getStatus('run-solo').some((s) => s.status === 'done'),
    );

    expect(log).not.toHaveBeenCalled();
    store.close();
  });

  it('cancel reaches a run on a queue this process never ticks', async () => {
    // Pins the correction to KNOWN-ISSUES #7, which claimed a run stranded on an
    // unticked queue "cannot be cancelled either" and so had no exit. cancelRun walks a
    // run's items directly and is not queue-scoped, and the serve loop drains control in
    // its BODY before tick(queue) — so cancel reaches the run whatever is being ticked.
    // Confirmed against the live serve DB before writing this: two `gated` items sit at
    // `cancelled (operator cancelled)` despite `gated` never having been driven.
    const { store, orch } = makeTwoQueueOrch();

    let controlPolled = false;
    const acked: string[] = [];
    const transport: SubmissionTransport & ControlChannel = {
      ...makeTransport([envFor('run-cancel-unticked', 'gated')]),
      async control() {},
      async pollControl() {
        if (controlPolled) return [];
        controlPolled = true;
        return [
          {
            kind: 'cancel',
            target: 'run-cancel-unticked',
            actor: 'human:operator',
            at: new Date().toISOString(),
          },
        ];
      },
      async ackControl(target: string) {
        acked.push(target);
      },
    };

    // Explicitly scoped to `default`: `gated` is never ticked by this process.
    await runUntil(orch, transport, { queue: 'default' }, () => acked.length > 0);

    expect(orch.getStatus('run-cancel-unticked').map((s) => s.status)).toEqual(['cancelled']);
    store.close();
  });

  it('exposes the configured queue names', () => {
    const { store, orch } = makeTwoQueueOrch();
    expect(orch.getConfiguredQueues().sort()).toEqual(['default', 'gated']);
    store.close();
  });
});
