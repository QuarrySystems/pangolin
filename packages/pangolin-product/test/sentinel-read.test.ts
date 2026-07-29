import { it, expect } from 'vitest';
import { readOutputSentinel } from '../src/sentinel-read.js';
import { StorageNotFoundError, type StorageProvider } from '@quarry-systems/pangolin-core';

it('propagates a non-not-found storage error instead of reporting absent', async () => {
  const storage = {
    get: async () => {
      throw new Error('connection reset');
    },
  };
  await expect(
    readOutputSentinel({ storage: storage as never, namespace: 'ns' }, 'd1'),
  ).rejects.toThrow('connection reset');
});

it('reads from the URI built by buildDispatchRecordUri, not string concatenation', async () => {
  const seen: string[] = [];
  const storage = {
    get: async (uri: string) => {
      seen.push(uri);
      return new TextEncoder().encode(JSON.stringify({ schemaVersion: 1 }));
    },
  };
  await readOutputSentinel({ storage: storage as never, namespace: 'ns' }, 'd1');
  expect(seen).toEqual(['pangolin://ns/dispatches/d1/output.json']);
});

it('returns absent when the provider throws a StorageNotFoundError', async () => {
  const storage = {
    get: async () => {
      throw new StorageNotFoundError('pangolin://ns/dispatches/d1/output.json');
    },
  };
  const res = await readOutputSentinel({ storage: storage as never, namespace: 'ns' }, 'd1');
  expect(res).toEqual({ status: 'absent' });
});

it('does NOT treat a generic /not found/i message as absent', async () => {
  const storage = {
    async get() {
      throw new Error('DNS lookup failed: host not found');
    },
  };
  await expect(
    readOutputSentinel({ storage: storage as never, namespace: 'ns' }, 'd1'),
  ).rejects.toThrow(/DNS lookup failed/); // today this resolves to { status: 'absent' }
});

it('returns exactly what parseOutputSentinel returns for the fetched bytes on success', async () => {
  const storage = {
    get: async () =>
      new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, summary: 'did a thing' })),
  };
  const res = await readOutputSentinel({ storage: storage as never, namespace: 'ns' }, 'd1');
  expect(res).toEqual({
    status: 'ok',
    sentinel: { schemaVersion: 1, summary: 'did a thing' },
  });
});

it('returns malformed when parseOutputSentinel rejects the fetched bytes', async () => {
  const storage = {
    get: async () => new TextEncoder().encode('not json {'),
  };
  const res = await readOutputSentinel({ storage: storage as never, namespace: 'ns' }, 'd1');
  expect(res).toEqual({ status: 'malformed', reason: 'not-json' });
});

it('throws for an empty-string dispatchId rather than reading an unintended prefix', async () => {
  const storage = {
    get: async () => {
      throw new Error('should not be called');
    },
  };
  await expect(
    readOutputSentinel({ storage: storage as never, namespace: 'ns' }, ''),
  ).rejects.toThrow();
});

it('accepts a structural deps object shaped like a PangolinClient without adaptation', async () => {
  class FakeClient {
    readonly storage = {
      get: async () => new TextEncoder().encode(JSON.stringify({ schemaVersion: 1 })),
    } as unknown as StorageProvider;
    readonly namespace = 'ns';
    someOtherMethod() {
      return 'irrelevant';
    }
  }
  const client = new FakeClient();
  const res = await readOutputSentinel(client, 'd1');
  expect(res).toEqual({ status: 'ok', sentinel: { schemaVersion: 1 } });
});
