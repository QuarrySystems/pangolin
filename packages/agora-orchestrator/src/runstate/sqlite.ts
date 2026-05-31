// packages/agora-orchestrator/src/runstate/sqlite.ts
//
// SINGLE-WRITER INVARIANT (D3): this DB is the orchestrator service's exclusive
// property. Do NOT open it from the CLI, MCP, or any other process — those are
// clients of the running service, not of this file. Concurrent writers from
// separate processes are unsupported and will corrupt run-state.
//
import Database from 'better-sqlite3';
import type { ItemState, Run, RunStateStore, RunStatus, TerminalStatus } from '../contracts/index.js';

/** Shape of a row in the `items` table (column names are snake_case). */
interface ItemRow {
  id: string;
  run_id: string;
  queue: string;
  executor: string;
  inputs: string;
  depends_on: string;
  resource_locks: string;
  status: RunStatus;
  dispatch_hash: string | null;
  subagent_shape: string | null;
  reason: string | null;
  actor: string | null;
  attempts: number | null;
  next_attempt_at: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS queues (name TEXT PRIMARY KEY, concurrency INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, queue TEXT NOT NULL, executor TEXT NOT NULL,
  inputs TEXT NOT NULL, depends_on TEXT NOT NULL, resource_locks TEXT NOT NULL,
  status TEXT NOT NULL, dispatch_hash TEXT, subagent_shape TEXT, reason TEXT,
  actor TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at REAL
);
CREATE TABLE IF NOT EXISTS locks (key TEXT PRIMARY KEY, item_id TEXT NOT NULL);
`;

/** Columns added after the initial release — bring a pre-existing db up to date. */
const MIGRATIONS: ReadonlyArray<readonly [string, string]> = [
  ['subagent_shape', 'TEXT'],
  ['reason', 'TEXT'],
  ['actor', 'TEXT'],
  ['attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ['next_attempt_at', 'REAL'],
];

export class SqliteRunStateStore implements RunStateStore {
  private db: Database.Database;

  constructor(path = ':memory:') {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL'); // no-op for :memory:; applies to file-backed DBs (the production deploy)
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Idempotent: add any missing post-release columns to a pre-existing `items` table. */
  private migrate(): void {
    const cols = new Set(
      (this.db.prepare('PRAGMA table_info(items)').all() as { name: string }[]).map((c) => c.name),
    );
    for (const [name, decl] of MIGRATIONS) {
      if (!cols.has(name)) this.db.exec(`ALTER TABLE items ADD COLUMN ${name} ${decl}`);
    }
  }

  ensureQueue(name: string, concurrency: number): void {
    this.db
      .prepare(
        'INSERT INTO queues(name,concurrency) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET concurrency=excluded.concurrency',
      )
      .run(name, concurrency);
  }

  saveRun(run: Run, actor?: string): void {
    const ins = this.db.prepare(
      'INSERT INTO items(id,run_id,queue,executor,inputs,depends_on,resource_locks,status,dispatch_hash,subagent_shape,reason,actor,attempts,next_attempt_at) VALUES(?,?,?,?,?,?,?,?,NULL,?,NULL,?,0,NULL)',
    );
    const tx = this.db.transaction((r: Run) => {
      for (const it of r.items)
        ins.run(it.id, r.id, r.queue, it.executor,
          JSON.stringify(it.inputs), JSON.stringify(it.depends_on),
          JSON.stringify(it.resourceLocks), 'pending',
          it.subagentShape ?? null, actor ?? null);
    });
    tx(run);
  }

  markReady(itemIds: string[]): void {
    const upd = this.db.prepare("UPDATE items SET status='ready' WHERE id=? AND status='pending'");
    const tx = this.db.transaction((ids: string[]) => {
      for (const id of ids) upd.run(id);
    });
    tx(itemIds);
  }

  setRunning(itemId: string, dispatchHash: string): void {
    this.db
      .prepare("UPDATE items SET status='running', dispatch_hash=? WHERE id=?")
      .run(dispatchHash, itemId);
  }

  setStatus(itemId: string, status: TerminalStatus, reason?: string): void {
    this.db.prepare('UPDATE items SET status=?, reason=? WHERE id=?').run(status, reason ?? null, itemId);
  }

  getItems(runId?: string): ItemState[] {
    const rows = (
      runId
        ? this.db.prepare('SELECT * FROM items WHERE run_id=? ORDER BY rowid').all(runId)
        : this.db.prepare('SELECT * FROM items ORDER BY rowid').all()
    ) as ItemRow[];
    return rows.map(this.rowToItem);
  }

  runningCount(queue: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) c FROM items WHERE queue=? AND status='running'")
        .get(queue) as { c: number }
    ).c;
  }

  queueConcurrency(queue: string): number {
    return (
      (this.db.prepare('SELECT concurrency FROM queues WHERE name=?').get(queue) as
        | { concurrency: number }
        | undefined)?.concurrency ?? 0
    );
  }

  heldLockKeys(): string[] {
    return (this.db.prepare('SELECT key FROM locks').all() as { key: string }[]).map((r) => r.key);
  }

  acquireLocks(itemId: string, keys: string[]): boolean {
    if (keys.length === 0) return true;
    const ins = this.db.prepare('INSERT INTO locks(key,item_id) VALUES(?,?)'); // PK conflict throws → better-sqlite3 rolls back the whole tx, so NO key is acquired (all-or-nothing)
    const tx = this.db.transaction((ks: string[]) => {
      for (const k of ks) ins.run(k, itemId);
    });
    try {
      tx(keys);
      return true;
    } catch {
      return false;
    }
  }

  releaseLocks(itemId: string): void {
    this.db.prepare('DELETE FROM locks WHERE item_id=?').run(itemId);
  }

  getActor(itemId: string): string | undefined {
    return (
      (this.db.prepare('SELECT actor FROM items WHERE id=?').get(itemId) as { actor: string | null } | undefined)
        ?.actor ?? undefined
    );
  }

  getAttempts(itemId: string): number {
    return (
      (this.db.prepare('SELECT attempts FROM items WHERE id=?').get(itemId) as { attempts: number | null } | undefined)
        ?.attempts ?? 0
    );
  }

  bumpAttempt(itemId: string): void {
    this.db.prepare('UPDATE items SET attempts = COALESCE(attempts,0) + 1 WHERE id=?').run(itemId);
  }

  requeue(itemId: string, notBeforeMs: number): void {
    this.db.prepare("UPDATE items SET status='ready', next_attempt_at=? WHERE id=?").run(notBeforeMs, itemId);
  }

  close(): void {
    this.db.close();
  }

  private rowToItem = (r: ItemRow): ItemState => ({
    id: r.id,
    runId: r.run_id,
    queue: r.queue,
    executor: r.executor,
    inputs: JSON.parse(r.inputs),
    depends_on: JSON.parse(r.depends_on),
    resourceLocks: JSON.parse(r.resource_locks),
    status: r.status,
    dispatchHash: r.dispatch_hash ?? undefined,
    subagentShape: r.subagent_shape ?? undefined,
    reason: r.reason ?? undefined,
    actor: r.actor ?? undefined,
    attempts: r.attempts ? r.attempts : undefined, // 0/null -> undefined (absent === 0)
    nextAttemptAt: r.next_attempt_at ?? undefined,
  });
}
