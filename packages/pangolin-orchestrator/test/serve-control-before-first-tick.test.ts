// The serve loop processes control envelopes (cancel/close) BEFORE its tick, so a
// queued cancel beats the dispatch it targets. The reconcile-first tick that runs
// once before the loop did NOT get that treatment: it fired ready items before any
// pollControl had happened, so a cancel queued while the process was down lost the
// race to the very item it was meant to stop.
//
// Harmless while it stayed theoretical, and sharply not once serve() began driving
// every configured queue (KNOWN-ISSUES #7): items stranded on a previously-undriven
// queue become dispatchable on the next start, so that start is exactly when an
// operator reaches for a cancel — and, with serve stopped for the upgrade, exactly the
// case this race broke.
//
// Note the scope. While serve is UP, cancel was never at risk: control is drained in the
// loop body and cancelRun is not queue-scoped, so it reaches a stranded run regardless of
// which queue is ticked. (KNOWN-ISSUES #7 claimed otherwise; the live stack disproved it.)
// The gap was only ever a cancel queued while the process was DOWN.
//
// A cancel that arrived before the process did must be honoured before anything fires.
import { describe, it, expect } from 'vitest';
import { PangolinOrchestrator, SqliteRunStateStore, ManualTrigger } from '../src/index.js';
import type { SubmissionTransport, ControlEnvelope, Executor } from '../src/index.js';
import type { ControlChannel } from '../src/contracts/index.js';
import { serve } from '../src/serve/driver.js';

/** Records every fire so the test can assert the item was never dispatched at all. */
function recordingExecutor(fired: string[]): Executor {
  return {
    id: 'rec',
    async fire(item: { id: string }) {
      fired.push(item.id);
      return { dispatchHash: `h-${item.id}` };
    },
    async reconcile() {
      return { status: 'done' as const };
    },
  };
}

function controlTransport(
  envs: ControlEnvelope[],
): SubmissionTransport & ControlChannel & { acked: string[] } {
  const acked: string[] = [];
  let polled = false;
  return {
    acked,
    async submit() {
      return '';
    },
    async pollInbox() {
      return [];
    },
    async ack() {},
    async deadLetter() {},
    async publish() {},
    async readOutbox() {
      return [];
    },
    async control() {},
    async pollControl() {
      if (polled) return [];
      polled = true;
      return envs;
    },
    async ackControl(target: string) {
      acked.push(target);
    },
  };
}

