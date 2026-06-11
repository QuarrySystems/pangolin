import { it, expect } from 'vitest';
import type { Schedule, ScheduleStore } from '../src/contracts/index.js';

it("ScheduleStore is implementable and Schedule round-trips through it", () => {
  const rows = new Map<string, Schedule>();
  const store: ScheduleStore = {
    due: () => [],
    markFired: () => {},
    upsert: (s) => { rows.set(s.id, s); },
    remove: (id) => { rows.delete(id); },
    list: () => [...rows.values()],
  };
  const s: Schedule = { id: "nightly", cronExpr: "0 2 * * *", run: { id: "r", queue: "default", items: [] }, actor: "human:test", nextDueAt: "2026-06-03T02:00:00Z" };
  store.upsert(s);
  expect(store.list()).toEqual([s]);
});
