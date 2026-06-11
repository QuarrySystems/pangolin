import { it, expect } from 'vitest';
import { CronScheduler, nextDueAfter } from '../src/scheduling/cron-scheduler.js';
import type { Schedule, ScheduleStore } from '../src/contracts/index.js';

it("coalesces a multi-slot backlog into ONE envelope for the most recent missed slot", () => {
  const due: Schedule[] = [{ id: "nightly", cronExpr: "0 * * * *", run: { id: "tmpl", queue: "default", items: [] } as unknown as Schedule["run"], actor: "human:test", nextDueAt: "2026-06-03T02:00:00Z" }];
  const fired: Array<[string, string]> = [];
  const store: ScheduleStore = { due: () => due, markFired: (id, _at, next) => fired.push([id, next]), upsert: () => {}, remove: () => {}, list: () => due };
  const now = Date.parse("2026-06-03T04:01:00Z");
  const envs = new CronScheduler(store, () => now).dueSubmissions();

  expect(envs).toHaveLength(1);
  expect(envs[0].run.id).toBe("nightly@2026-06-03T04:00:00.000Z");   // most recent slot, deterministic id
  expect(fired[0][1]).toBe("2026-06-03T05:00:00.000Z");              // next future slot
});

it("nextDueAfter returns the next slot strictly after the given timestamp", () => {
  const result = nextDueAfter("0 2 * * *", Date.parse("2026-06-03T03:00:00Z"));
  expect(result).toBe("2026-06-04T02:00:00.000Z");
});

it("markFired is called once per due schedule", () => {
  const due: Schedule[] = [
    { id: "s1", cronExpr: "0 * * * *", run: { id: "r1", queue: "q", items: [] }, actor: "human:test", nextDueAt: "2026-06-03T01:00:00Z" },
    { id: "s2", cronExpr: "0 * * * *", run: { id: "r2", queue: "q", items: [] }, actor: "human:test", nextDueAt: "2026-06-03T01:00:00Z" },
  ];
  const firedIds: string[] = [];
  const store: ScheduleStore = {
    due: () => due,
    markFired: (id) => firedIds.push(id),
    upsert: () => {},
    remove: () => {},
    list: () => due,
  };
  const now = Date.parse("2026-06-03T02:01:00Z");
  new CronScheduler(store, () => now).dueSubmissions();
  expect(firedIds).toEqual(["s1", "s2"]);
});

it("emitted envelope has deterministic run.id = scheduleId@slotIso", () => {
  const due: Schedule[] = [{
    id: "hourly-job",
    cronExpr: "0 * * * *",
    run: { id: "tmpl-id", queue: "default", items: [] },
    actor: "human:brett",
    nextDueAt: "2026-06-03T10:00:00Z",
  }];
  const store: ScheduleStore = { due: () => due, markFired: () => {}, upsert: () => {}, remove: () => {}, list: () => due };
  const now = Date.parse("2026-06-03T10:30:00Z");
  const envs = new CronScheduler(store, () => now).dueSubmissions();
  expect(envs[0].run.id).toBe("hourly-job@2026-06-03T10:00:00.000Z");
  expect(envs[0].actor).toBe("human:brett");
});
