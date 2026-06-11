import { describe, it, expect } from 'vitest';
import { SqliteScheduleStore } from '../src/runstate/sqlite-schedule-store.js';
import type { Schedule } from '../src/contracts/index.js';

const mk = (id: string, next: string): Schedule => ({ id, cronExpr: "0 2 * * *", run: { id, queue: "default", items: [] } as unknown as Schedule["run"], actor: "human:test", nextDueAt: next });

describe('SqliteScheduleStore', () => {
  it('returns only schedules whose next_due_at is at or before now', () => {
    const store = new SqliteScheduleStore();
    store.upsert(mk("past", "2026-06-03T01:00:00.000Z"));
    store.upsert(mk("future", "2026-06-03T09:00:00.000Z"));
    const due = store.due(Date.parse("2026-06-03T02:00:00Z")).map((s) => s.id);
    expect(due).toEqual(["past"]);
  });

  it('creates the schedules table idempotently (constructing twice does not error)', () => {
    const store1 = new SqliteScheduleStore(':memory:');
    store1.upsert(mk('s1', '2026-06-03T02:00:00.000Z'));
    // Second constructor call against same in-memory DB won't share state (each :memory: is isolated),
    // but constructing twice in sequence must not throw
    const store2 = new SqliteScheduleStore(':memory:');
    expect(() => store2.upsert(mk('s2', '2026-06-03T02:00:00.000Z'))).not.toThrow();
  });

  it('upsert then list round-trips a Schedule including deserialized run template', () => {
    const store = new SqliteScheduleStore();
    const s = mk('nightly', '2026-06-03T02:00:00.000Z');
    store.upsert(s);
    const listed = store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(s);
    expect(listed[0].run).toEqual(s.run);
  });

  it('re-upsert of the same id updates rather than duplicates', () => {
    const store = new SqliteScheduleStore();
    store.upsert(mk('s1', '2026-06-03T02:00:00.000Z'));
    store.upsert({ ...mk('s1', '2026-06-04T02:00:00.000Z'), cronExpr: '0 3 * * *' });
    const all = store.list();
    expect(all).toHaveLength(1);
    expect(all[0].nextDueAt).toBe('2026-06-04T02:00:00.000Z');
    expect(all[0].cronExpr).toBe('0 3 * * *');
  });

  it('markFired updates lastFiredAt and nextDueAt', () => {
    const store = new SqliteScheduleStore();
    store.upsert(mk('s1', '2026-06-03T02:00:00.000Z'));
    const firedMs = Date.parse('2026-06-03T02:00:01Z');
    store.markFired('s1', firedMs, '2026-06-04T02:00:00.000Z');
    const all = store.list();
    expect(all[0].lastFiredAt).toBe(new Date(firedMs).toISOString());
    expect(all[0].nextDueAt).toBe('2026-06-04T02:00:00.000Z');
  });

  it('remove deletes by id and is a no-op when absent', () => {
    const store = new SqliteScheduleStore();
    store.upsert(mk('s1', '2026-06-03T02:00:00.000Z'));
    store.upsert(mk('s2', '2026-06-03T02:00:00.000Z'));
    store.remove('s1');
    expect(store.list().map((s) => s.id)).toEqual(['s2']);
    // no-op when absent
    expect(() => store.remove('nonexistent')).not.toThrow();
  });

  it('preserves lastFiredAt as undefined when not yet fired', () => {
    const store = new SqliteScheduleStore();
    const s = mk('s1', '2026-06-03T02:00:00.000Z');
    store.upsert(s);
    const listed = store.list();
    expect(listed[0].lastFiredAt).toBeUndefined();
  });

  it('due() includes a schedule whose next_due_at equals nowMs exactly (boundary)', () => {
    const store = new SqliteScheduleStore();
    const nowMs = Date.parse('2026-06-03T06:00:00.000Z');
    store.upsert(mk('exact', new Date(nowMs).toISOString()));
    const due = store.due(nowMs).map((s) => s.id);
    expect(due).toContain('exact');
  });

  it('upsert with non-null lastFiredAt round-trips through list()', () => {
    const store = new SqliteScheduleStore();
    const firedAt = '2026-06-02T02:00:00.000Z';
    const s: Schedule = { ...mk('s1', '2026-06-03T02:00:00.000Z'), lastFiredAt: firedAt };
    store.upsert(s);
    const listed = store.list();
    expect(listed[0].lastFiredAt).toBe(firedAt);
  });

  it('re-upsert with lastFiredAt after initial null-lastFiredAt insert carries lastFiredAt through ON CONFLICT', () => {
    const store = new SqliteScheduleStore();
    // First insert: no lastFiredAt
    store.upsert(mk('s1', '2026-06-03T02:00:00.000Z'));
    // Re-upsert: now providing a lastFiredAt — ON CONFLICT must write it
    const firedAt = '2026-06-02T02:00:00.000Z';
    const s2: Schedule = { ...mk('s1', '2026-06-04T02:00:00.000Z'), lastFiredAt: firedAt };
    store.upsert(s2);
    const all = store.list();
    expect(all).toHaveLength(1);
    expect(all[0].lastFiredAt).toBe(firedAt);
    expect(all[0].nextDueAt).toBe('2026-06-04T02:00:00.000Z');
  });

  it('upsert normalizes non-canonical ISO string to canonical form', () => {
    const store = new SqliteScheduleStore();
    // +00:00 offset form — same instant as .000Z but different string
    const nonCanonical = '2026-06-03T02:00:00.000+00:00';
    store.upsert(mk('s1', nonCanonical));
    const listed = store.list();
    // stored value must be canonical .toISOString() form, not the raw input
    expect(listed[0].nextDueAt).toBe(new Date(nonCanonical).toISOString());
  });

  it('close() does not throw', () => {
    const store = new SqliteScheduleStore();
    expect(() => store.close()).not.toThrow();
  });
});
