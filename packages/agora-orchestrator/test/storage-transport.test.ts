import { describe, it, expect } from 'vitest';
import type { StorageProvider } from '@quarry-systems/agora-core';
import { StorageSubmissionTransport } from '../src/transport/storage-transport.js';

function memStorage(): StorageProvider {
  const m = new Map<string, Uint8Array>();
  return {
    name: 'mem',
    async put(uri, c) { m.set(uri, c); return { contentHash: 'h' }; },
    async get(uri) { return m.get(uri)!; },
    async list(prefix) {
      return [...m.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((uri) => ({ uri, contentHash: 'h', registeredAt: '' }));
    },
  } as unknown as StorageProvider;
}

/** A StorageProvider that records all put URIs for inspection. */
function spyStorage(): StorageProvider & { putUris: string[] } {
  const m = new Map<string, Uint8Array>();
  const putUris: string[] = [];
  return {
    putUris,
    name: 'spy',
    async put(uri: string, c: Uint8Array) { m.set(uri, c); putUris.push(uri); return { contentHash: 'h' }; },
    async get(uri: string) { return m.get(uri)!; },
    async list(prefix: string) {
      return [...m.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((uri) => ({ uri, contentHash: 'h', registeredAt: '' }));
    },
  } as unknown as StorageProvider & { putUris: string[] };
}

describe('storage submission transport', () => {
  it('round-trips a submission and never re-ingests a claimed one', async () => {
    const t = new StorageSubmissionTransport(memStorage());
    await t.submit({ run: { id: 'r1', queue: 'default', items: [] }, actor: 'human:b', submittedAt: '2026-05-30T00:00:00Z' });
    expect((await t.pollInbox()).map((e) => e.run.id)).toEqual(['r1']);
    expect(await t.pollInbox()).toEqual([]);
  });

  it('publish → readOutbox returns the record', async () => {
    const t = new StorageSubmissionTransport(memStorage());
    const rec = { runId: 'r2', kind: 'status' as const, body: { step: 1 }, at: '2026-05-30T01:00:00Z' };
    await t.publish(rec);
    const results = await t.readOutbox('r2');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ runId: 'r2', kind: 'status', body: { step: 1 } });
  });

  it('readOutbox skips empty/partial outbox objects without throwing', async () => {
    const storage = memStorage() as unknown as StorageProvider & { _put: (uri: string, c: Uint8Array) => void };
    const t = new StorageSubmissionTransport(storage);
    // Write an empty byte array to simulate a partial/empty outbox entry
    await storage.put('orchestrator/outbox/r3/2026-05-30T00:00:00Z.json', new Uint8Array(0));
    const results = await t.readOutbox('r3');
    expect(results).toEqual([]);
  });

  it('submit failure wraps the error with run id context', async () => {
    const failingStorage = {
      name: 'failing',
      async put() { throw new Error('disk full'); },
      async get() { return new Uint8Array(0); },
      async list() { return []; },
    } as unknown as StorageProvider;
    const t = new StorageSubmissionTransport(failingStorage);
    await expect(
      t.submit({ run: { id: 'r4', queue: 'default', items: [] }, actor: 'human:b', submittedAt: '2026-05-30T00:00:00Z' })
    ).rejects.toMatchObject({
      message: expect.stringContaining('r4'),
      cause: expect.objectContaining({ message: 'disk full' }),
    });
  });

  it('outbox object key contains no Windows-illegal characters (no colons or special chars)', async () => {
    const spy = spyStorage();
    const t = new StorageSubmissionTransport(spy);
    const rec = { runId: 'run-abc', kind: 'status' as const, body: {}, at: '2026-05-30T12:34:56.789Z' };
    await t.publish(rec);
    const outboxPuts = spy.putUris.filter((u) => u.includes('/outbox/'));
    expect(outboxPuts).toHaveLength(1);
    // Key must only contain word chars, dots, hyphens, forward slashes
    expect(outboxPuts[0]).toMatch(/^[\w.\-/]+$/);
    // Specifically no colons
    expect(outboxPuts[0]).not.toContain(':');
  });

  it('two publishes for the same run in the same millisecond both round-trip without collision', async () => {
    const t = new StorageSubmissionTransport(memStorage());
    const now = '2026-05-30T12:34:56.000Z'; // same timestamp for both
    const rec1 = { runId: 'run-col', kind: 'status' as const, body: { seq: 1 }, at: now };
    const rec2 = { runId: 'run-col', kind: 'status' as const, body: { seq: 2 }, at: now };
    await t.publish(rec1);
    await t.publish(rec2);
    const results = await t.readOutbox('run-col');
    expect(results).toHaveLength(2);
  });

  it('readOutbox returns records in publish order', async () => {
    const t = new StorageSubmissionTransport(memStorage());
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
});
