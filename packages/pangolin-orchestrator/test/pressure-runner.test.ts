// Pressure tests for the offload-runner wave — real code paths, not unit mocks:
// file-backed SQLite run-state, a real filesystem LocalDirMailbox behind the
// MailboxSubmissionTransport, and the actual serve() loop. Executors are
// scripted (duration + failure count) so failure/concurrency/crash are
// deterministic, but everything they drive is production code.
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Executor, WorkItem, Run } from '../src/contracts/index.js';
import { PangolinOrchestrator, SqliteRunStateStore, ManualTrigger, MailboxSubmissionTransport, LocalDirMailbox, serve } from '../src/index.js';

// ---- observation state + a scripted executor (duration + per-item failTimes) ----
interface Obs { inflight: Set<string>; maxInflight: number; intervals: { id: string; start: number; end: number }[]; fireCounts: Record<string, number>; }
const newObs = (): Obs => ({ inflight: new Set(), maxInflight: 0, intervals: [], fireCounts: {} });

function scriptedExecutor(script: Record<string, { failTimes?: number; durationMs?: number }>, obs: Obs): Executor {
  const inflight = new Map<string, { id: string; completeAt: number; startedAt: number }>();
  return {
    id: 'scripted',
    async fire(item: WorkItem) {
      const n = (obs.fireCounts[item.id] = (obs.fireCounts[item.id] ?? 0) + 1);
      const hash = `${item.id}#${n}`;
      inflight.set(hash, { id: item.id, completeAt: Date.now() + (script[item.id]?.durationMs ?? 10), startedAt: Date.now() });
      obs.inflight.add(hash); obs.maxInflight = Math.max(obs.maxInflight, obs.inflight.size);
      return { dispatchHash: hash };
    },
    async reconcile(hash: string) {
      const rec = inflight.get(hash);
      if (!rec) return null;                  // unknown hash (e.g. post-crash) -> appears "still running"
      if (Date.now() < rec.completeAt) return null;
      inflight.delete(hash); obs.inflight.delete(hash);
      obs.intervals.push({ id: rec.id, start: rec.startedAt, end: Date.now() });
      const fails = script[rec.id]?.failTimes ?? 0;
      return { status: obs.fireCounts[rec.id] <= fails ? 'failed' : 'done' };
    },
  };
}

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function driveUntil(done: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (done()) return; await sleep(8); }
}