describe('control is honoured before the reconcile-first tick', () => {
  it('a cancel queued while serve was down stops the item from ever firing', async () => {
    const fired: string[] = [];
    const store = new SqliteRunStateStore();
    const orch = new PangolinOrchestrator({
      store,
      executors: { rec: recordingExecutor(fired) },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 2 } },
    });

    // The run is already in the store — the "stranded work from a previous life" case.
    await orch.submitRun(
      {
        id: 'run-stranded',
        queue: 'default',
        items: [{ id: 'a', executor: 'rec', inputs: {}, depends_on: [], resourceLocks: [] }],
      },
      'human:test',
    );

    const transport = controlTransport([
      {
        kind: 'cancel',
        target: 'run-stranded',
        actor: 'human:operator',
        at: new Date().toISOString(),
      },
    ]);

    const ac = new AbortController();
    const p = serve({
      orchestrator: orch,
      transport,
      tickIntervalMs: 5,
      signal: ac.signal,
      onError: () => {},
    });
    const start = Date.now();
    while (Date.now() - start < 5_000) {
      if (transport.acked.length > 0) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    ac.abort();
    await p;

    // Before the fix the reconcile-first tick fired 'a' before pollControl ever ran.
    expect(fired).toEqual([]);
    expect(orch.getStatus('run-stranded').map((s) => s.status)).toEqual(['cancelled']);
    expect(transport.acked).toContain('run-stranded');

    store.close();
  });

  it('without a pending cancel the reconcile-first tick still dispatches normally', async () => {
    // The drain must not delay or suppress ordinary startup work.
    const fired: string[] = [];
    const store = new SqliteRunStateStore();
    const orch = new PangolinOrchestrator({
      store,
      executors: { rec: recordingExecutor(fired) },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 2 } },
    });
    await orch.submitRun(
      {
        id: 'run-normal',
        queue: 'default',
        items: [{ id: 'a', executor: 'rec', inputs: {}, depends_on: [], resourceLocks: [] }],
      },
      'human:test',
    );

    const ac = new AbortController();
    const p = serve({
      orchestrator: orch,
      transport: controlTransport([]),
      tickIntervalMs: 5,
      signal: ac.signal,
      onError: () => {},
    });
    const start = Date.now();
    while (Date.now() - start < 5_000 && fired.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
    ac.abort();
    await p;

    expect(fired).toEqual(['a']);
    store.close();
  });

  it('a cancel arriving in the SAME startup batch as its own submission still applies', async () => {
    // Regression guard. Draining control alone before the reconcile-first tick looks like
    // the obvious fix and silently breaks this: `cancelRun` on a run the store has never
    // seen iterates an empty item list and returns WITHOUT throwing, so ackControl is
    // reached and the envelope is destroyed against a run that arrives moments later.
    // (`closeRun` throws on an unknown run, so it survives — the two diverge here.)
    // Ingress must therefore drain inbox -> extends -> control as one ordered unit.
    const fired: string[] = [];
    const store = new SqliteRunStateStore();
    const orch = new PangolinOrchestrator({
      store,
      executors: { rec: recordingExecutor(fired) },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 2 } },
    });

    let inboxPolled = false;
    let controlPolled = false;
    const acked: string[] = [];
    const transport: SubmissionTransport & ControlChannel = {
      async submit() {
        return '';
      },
      async pollInbox() {
        if (inboxPolled) return [];
        inboxPolled = true;
        return [
          {
            run: {
              id: 'run-same-batch',
              queue: 'default',
              items: [{ id: 'a', executor: 'rec', inputs: {}, depends_on: [], resourceLocks: [] }],
            },
            actor: 'human:test',
            submittedAt: new Date().toISOString(),
          },
        ];
      },
      async ack() {},
      async deadLetter() {},
      async publish() {},
      async readOutbox() {
        return [];
      },
      async control() {},
      async pollControl() {
        if (controlPolled) return [];
        controlPolled = true;
        return [
          {
            kind: 'cancel',
            target: 'run-same-batch',
            actor: 'human:operator',
            at: new Date().toISOString(),
          },
        ];
      },
      async ackControl(target: string) {
        acked.push(target);
      },
    };

    const ac = new AbortController();
    const p = serve({
      orchestrator: orch,
      transport,
      tickIntervalMs: 5,
      signal: ac.signal,
      onError: () => {},
    });
    const start = Date.now();
    while (Date.now() - start < 5_000 && acked.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
    ac.abort();
    await p;

    expect(orch.getStatus('run-same-batch').map((s) => s.status)).toEqual(['cancelled']);
    expect(fired).toEqual([]);
    store.close();
  });

  it('a transport with no control channel still starts (pollControl is optional)', async () => {
    const fired: string[] = [];
    const store = new SqliteRunStateStore();
    const orch = new PangolinOrchestrator({
      store,
      executors: { rec: recordingExecutor(fired) },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 2 } },
    });
    await orch.submitRun(
      {
        id: 'run-nocontrol',
        queue: 'default',
        items: [{ id: 'a', executor: 'rec', inputs: {}, depends_on: [], resourceLocks: [] }],
      },
      'human:test',
    );

    const plain: SubmissionTransport = {
      async submit() {
        return '';
      },
      async pollInbox() {
        return [];
      },
      async ack() {},
      async deadLetter() {},
      async publish() {},
      async readOutbox() {
        return [];
      },
    };

    const ac = new AbortController();
    const p = serve({
      orchestrator: orch,
      transport: plain,
      tickIntervalMs: 5,
      signal: ac.signal,
      onError: () => {},
    });
    const start = Date.now();
    while (Date.now() - start < 5_000 && fired.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
    ac.abort();
    await p;

    expect(fired).toEqual(['a']);
    store.close();
  });
});
