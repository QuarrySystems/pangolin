// packages/pangolin-orchestrator/src/runstate/sqlite-schedule-store.ts
import Database from 'better-sqlite3';
import type { Schedule, ScheduleStore } from '../contracts/index.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schedules (
  id            TEXT PRIMARY KEY,
  cron_expr     TEXT NOT NULL,
  run_template  TEXT NOT NULL,
  actor         TEXT NOT NULL,
  last_fired_at TEXT,
  next_due_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(next_due_at);`;

/** Explicit row shape (repo convention: cast to a named shape, not `any` — see sqlite.ts). */
interface ScheduleRow {
  id: string;
  cron_expr: string;
  run_template: string;
  actor: string;
  last_fired_at: string | null;
  next_due_at: string;
}

export class SqliteScheduleStore implements ScheduleStore {
  private db: Database.Database;

  constructor(path = ':memory:') {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  upsert(s: Schedule): void {
    const next = new Date(s.nextDueAt).toISOString();
    const last = s.lastFiredAt != null ? new Date(s.lastFiredAt).toISOString() : null;
    this.db.prepare(
      `INSERT INTO schedules(id,cron_expr,run_template,actor,last_fired_at,next_due_at)
       VALUES(@id,@cron,@run,@actor,@last,@next)
       ON CONFLICT(id) DO UPDATE SET cron_expr=@cron,run_template=@run,actor=@actor,last_fired_at=@last,next_due_at=@next`,
    ).run({ id: s.id, cron: s.cronExpr, run: JSON.stringify(s.run), actor: s.actor, last, next });
  }

  due(nowMs: number): Schedule[] {
    const iso = new Date(nowMs).toISOString();
    return (this.db.prepare('SELECT * FROM schedules WHERE next_due_at <= ?').all(iso) as ScheduleRow[]).map(this.row);
  }

  markFired(id: string, firedAtMs: number, nextDueAt: string): void {
    this.db.prepare('UPDATE schedules SET last_fired_at=?, next_due_at=? WHERE id=?')
      .run(new Date(firedAtMs).toISOString(), nextDueAt, id);
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM schedules WHERE id=?').run(id);
  }

  list(): Schedule[] {
    return (this.db.prepare('SELECT * FROM schedules ORDER BY id').all() as ScheduleRow[]).map(this.row);
  }

  close(): void {
    this.db.close();
  }

  private row = (r: ScheduleRow): Schedule => ({
    id: r.id,
    cronExpr: r.cron_expr,
    run: JSON.parse(r.run_template),
    actor: r.actor,
    lastFiredAt: r.last_fired_at ?? undefined,
    nextDueAt: r.next_due_at,
  });
}
