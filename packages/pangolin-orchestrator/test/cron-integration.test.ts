// End-to-end integration tests for V1.1 cron scheduling: the real CronScheduler +
// SqliteScheduleStore + serve loop + PangolinOrchestrator wired together. Complements the
// per-unit tests (cron-scheduler / sqlite-schedule-store / serve-scheduler) by exercising
// the full cron → serve → submit → pipeline loop and the cross-component correctness claims
// (catch-up coalescing, deterministic-runId dedup, persistence across restart).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PangolinOrchestrator,
  SqliteRunStateStore,
  ManualTrigger,
  CronScheduler,
  nextDueAfter,
  SqliteScheduleStore,
  serve,
} from '../src/index.js';
import type { Schedule, SubmissionTransport, SubmissionEnvelope, OutboxRecord, Run } from '../src/index.js';
import { immediateExecutor } from './fixtures/executors.js';

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'cron-it-')), 'state.db');
const runTemplate = (id: string): Run => ({ id, queue: 'default', items: [{ id: 'a', executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] }] } as unknown as Run);
const mkSched = (over: Partial<Schedule> = {}): Schedule => ({ id: 'nightly', cronExpr: '0 * * * *', run: runTemplate('nightly'), actor: 'human:test', nextDueAt: '2026-06-03T02:00:00.000Z', ...over });

/** Loopback transport: submit() feeds the SAME inbox pollInbox() drains — closes the cron → serve → submitRun loop. */
function loopbackTransport(): SubmissionTransport & { submitted: string[]; published: OutboxRecord[] } {
  const inbox: SubmissionEnvelope[] = [];
  const submitted: string[] = [];
  const published: OutboxRecord[] = [];
  return {
    submitted, published,
    async submit(e: SubmissionEnvelope) { inbox.push(e); submitted.push(e.run.id); return e.run.id; },
    async pollInbox() { return inbox.splice(0); },
    async ack() {},
    async deadLetter() {},
    async publish(r: OutboxRecord) { published.push(r); },
    async readOutbox() { return []; },
  };
}
const mkOrch = () => new PangolinOrchestrator({ store: new SqliteRunStateStore(), executors: { x: immediateExecutor() }, triggers: { manual: new ManualTrigger() }, queues: { default: { concurrency: 4 } } });

