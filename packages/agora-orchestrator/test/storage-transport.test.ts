import { describe, it, expect } from 'vitest';
import type { MailboxStore } from '../src/contracts/index.js';
import { MailboxSubmissionTransport } from '../src/transport/storage-transport.js';

/** Map-backed MailboxStore fake for unit tests. */
function memMailbox(): MailboxStore {
  const m = new Map<string, Uint8Array>();
  return {
    async put(key, bytes) { m.set(key, bytes); },
    async get(key) { return m.get(key) ?? null; },
    async list(prefix) {
      const dirPrefix = prefix.endsWith('/') ? prefix : prefix + '/';
      return [...m.keys()].filter((k) => k === prefix || k.startsWith(dirPrefix));
    },
    async delete(key) { m.delete(key); },
  };
}

/** A MailboxStore fake that records all put keys for inspection. */
function spyMailbox(): MailboxStore & { putKeys: string[] } {
  const m = new Map<string, Uint8Array>();
  const putKeys: string[] = [];
  return {
    putKeys,
    async put(key: string, bytes: Uint8Array) { m.set(key, bytes); putKeys.push(key); },
    async get(key: string) { return m.get(key) ?? null; },
    async list(prefix: string) {
      const dirPrefix = prefix.endsWith('/') ? prefix : prefix + '/';
      return [...m.keys()].filter((k) => k === prefix || k.startsWith(dirPrefix));
    },
    async delete(key: string) { m.delete(key); },
  } as MailboxStore & { putKeys: string[] };
}

/** A MailboxStore that throws on put for testing error handling. */
function failingMailbox(): MailboxStore {
  return {
    async put() { throw new Error('disk full'); },
    async get() { return null; },
    async list() { return []; },
    async delete() { /* no-op */ },
  };
}

describe('mailbox submission transport', () => {
  it('submit→pollInbox returns the envelope', async () => {
    const t = new MailboxSubmissionTransport(memMailbox());
    await t.submit({ run: { id: 'r1', queue: 'default', items: [] }, actor: 'human:b', submittedAt: '2026-05-30T00:00:00Z' });
    const results = await t.pollInbox();
    expect(results.map((e) => e.run.id)).toEqual(['r1']);
  });

  it('pollInbox AGAIN still returns the envelope (not consumed until ack)', async () => {
    const t = new MailboxSubmissionTransport(memMailbox());
    await t.submit({ run: { id: 'r1', queue: 'default', items: [] }, actor: 'human:b', submittedAt: '2026-05-30T00:00:00Z' });
    await t.pollInbox(); // first poll - does NOT consume
    const second = await t.pollInbox();
    expect(second.map((e) => e.run.id)).toEqual(['r1']);
  });

  it('after ack(runId), pollInbox returns empty array', async () => {
    const t = new MailboxSubmissionTransport(memMailbox());
    await t.submit({ run: { id: 'r1', queue: 'default', items: [] }, actor: 'human:b', submittedAt: '2026-05-30T00:00:00Z' });
    await t.ack('r1');
    const results = await t.pollInbox();
    expect(results).toEqual([]);
  });

  it('publish→readOutbox round-trips in publish order', async () => {
    const t = new MailboxSubmissionTransport(memMailbox());
    const recs = [
      { runId: 'run-ord', kind: 'status' as const, body: { seq: 1 }, at: '2026-05-30T00:00:01Z' },
      { runId: 'run-ord', kind: 'status' as const, body: { seq: 2 }, at: '2026-05-30T00:00:02Z' },
      { runId: 'run-ord', kind: 'status' as const, body: { seq: 3 }, at: '2026-05-30T00:00:03Z' },
    ];
    for (const r of recs) await t.publish(r);
    const results = await t.readOutbox('run-ord');
    expect(results).toHaveLength(3);
    expect(results.map((r) => (r.body as { seq: number }).seq)).toEqual([1, 2, 3]);
  });

  it('a failing mbox.put in submit throws with run-id context', async () => {
    const t = new MailboxSubmissionTransport(failingMailbox());
    await expect(
      t.submit({ run: { id: 'r4', queue: 'default', items: [] }, actor: 'human:b', submittedAt: '2026-05-30T00:00:00Z' })
    ).rejects.toMatchObject({
      message: expect.stringContaining('r4'),
      cause: expect.objectContaining({ message: 'disk full' }),
    });
  });

  it('two publishes for the same run in the same millisecond both round-trip without collision', async () => {
    const t = new MailboxSubmissionTransport(memMailbox());
    const now = '2026-05-30T12:34:56.000Z';
    const rec1 = { runId: 'run-col', kind: 'status' as const, body: { seq: 1 }, at: now };
    const rec2 = { runId: 'run-col', kind: 'status' as const, body: { seq: 2 }, at: now };
    await t.publish(rec1);
    await t.publish(rec2);
    const results = await t.readOutbox('run-col');
    expect(results).toHaveLength(2);
  });

  it('outbox key contains no Windows-illegal characters (no colons or special chars)', async () => {
    const spy = spyMailbox();
    const t = new MailboxSubmissionTransport(spy);
    const rec = { runId: 'run-abc', kind: 'status' as const, body: {}, at: '2026-05-30T12:34:56.789Z' };
    await t.publish(rec);
    const outboxPuts = spy.putKeys.filter((k) => k.includes('/outbox/'));
    expect(outboxPuts).toHaveLength(1);
    // Key must only contain word chars, dots, hyphens, forward slashes
    expect(outboxPuts[0]).toMatch(/^[\w.\-/]+$/);
    expect(outboxPuts[0]).not.toContain(':');
  });

  it('deadLetter moves submission to dead/ prefix and removes from inbox', async () => {
    const mbox = memMailbox();
    const t = new MailboxSubmissionTransport(mbox);
    await t.submit({ run: { id: 'r-dead', queue: 'default', items: [] }, actor: 'human:b', submittedAt: '2026-05-30T00:00:00Z' });
    // Confirm it's in inbox before dead-lettering
    const before = await t.pollInbox();
    expect(before.map((e) => e.run.id)).toContain('r-dead');
    // Dead-letter it
    await t.deadLetter('r-dead');
    // Inbox should no longer return it
    const after = await t.pollInbox();
    expect(after.map((e) => e.run.id)).not.toContain('r-dead');
    // dead/<runId>.json key must exist in the mailbox
    const deadBytes = await mbox.get('orchestrator/dead/r-dead.json');
    expect(deadBytes).not.toBeNull();
  });

  it('deadLetter is a no-op when the inbox entry does not exist (idempotent)', async () => {
    const mbox = memMailbox();
    const t = new MailboxSubmissionTransport(mbox);
    // Should not throw even if no inbox entry exists
    await expect(t.deadLetter('nonexistent')).resolves.toBeUndefined();
    // And the dead key should not have been written (get returns null)
    const deadBytes = await mbox.get('orchestrator/dead/nonexistent.json');
    expect(deadBytes).toBeNull();
  });
});
