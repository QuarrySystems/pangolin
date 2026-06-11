import parser from 'cron-parser';
import type { ScheduleStore, SubmissionEnvelope } from '../contracts/index.js';

/** Next scheduled slot strictly after `afterMs`, as an ISO-8601 string (UTC). */
export function nextDueAfter(cronExpr: string, afterMs: number): string {
  const it = parser.parseExpression(cronExpr, { currentDate: new Date(afterMs), tz: 'UTC' });
  return it.next().toDate().toISOString();
}

export class CronScheduler {
  constructor(private readonly store: ScheduleStore, private readonly now: () => number) {}

  /** For each due schedule: emit ONE envelope for the most-recent missed slot,
   *  then advance bookkeeping. Coalesces backlog → single catch-up. */
  dueSubmissions(): SubmissionEnvelope[] {
    const nowMs = this.now();
    const out: SubmissionEnvelope[] = [];
    for (const s of this.store.due(nowMs)) {
      const slotIso = this.mostRecentSlotAtOrBefore(s.cronExpr, nowMs);  // <= now
      out.push({
        run: { ...s.run, id: `${s.id}@${slotIso}` },   // deterministic runId → free dedup
        actor: s.actor,
        submittedAt: new Date(nowMs).toISOString(),
      });
      this.store.markFired(s.id, nowMs, nextDueAfter(s.cronExpr, nowMs));
    }
    return out;
  }

  private mostRecentSlotAtOrBefore(cronExpr: string, nowMs: number): string {
    const it = parser.parseExpression(cronExpr, { currentDate: new Date(nowMs), tz: 'UTC' });
    return it.prev().toDate().toISOString();
  }
}