describe('offload-runner pressure tests', () => {
  it('SCENARIO 1: fans out disjoint-lock work to concurrency while shared-lock work serializes', async () => {
    const root = tmp('pangolin-pt1-'); const obs = newObs();
    const store = new SqliteRunStateStore(join(root, 'state.db'));
    const transport = new MailboxSubmissionTransport(new LocalDirMailbox(join(root, 'store')));
    const edits = ['a', 'b', 'c'].map((k) => ({ id: `e-${k}`, executor: 'scripted', inputs: {}, depends_on: [] as string[], resourceLocks: [`file-${k}`] }));
    const shared = ['x', 'y'].map((k) => ({ id: `e-${k}`, executor: 'scripted', inputs: {}, depends_on: [] as string[], resourceLocks: ['shared'] }));
    const verify: WorkItem = { id: 'verify', executor: 'scripted', inputs: {}, depends_on: [...edits, ...shared].map((e) => e.id), resourceLocks: [] };
    const run: Run = { id: 'run1', queue: 'default', items: [...edits, ...shared, verify] };
    // edits take ~70ms so several are genuinely in flight at once; verify is quick
    const script = Object.fromEntries(run.items.map((i) => [i.id, { durationMs: i.id === 'verify' ? 10 : 70 }])) as Record<string, { durationMs?: number; failTimes?: number }>;
    const orch = new PangolinOrchestrator({
      store, executors: { scripted: scriptedExecutor(script, obs) }, triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 3 } },
    });
    const ac = new AbortController();
    await transport.submit({ run, actor: 'human:pt', submittedAt: new Date(0).toISOString() });
    const p = serve({ orchestrator: orch, transport, tickIntervalMs: 5, signal: ac.signal });
    await driveUntil(() => orch.getStatus().find((s) => s.id === 'verify')?.status === 'done');
    ac.abort(); await p;

    const statuses = Object.fromEntries(orch.getStatus().map((s) => [s.id, s.status]));
    const iv = (id: string) => obs.intervals.find((i) => i.id === id)!;
    const overlap = (a: string, b: string) => iv(a) && iv(b) && iv(a).start < iv(b).end && iv(b).start < iv(a).end;
    // eslint-disable-next-line no-console
    console.log('[S1] statuses=', statuses, 'maxInflight=', obs.maxInflight, 'shared x/y overlap=', overlap('e-x', 'e-y'));
    expect(Object.values(statuses).every((s) => s === 'done')).toBe(true);  // all complete
    expect(obs.maxInflight).toBeGreaterThanOrEqual(2);                      // genuine fan-out
    expect(overlap('e-x', 'e-y')).toBe(false);                             // shared lock serialized them
    expect(iv('verify').start).toBeGreaterThanOrEqual(Math.max(...[...edits, ...shared].map((e) => iv(e.id).end)) - 1); // verify ran after deps
  });

  it('SCENARIO 2: flaky item recovers, always-failing item exhausts attempts and cascades skip to its dependent, independent branch still completes', async () => {
    const root = tmp('pangolin-pt2-'); const obs = newObs();
    const store = new SqliteRunStateStore(join(root, 'state.db'));
    const transport = new MailboxSubmissionTransport(new LocalDirMailbox(join(root, 'store')));
    const script = { flaky: { failTimes: 1, durationMs: 8 }, doomed: { failTimes: 99, durationMs: 8 }, indep: { durationMs: 8 } };
    const orch = new PangolinOrchestrator({
      store, executors: { scripted: scriptedExecutor(script, obs) }, triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 4 } }, maxAttempts: 2,
    });
    const run: Run = { id: 'run2', queue: 'default', items: [
      { id: 'flaky', executor: 'scripted', inputs: {}, depends_on: [], resourceLocks: [] },
      { id: 'doomed', executor: 'scripted', inputs: {}, depends_on: [], resourceLocks: [] },
      { id: 'after-doomed', executor: 'scripted', inputs: {}, depends_on: ['doomed'], resourceLocks: [] },
      { id: 'indep', executor: 'scripted', inputs: {}, depends_on: [], resourceLocks: [] },
    ] };
    const ac = new AbortController();
    await transport.submit({ run, actor: 'agent:pt', submittedAt: new Date(0).toISOString() });
    const p = serve({ orchestrator: orch, transport, tickIntervalMs: 5, signal: ac.signal, now: () => Date.now() });
    await driveUntil(() => {
      const s = Object.fromEntries(orch.getStatus().map((x) => [x.id, x.status]));
      return s.flaky === 'done' && s.doomed === 'failed' && s.indep === 'done' && s['after-doomed'] === 'skipped';
    });
    ac.abort(); await p;
    const s = Object.fromEntries(orch.getStatus().map((x) => [x.id, x.status]));
    // eslint-disable-next-line no-console
    console.log('[S2] statuses=', s, 'fireCounts=', obs.fireCounts);
    expect(s.flaky).toBe('done');                  // recovered on retry
    expect(obs.fireCounts.flaky).toBe(2);          // fired twice (fail, then ok)
    expect(s.doomed).toBe('failed');               // exhausted maxAttempts
    expect(obs.fireCounts.doomed).toBe(2);         // 2 attempts then terminal
    expect(s.indep).toBe('done');                  // independent branch unaffected (keep-going)
    expect(s['after-doomed']).toBe('skipped');      // skip-cascade: dependent of a failed item is skipped
    // eslint-disable-next-line no-console
    console.log('[S2] dependent-of-failed final status =', s['after-doomed']);
  });

  it('SCENARIO 3: survives a crash + restart on the same DB and storage; recoverStranded re-dispatches the in-flight item and the run completes without re-running pre-crash completed work', async () => {
    const root = tmp('pangolin-pt3-'); const dbPath = join(root, 'state.db'); const storeDir = join(root, 'store');
    // t1 is deliberately long so it is GUARANTEED in-flight at the crash; t2 depends on it.
    const run: Run = { id: 'run3', queue: 'default', items: [
      { id: 't0', executor: 'scripted', inputs: {}, depends_on: [], resourceLocks: [] },
      { id: 't1', executor: 'scripted', inputs: {}, depends_on: [], resourceLocks: [] },
      { id: 't2', executor: 'scripted', inputs: {}, depends_on: ['t0', 't1'], resourceLocks: [] },
    ] };
    const script = { t0: { durationMs: 5 }, t1: { durationMs: 300 }, t2: { durationMs: 5 } } as Record<string, { durationMs?: number; failTimes?: number }>;

    // ---- process 1: submit + run briefly, then "crash" (abort + close the DB handle) ----
    const obs1 = newObs();
    const store1 = new SqliteRunStateStore(dbPath);
    const transport1 = new MailboxSubmissionTransport(new LocalDirMailbox(storeDir));
    const orch1 = new PangolinOrchestrator({ store: store1, executors: { scripted: scriptedExecutor(script, obs1) }, triggers: { manual: new ManualTrigger() }, queues: { default: { concurrency: 2 } } });
    await transport1.submit({ run, actor: 'human:pt', submittedAt: new Date(0).toISOString() });
    const ac1 = new AbortController();
    const p1 = serve({ orchestrator: orch1, transport: transport1, tickIntervalMs: 5, signal: ac1.signal });
    await sleep(60);                  // t0 finishes (5ms); t1 (300ms) is still in-flight -> stranded by the crash
    ac1.abort(); await p1;
    const midDone = orch1.getStatus().filter((s) => s.status === 'done').map((s) => s.id);
    store1.close();                   // simulate process exit

    // ---- process 2: brand-new orchestrator/executor on the SAME db + storage ----
    const obs2 = newObs();
    const store2 = new SqliteRunStateStore(dbPath);
    const transport2 = new MailboxSubmissionTransport(new LocalDirMailbox(storeDir));
    const orch2 = new PangolinOrchestrator({ store: store2, executors: { scripted: scriptedExecutor(script, obs2) }, triggers: { manual: new ManualTrigger() }, queues: { default: { concurrency: 2 } } });
    const reIngested = await transport2.pollInbox();    // must be empty: run already claimed by process 1
    const ac2 = new AbortController();
    const p2 = serve({ orchestrator: orch2, transport: transport2, tickIntervalMs: 5, signal: ac2.signal });
    // recoverStranded (called at serve startup) re-dispatches t1; the run now completes fully
    await driveUntil(() => orch2.getStatus().every((s) => s.status === 'done'), 2500);
    ac2.abort(); await p2;
    const final = Object.fromEntries(orch2.getStatus().map((s) => [s.id, s.status]));
    const rerunCompleted = midDone.filter((id) => (obs2.fireCounts[id] ?? 0) > 0);  // completed-in-p1 items refired in p2?
    // eslint-disable-next-line no-console
    console.log('[S3] doneInProcess1=', midDone, 'reIngestedOnRestart=', reIngested.length, 'recompletedWork=', rerunCompleted, 'FINAL=', final);
    expect(reIngested.length).toBe(0);          // submission was acked (deleted) by process 1 after ingest; process 2 finds nothing in the inbox
    expect(midDone).toContain('t0');            // pre-crash completion is durable
    expect(rerunCompleted).toEqual([]);         // recoverStranded only touches 'running' items; t0 (done pre-crash) is NOT re-run
    expect(final.t1).toBe('done');              // recoverStranded re-dispatched t1; it completed after restart
    expect(Object.values(final).every((s) => s === 'done')).toBe(true); // run completes fully after crash+restart
    store2.close();
  });
});
