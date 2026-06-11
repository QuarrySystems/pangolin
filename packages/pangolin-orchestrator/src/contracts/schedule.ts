import type { Run } from './types.js';

/** A recurring submission source: a cron expression + a Run template. */
export interface Schedule {
  id: string;            // stable, user-chosen — e.g. "nightly-audit"
  cronExpr: string;      // standard 5-field cron (min hour dom mon dow), UTC
  run: Run;              // template; runId is rewritten per-fire to `${id}@${slotIso}`
  actor: string;         // identity stamped on every emitted submission
  lastFiredAt?: string;  // ISO-8601; undefined until first fire
  nextDueAt: string;     // ISO-8601; persisted for cheap due-checks
}
