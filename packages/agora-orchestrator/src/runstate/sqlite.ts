// packages/agora-orchestrator/src/runstate/sqlite.ts
//
// SINGLE-WRITER INVARIANT (D3): this DB is the orchestrator service's exclusive
// property. Do NOT open it from the CLI, MCP, or any other process — those are
// clients of the running service, not of this file. Concurrent writers from
// separate processes are unsupported and will corrupt run-state.
//
import Database from 'better-sqlite3';
import type { VerifyOutcome } from '@quarry-systems/agora-core';
import type { AnchoredRoot, AuditEntryRow, AuditStore, ItemState, Run, RunStateStore, RunStatus, TerminalStatus } from '../contracts/index.js';

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
  result_ref: string | null;
  verify: string | null;
  output_refs: string | null;
  manifest_ref: string | null;
  submitted_at: string | null;
  needs: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS queues (name TEXT PRIMARY KEY, concurrency INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, queue TEXT NOT NULL, executor TEXT NOT NULL,
  inputs TEXT NOT NULL, depends_on TEXT NOT NULL, resource_locks TEXT NOT NULL,
  status TEXT NOT NULL, dispatch_hash TEXT, subagent_shape TEXT, reason TEXT,
  actor TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at REAL,
  result_ref TEXT, verify TEXT, output_refs TEXT, manifest_ref TEXT, submitted_at TEXT,
  needs TEXT
);
CREATE TABLE IF NOT EXISTS locks (key TEXT PRIMARY KEY, item_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_entries (
  run_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
  item_id TEXT, status TEXT, actor TEXT, manifest_ref TEXT, result_ref TEXT,
  at TEXT NOT NULL, entry_hash TEXT NOT NULL, prev_hash TEXT NOT NULL,
  PRIMARY KEY (run_id, seq));
CREATE TABLE IF NOT EXISTS audit_roots (
  epoch_id TEXT PRIMARY KEY, root BLOB NOT NULL,
  sig_alg TEXT, sig_bytes BLOB, sig_keyref TEXT,
  anchor_id TEXT NOT NULL, guarantee TEXT NOT NULL, receipt_at INTEGER NOT NULL,
  locator TEXT, anchored_at TEXT NOT NULL);
`;

/** Columns added after the initial release — bring a pre-existing db up to date. */
const MIGRATIONS: ReadonlyArray<readonly [string, string]> = [
  ['subagent_shape', 'TEXT'],
  ['reason', 'TEXT'],
  ['actor', 'TEXT'],
  ['attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ['next_attempt_at', 'REAL'],
  ['result_ref', 'TEXT'],
  ['verify', 'TEXT'],
  ['output_refs', 'TEXT'],
  ['manifest_ref', 'TEXT'],
  ['submitted_at', 'TEXT'],
  ['needs', 'TEXT'],
];

export class SqliteRunStateStore implements RunStateStore, AuditStore {
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

  saveRun(run: Run, actor?: string, submittedAt?: string): void {
    const ins = this.db.prepare(
      'INSERT INTO items(id,run_id,queue,executor,inputs,depends_on,resource_locks,status,dispatch_hash,subagent_shape,reason,actor,attempts,next_attempt_at,result_ref,verify,output_refs,manifest_ref,submitted_at,needs) VALUES(?,?,?,?,?,?,?,?,NULL,?,NULL,?,0,NULL,NULL,NULL,NULL,NULL,?,?)',
    );
    const tx = this.db.transaction((r: Run) => {
      for (const it of r.items)
        ins.run(it.id, r.id, r.queue, it.executor,
          JSON.stringify(it.inputs), JSON.stringify(it.depends_on),
          JSON.stringify(it.resourceLocks), 'pending',
          it.subagentShape ?? null, actor ?? null, submittedAt ?? null,
          it.needs != null ? JSON.stringify(it.needs) : null);
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

  setResultRef(itemId: string, ref: string): void {
    this.db.prepare('UPDATE items SET result_ref=? WHERE id=?').run(ref, itemId);
  }

  setVerify(itemId: string, verify: VerifyOutcome): void {
    this.db.prepare('UPDATE items SET verify=? WHERE id=?').run(JSON.stringify(verify), itemId);
  }

  setOutputRefs(itemId: string, outputRefs: Record<string, string>): void {
    this.db.prepare('UPDATE items SET output_refs=? WHERE id=?').run(JSON.stringify(outputRefs), itemId);
  }

  setManifestRef(itemId: string, ref: string): void {
    this.db.prepare('UPDATE items SET manifest_ref=? WHERE id=?').run(ref, itemId);
  }

  // ── AuditStore ────────────────────────────────────────────────────────────

  appendAuditEntry(r: AuditEntryRow): void {
    this.db.prepare(
      `INSERT INTO audit_entries
        (run_id,seq,kind,item_id,status,actor,manifest_ref,result_ref,at,entry_hash,prev_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      r.runId, r.seq, r.kind,
      r.itemId ?? null, r.status ?? null, r.actor ?? null,
      r.manifestRef ?? null, r.resultRef ?? null,
      r.at, r.entryHash, r.prevHash,
    );
  }

  getAuditEntries(runId: string): AuditEntryRow[] {
    interface AuditEntryDbRow {
      run_id: string; seq: number; kind: string;
      item_id: string | null; status: string | null; actor: string | null;
      manifest_ref: string | null; result_ref: string | null;
      at: string; entry_hash: string; prev_hash: string;
    }
    const rows = this.db.prepare(
      'SELECT * FROM audit_entries WHERE run_id=? ORDER BY seq'
    ).all(runId) as AuditEntryDbRow[];
    return rows.map((row): AuditEntryRow => {
      const entry: AuditEntryRow = {
        runId: row.run_id,
        seq: row.seq,
        kind: row.kind as AuditEntryRow['kind'],
        at: row.at,
        entryHash: row.entry_hash,
        prevHash: row.prev_hash,
      };
      if (row.item_id !== null) entry.itemId = row.item_id;
      if (row.status !== null) entry.status = row.status;
      if (row.actor !== null) entry.actor = row.actor;
      if (row.manifest_ref !== null) entry.manifestRef = row.manifest_ref;
      if (row.result_ref !== null) entry.resultRef = row.result_ref;
      return entry;
    });
  }

  getAuditChainHead(runId: string): string {
    const row = this.db.prepare(
      'SELECT entry_hash FROM audit_entries WHERE run_id=? ORDER BY seq DESC LIMIT 1'
    ).get(runId) as { entry_hash: string } | undefined;
    return row?.entry_hash ?? '';
  }

  putAuditRoot(root: AnchoredRoot): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO audit_roots
        (epoch_id, root, sig_alg, sig_bytes, sig_keyref,
         anchor_id, guarantee, receipt_at, locator, anchored_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      root.epochId,
      Buffer.from(root.root),
      root.signature?.alg ?? null,
      root.signature ? Buffer.from(root.signature.bytes) : null,
      root.signature?.keyRef ?? null,
      root.receipt.anchorId,
      root.receipt.guarantee,
      root.receipt.at,
      root.receipt.locator ?? null,
      new Date().toISOString(),
    );
  }

  getAuditRoot(epochId: string): AnchoredRoot | undefined {
    interface AuditRootDbRow {
      epoch_id: string; root: Buffer;
      sig_alg: string | null; sig_bytes: Buffer | null; sig_keyref: string | null;
      anchor_id: string; guarantee: string; receipt_at: number;
      locator: string | null; anchored_at: string;
    }
    const row = this.db.prepare(
      'SELECT * FROM audit_roots WHERE epoch_id=?'
    ).get(epochId) as AuditRootDbRow | undefined;
    if (!row) return undefined;

    const result: AnchoredRoot = {
      epochId: row.epoch_id,
      root: new Uint8Array(row.root),
      receipt: {
        anchorId: row.anchor_id,
        epochId: row.epoch_id,
        guarantee: row.guarantee as AnchoredRoot['receipt']['guarantee'],
        at: row.receipt_at,
      },
    };
    if (row.locator !== null) result.receipt.locator = row.locator;
    if (row.sig_alg !== null && row.sig_bytes !== null) {
      result.signature = {
        alg: row.sig_alg,
        bytes: new Uint8Array(row.sig_bytes),
      };
      if (row.sig_keyref !== null) result.signature.keyRef = row.sig_keyref;
    }
    return result;
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
    resultRef: r.result_ref ?? undefined,
    verify: r.verify ? JSON.parse(r.verify) : undefined,
    outputRefs: r.output_refs ? JSON.parse(r.output_refs) : undefined,
    manifestRef: r.manifest_ref ?? undefined,
    submittedAt: r.submitted_at ?? undefined,
    needs: r.needs ? JSON.parse(r.needs) : undefined,
  });
}
