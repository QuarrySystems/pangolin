import type { Schedule } from './schedule.js';

/** Persistence seam for schedules. Sole writer at runtime: serve. */
export interface ScheduleStore {
  /** Returns every schedule whose `nextDueAt <= now` (i.e. overdue or exactly due). */
  due(nowMs: number): Schedule[];
  /**
   * Record a successful fire and advance the schedule to its next slot.
   *
   * `firedAtMs` is epoch-milliseconds from the tick clock — the same domain as
   * `due`'s `nowMs` parameter — so callers can pass `Date.now()` or the loop's
   * `now` variable without conversion.
   *
   * `nextDueAt` is the ISO-8601 string produced by the cron library for the next
   * slot; the store is responsible for normalising `firedAtMs` to ISO-8601 (via
   * `new Date(firedAtMs).toISOString()`) before persisting it as `lastFiredAt`.
   */
  markFired(id: string, firedAtMs: number, nextDueAt: string): void;
  upsert(s: Schedule): void;
  remove(id: string): void;
  list(): Schedule[];
}