describe('cron scheduling — end-to-end integration', () => {
  it('a due schedule fires and the run flows through the real pipeline to done', async () => {
    const store = new SqliteScheduleStore();
    store.upsert(mkSched({ nextDueAt: '2026-06-03T02:00:00.000Z' }));
    const orchestrator = mkOrch();
    const transport = loopbackTransport();
    const clock = Date.parse('2026-06-03T04:01:00Z'); // past the 02:00/03:00/04:00 slots
    const scheduler = new CronScheduler(store, () => clock);
    const ac = new AbortController();
    const loop = serve({ orchestrator, transport, scheduler, signal: ac.signal, tickIntervalMs: 1, now: () => clock });

    // Poll for the condition rather than sleeping a fixed duration — robust under parallel-suite CPU contention.
    const firedRuns = () => orchestrator.getStatus().filter((s) => s.runId.startsWith('nightly@'));
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const fired = firedRuns();
      if (fired.length > 0 && fired.every((s) => s.status === 'done')) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    ac.abort();
    await loop;

    const fired = firedRuns();
    expect(fired.length).toBeGreaterThan(0);
    expect(fired.every((s) => s.status === 'done')).toBe(true);
    // catch-up coalesced to one slot; runId = most-recent slot at/before now
    expect(new Set(transport.submitted)).toEqual(new Set(['nightly@2026-06-03T04:00:00.000Z']));
  });

  it('coalesces a long downtime backlog into exactly one catch-up run and advances past now', () => {
    const store = new SqliteScheduleStore();
    store.upsert(mkSched({ cronExpr: '0 * * * *', nextDueAt: '2026-06-03T00:00:00.000Z' })); // hourly
    const now = Date.parse('2026-06-03T09:30:00Z'); // 9+ missed slots
    const envs = new CronScheduler(store, () => now).dueSubmissions();
    expect(envs).toHaveLength(1);
    expect(envs[0].run.id).toBe('nightly@2026-06-03T09:00:00.000Z');
    expect(store.due(now)).toHaveLength(0);
    expect(store.list()[0].nextDueAt).toBe('2026-06-03T10:00:00.000Z');
  });

  it('deduplicates a re-emitted slot via the deterministic runId (crash before markFired persisted)', () => {
    const store = new SqliteScheduleStore();
    store.upsert(mkSched({ nextDueAt: '2026-06-03T02:00:00.000Z' }));
    const now = Date.parse('2026-06-03T02:30:00Z');
    const sched = new CronScheduler(store, () => now);
    const first = sched.dueSubmissions(); // emits nightly@02:00, markFired advances
    store.upsert(mkSched({ nextDueAt: '2026-06-03T02:00:00.000Z' })); // simulate crash: nextDueAt reset to same slot
    const second = sched.dueSubmissions(); // re-emits the SAME runId
    expect(first[0].run.id).toBe(second[0].run.id);

    const orchestrator = mkOrch();
    orchestrator.submitRun(first[0].run, first[0].actor);
    orchestrator.submitRun(second[0].run, second[0].actor); // idempotent no-op
    expect(new Set(orchestrator.getStatus().map((s) => s.runId)).size).toBe(1);
  });

  it('persists schedule bookkeeping across a store restart (file-backed, WAL)', () => {
    const path = tmpFile();
    const s1 = new SqliteScheduleStore(path);
    s1.upsert(mkSched({ nextDueAt: '2026-06-03T02:00:00.000Z' }));
    s1.markFired('nightly', Date.parse('2026-06-03T02:00:05Z'), '2026-06-03T03:00:00.000Z');
    s1.close(); // release the file lock before reopen

    const s2 = new SqliteScheduleStore(path); // "restart"
    const reloaded = s2.list()[0];
    expect(reloaded.nextDueAt).toBe('2026-06-03T03:00:00.000Z');
    expect(reloaded.lastFiredAt).toBe('2026-06-03T02:00:05.000Z');
    s2.close();
    rmSync(path, { force: true });
  });

  it('fires one distinct run per due schedule, leaving not-yet-due schedules alone', () => {
    const store = new SqliteScheduleStore();
    store.upsert(mkSched({ id: 'a', cronExpr: '0 * * * *', run: runTemplate('a'), nextDueAt: '2026-06-03T01:00:00.000Z' }));
    store.upsert(mkSched({ id: 'b', cronExpr: '0 * * * *', run: runTemplate('b'), nextDueAt: '2026-06-03T01:00:00.000Z' }));
    store.upsert(mkSched({ id: 'c', cronExpr: '0 * * * *', run: runTemplate('c'), nextDueAt: '2026-06-03T23:00:00.000Z' })); // future
    const now = Date.parse('2026-06-03T02:05:00Z');
    const ids = new CronScheduler(store, () => now).dueSubmissions().map((e) => e.run.id).sort();
    expect(ids).toEqual(['a@2026-06-03T02:00:00.000Z', 'b@2026-06-03T02:00:00.000Z']);
  });

  it('propagates an invalid stored cron expression out of dueSubmissions (serve contains it via onError)', () => {
    const store = new SqliteScheduleStore();
    store.upsert(mkSched({ cronExpr: 'not-a-cron', nextDueAt: '2026-06-03T02:00:00.000Z' }));
    const now = Date.parse('2026-06-03T03:00:00Z');
    expect(() => new CronScheduler(store, () => now).dueSubmissions()).toThrow();
  });

  it('computes UTC slot boundaries correctly for representative cron expressions', () => {
    expect(nextDueAfter('0 2 * * *', Date.parse('2026-06-03T02:00:00Z'))).toBe('2026-06-04T02:00:00.000Z'); // exact boundary → strictly next
    expect(nextDueAfter('*/15 * * * *', Date.parse('2026-06-03T10:07:00Z'))).toBe('2026-06-03T10:15:00.000Z'); // step
    expect(nextDueAfter('0 0 29 2 *', Date.parse('2026-06-03T00:00:00Z'))).toBe('2028-02-29T00:00:00.000Z'); // Feb 29 leap-only
    expect(nextDueAfter('0 0 1 * *', Date.parse('2026-01-15T00:00:00Z'))).toBe('2026-02-01T00:00:00.000Z'); // month rollover
  });
});
