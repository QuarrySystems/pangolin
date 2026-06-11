import { describe, it, expect } from 'vitest';
import { describeDispatch, DispatchRecordExpiredError } from '../src/describe.js';
import { writeDispatchRecord } from '../src/retention.js';
import { PangolinClient } from '../src/client.js';
import type { DispatchResult, StorageProvider } from '@quarry-systems/pangolin-core';

/**
 * Minimal in-memory storage stub mirroring the one in retention.test.ts so the
 * round-trip tests here can write a real record via `writeDispatchRecord` and
 * read it back via `describeDispatch`.
 */
function makeMemoryStorage(): StorageProvider & {
  blobs: Map<string, Uint8Array>;
} {
  const blobs = new Map<string, Uint8Array>();
  return {
    name: 'memory',
    blobs,
    async put(uri: string, contents: Uint8Array) {
      blobs.set(uri, contents);
      return { contentHash: `sha256:${uri.length}` };
    },
    async get(uri: string) {
      const v = blobs.get(uri);
      if (!v) throw new Error(`memory storage: blob not found: ${uri}`);
      return v;
    },
    async resolveLatest() {
      return null;
    },
    async list() {
      return [];
    },
  };
}

function makeClient(storage: StorageProvider, maxDays = 30): PangolinClient {
  return new PangolinClient({
    namespace: 'o',
    compute: {},
    credentials: {},
    storage,
    targets: {},
    dispatchRetention: { maxDays },
  });
}

const baseResult: DispatchResult = {
  dispatchId: 'd1',
  exitCode: 0,
  stdout: 'captured stdout',
  stderr: 'captured stderr',
  durationMs: 4242,
  resolved: {
    subagent: { name: 'sub', contentHash: 'sha256:subhash' },
    capabilities: [{ name: 'cap', contentHash: 'sha256:caphash' }],
  },
};

describe('describeDispatch', () => {
  it('throws DispatchRecordExpiredError when the record is missing (ENOENT)', async () => {
    const storage: StorageProvider = {
      name: 'enoent',
      async put() {
        return { contentHash: 'x' };
      },
      async get() {
        const err: NodeJS.ErrnoException = new Error('not found');
        err.code = 'ENOENT';
        throw err;
      },
      async resolveLatest() {
        return null;
      },
      async list() {
        return [];
      },
    };
    const client = makeClient(storage);
    await expect(
      describeDispatch(client, 'd-missing'),
    ).rejects.toBeInstanceOf(DispatchRecordExpiredError);
  });

  it('throws DispatchRecordExpiredError when the record was never written', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage);
    await expect(
      describeDispatch(client, 'd-never-existed'),
    ).rejects.toBeInstanceOf(DispatchRecordExpiredError);
  });

  it('DispatchRecordExpiredError carries the dispatchId and a useful name', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage);
    try {
      await describeDispatch(client, 'd-gone');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchRecordExpiredError);
      expect((err as DispatchRecordExpiredError).dispatchId).toBe('d-gone');
      expect((err as Error).name).toBe('DispatchRecordExpiredError');
    }
  });

  it('round-trips a written record and returns the full DispatchResult shape', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage);
    await writeDispatchRecord(
      client,
      'd1',
      { ...baseResult, providerTaskId: 'p-1', target: 'prod' },
      7,
    );
    const read = await describeDispatch(client, 'd1');
    expect(read.dispatchId).toBe('d1');
    expect(read.exitCode).toBe(0);
    expect(read.stdout).toBe('captured stdout');
    expect(read.stderr).toBe('captured stderr');
    expect(read.durationMs).toBe(4242);
    expect(read.resolved.subagent.name).toBe('sub');
    expect(read.resolved.capabilities[0].name).toBe('cap');
  });

  it('preserves optional failure block on the returned record', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage);
    const withFailure: DispatchResult = {
      ...baseResult,
      failure: { reason: 'timeout', detail: 'exceeded 30s' },
    };
    await writeDispatchRecord(
      client,
      'd1',
      { ...withFailure, providerTaskId: 'p', target: 't' },
      1,
    );
    const read = await describeDispatch(client, 'd1');
    expect(read.failure).toEqual({ reason: 'timeout', detail: 'exceeded 30s' });
  });

  it('preserves optional needsInput block on the returned record', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage);
    const withInput: DispatchResult = {
      ...baseResult,
      needsInput: { question: 'proceed?', options: ['y', 'n'] },
    };
    await writeDispatchRecord(
      client,
      'd1',
      { ...withInput, providerTaskId: 'p', target: 't' },
      1,
    );
    const read = await describeDispatch(client, 'd1');
    expect(read.needsInput).toEqual({ question: 'proceed?', options: ['y', 'n'] });
  });

  it('re-throws unrelated storage errors instead of converting to DispatchRecordExpiredError', async () => {
    const storage: StorageProvider = {
      name: 'broken',
      async put() {
        return { contentHash: 'x' };
      },
      async get() {
        throw new Error('S3 bucket policy denies access');
      },
      async resolveLatest() {
        return null;
      },
      async list() {
        return [];
      },
    };
    const client = makeClient(storage);
    await expect(describeDispatch(client, 'd1')).rejects.toThrow(/bucket policy/);
    await expect(describeDispatch(client, 'd1')).rejects.not.toBeInstanceOf(
      DispatchRecordExpiredError,
    );
  });
});
