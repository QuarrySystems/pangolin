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
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS queues (name TEXT PRIMARY KEY, concurrency INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, queue TEXT NOT NULL, executor TEXT NOT NULL,
  inputs TEXT NOT NULL, depends_on TEXT NOT NULL, resource_locks TEXT NOT NULL,
  status TEXT NOT NULL, dispatch_hash TEXT, subagent_shape TEXT, reason TEXT
);
CREATE TABLE IF NOT EXISTS locks (key TEXT PRIMARY KEY, item_id TEXT NOT NULL);
`;

export class SqliteRunStateStore implements RunStateStore {
  private db: Database.Database;

  constructor(path = ':memory:') {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL'); // no-op for :memory:; applies to file-backed DBs (the production deploy)
    this.db.exec(SCHEMA);
  }

  ensureQueue(name: string, concurrency: number): void {
    this.db
      .prepare(
        'INSERT INTO queues(name,concurrency) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET concurrency=excluded.concurrency',
      )
      .run(name, concurrency);
  }

  saveRun(run: Run): void {
    const tx = this.db.transaction((r: Run) => {
      for (const it of r.items)
        this.db.prepare(
          'INSERT INTO items(id,run_id,queue,executor,inputs,depends_on,resource_locks,status,dispatch_hash,subagent_shape,reason) VALUES(?,?,?,?,?,?,?,?,NULL,?,NULL)',
        ).run(it.id, r.id, r.queue, it.executor,
              JSON.stringify(it.inputs), JSON.stringify(it.depends_on),
              JSON.stringify(it.resourceLocks), 'pending',
              it.subagentShape ?? null);
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
  });
}
