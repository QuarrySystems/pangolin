import { it, expect } from 'vitest';
import { readOutputSentinel } from '../src/sentinel-read.js';

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

it('returns absent when the provider throws an ENOENT-coded error', async () => {
  const storage = {
    get: async () => {
      const err = new Error('boom') as Error & { code?: string };
      err.code = 'ENOENT';
      throw err;
    },
  };
  const res = await readOutputSentinel({ storage: storage as never, namespace: 'ns' }, 'd1');
  expect(res).toEqual({ status: 'absent' });
});

it('returns absent when the provider throws an error whose message matches /not found/i', () => {
  const storage = {
    get: async () => {
      throw new Error('Object Not Found');
    },
  };
  return readOutputSentinel({ storage: storage as never, namespace: 'ns' }, 'd1').then((res) => {
    expect(res).toEqual({ status: 'absent' });
  });
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
    };
    readonly namespace = 'ns';
    someOtherMethod() {
      return 'irrelevant';
    }
  }
  const client = new FakeClient();
  const res = await readOutputSentinel(client as never, 'd1');
  expect(res).toEqual({ status: 'ok', sentinel: { schemaVersion: 1 } });
});
