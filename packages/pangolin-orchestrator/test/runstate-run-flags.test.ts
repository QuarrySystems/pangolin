import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteRunStateStore } from '../src/runstate/sqlite.js';

it('open/closed flags default false, set independently, idempotent, durable', () => {
  const s = new SqliteRunStateStore();
  expect([s.isOpenEnded!('r1'), s.isClosed!('r1')]).toEqual([false, false]);
  s.markOpenEnded!('r1');
  s.markOpenEnded!('r1'); // idempotent
  expect([s.isOpenEnded!('r1'), s.isClosed!('r1')]).toEqual([true, false]);
  s.markClosed!('r1');
  expect([s.isOpenEnded!('r1'), s.isClosed!('r1')]).toEqual([true, true]);
});

describe('run flags durability', () => {
  it('flags set then close()+reopen at same path still read back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'run-flags-'));
    const dbPath = join(dir, 'state.db');
    try {
      // Set flags and close
      const s1 = new SqliteRunStateStore(dbPath);
      s1.markOpenEnded!('run-abc');
      s1.markClosed!('run-abc');
      s1.close();

      // Reopen and verify flags persisted
      const s2 = new SqliteRunStateStore(dbPath);
      expect(s2.isOpenEnded!('run-abc')).toBe(true);
      expect(s2.isClosed!('run-abc')).toBe(true);
      // A run that was never flagged still reads false
      expect(s2.isOpenEnded!('run-xyz')).toBe(false);
      expect(s2.isClosed!('run-xyz')).toBe(false);
      s2.close();
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  it('markOpenEnded does not set closed, markClosed does not set open_ended', () => {
    const s = new SqliteRunStateStore();
    s.markOpenEnded!('r2');
    expect(s.isOpenEnded!('r2')).toBe(true);
    expect(s.isClosed!('r2')).toBe(false);

    const s2 = new SqliteRunStateStore();
    s2.markClosed!('r3');
    expect(s2.isOpenEnded!('r3')).toBe(false);
    expect(s2.isClosed!('r3')).toBe(true);
  });
});
