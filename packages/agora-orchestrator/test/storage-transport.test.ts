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
});
