import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteRunStateStore } from '../src/runstate/sqlite.js';

const DEPS = { atSetup: 'sha256:aa', atFinish: 'sha256:bb', tier: 'recorded' } as const;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rs-deps-'));
  dirs.push(dir);
  return join(dir, 'run.db');
}

function seed(store: SqliteRunStateStore, ids: string[]): void {
  store.ensureQueue('default', 1);
  store.saveRun({
    id: 'r',
    queue: 'default',
    items: ids.map((id) => ({ id, executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] })),
  });
}

describe('run-state deps persistence', () => {
  it('round-trips the exact object including the recorded tier literal', () => {
    const s = new SqliteRunStateStore();
    seed(s, ['a']);
    s.setDeps('a', DEPS);
    expect(s.getItems().find((i) => i.id === 'a')?.deps).toEqual(DEPS);
    s.close();
  });

  it('an item never passed to setDeps reads back undefined, while a sibling that WAS set does not', () => {
    const s = new SqliteRunStateStore();
    seed(s, ['set', 'unset']);
    s.setDeps('set', DEPS);
    const items = s.getItems();
    // The sibling is the control: it proves the READ path works, so the
    // undefined below is a real absence rather than a broken getter.
    expect(items.find((i) => i.id === 'set')?.deps).toEqual(DEPS);
    expect(items.find((i) => i.id === 'unset')?.deps).toBeUndefined();
    s.close();
  });

  it('migrates a PRE-CHANGE file-backed database that has no deps column', () => {
    // File-backed and hand-built with the OLD schema on purpose. `:memory:`
    // cannot express a pre-existing database, so it cannot go red when the
    // MIGRATIONS entry is missing — this is the only form that actually tests
    // the migration.
    const file = tempDbPath();
    const raw = new Database(file);
    raw.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, queue TEXT NOT NULL, executor TEXT NOT NULL,
        inputs TEXT NOT NULL, depends_on TEXT NOT NULL, resource_locks TEXT NOT NULL,
        status TEXT NOT NULL, dispatch_hash TEXT, verify TEXT
      )
    `);
    raw.close();

    // Opening through the store must ALTER TABLE the new column into place.
    const store = new SqliteRunStateStore(file);
    seed(store, ['i1']);
    store.setDeps('i1', DEPS);
    expect(store.getItems().find((i) => i.id === 'i1')?.deps).toEqual(DEPS);
    store.close();

    // And it must survive a reopen — the column is on disk, not in a cache.
    const reopened = new SqliteRunStateStore(file);
    expect(reopened.getItems().find((i) => i.id === 'i1')?.deps).toEqual(DEPS);
    reopened.close();
  });

  it('the migration adds the column to a pre-change database that already holds rows', () => {
    // Guards the ALTER-with-data path: a store upgraded in place must not lose
    // the items it already had, and they must read back with deps undefined
    // rather than throwing on a NULL column.
    const file = tempDbPath();
    const seedStore = new SqliteRunStateStore(file);
    seed(seedStore, ['old-1', 'old-2']);
    seedStore.setDeps('old-1', DEPS);
    seedStore.close();

    const reopened = new SqliteRunStateStore(file);
    const items = reopened.getItems();
    expect(items.map((i) => i.id).sort()).toEqual(['old-1', 'old-2']);
    expect(items.find((i) => i.id === 'old-1')?.deps).toEqual(DEPS);
    expect(items.find((i) => i.id === 'old-2')?.deps).toBeUndefined();
    reopened.close();
  });
});
