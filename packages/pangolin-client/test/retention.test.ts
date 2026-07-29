import { describe, it, expect } from 'vitest';
import { writeDispatchRecord, readDispatchRecord, type DispatchRecord } from '../src/retention.js';
import { PangolinClient } from '../src/client.js';
import {
  StorageNotFoundError,
  type DispatchResult,
  type StorageProvider,
} from '@quarry-systems/pangolin-core';

/**
 * Minimal in-memory storage stub satisfying the StorageProvider contract.
 * Records (uri, bytes) and throws a typed `StorageNotFoundError` on get for
 * missing keys, mirroring the real LocalStorageProvider behaviour.
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
      if (!v) throw new StorageNotFoundError(uri, `memory storage: blob missing: ${uri}`);
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
  stdout: 'out',
  stderr: 'err',
  durationMs: 1234,
  resolved: {
    subagent: { name: 'sub', contentHash: 'sha256:subhash' },
    capabilities: [{ name: 'cap', contentHash: 'sha256:caphash' }],
  },
};

describe('writeDispatchRecord', () => {
  it('rejects retentionDays > client.retention.maxDays', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage, 30);
    await expect(
      writeDispatchRecord(client, 'd1', { ...baseResult, providerTaskId: 'p', target: 't' }, 99),
    ).rejects.toThrow(/maxDays/);
  });

  it('writes the record under pangolin://<ns>/dispatches/<dispatchId>/record.json', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage, 30);
    await writeDispatchRecord(
      client,
      'd1',
      { ...baseResult, providerTaskId: 'p-1', target: 'prod' },
      7,
    );
    const expectedUri = 'pangolin://o/dispatches/d1/record.json';
    expect(storage.blobs.has(expectedUri)).toBe(true);
  });

  it('serializes the record including providerTaskId, target, retentionDays, recordedAt', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage, 30);
    const before = Date.now();
    await writeDispatchRecord(
      client,
      'd1',
      { ...baseResult, providerTaskId: 'p-1', target: 'prod' },
      14,
    );
    const after = Date.now();
    const bytes = storage.blobs.get('pangolin://o/dispatches/d1/record.json')!;
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as DispatchRecord;
    expect(parsed.dispatchId).toBe('d1');
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout).toBe('out');
    expect(parsed.stderr).toBe('err');
    expect(parsed.durationMs).toBe(1234);
    expect(parsed.providerTaskId).toBe('p-1');
    expect(parsed.target).toBe('prod');
    expect(parsed.retentionDays).toBe(14);
    const recordedAtMs = Date.parse(parsed.recordedAt);
    expect(recordedAtMs).toBeGreaterThanOrEqual(before);
    expect(recordedAtMs).toBeLessThanOrEqual(after);
  });

  it('defaults missing providerTaskId and target to empty string', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage, 30);
    await writeDispatchRecord(client, 'd1', baseResult, 1);
    const bytes = storage.blobs.get('pangolin://o/dispatches/d1/record.json')!;
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as DispatchRecord;
    expect(parsed.providerTaskId).toBe('');
    expect(parsed.target).toBe('');
  });

  it('preserves optional failure block when present', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage, 30);
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
    const bytes = storage.blobs.get('pangolin://o/dispatches/d1/record.json')!;
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as DispatchRecord;
    expect(parsed.failure).toEqual({ reason: 'timeout', detail: 'exceeded 30s' });
  });

  it('preserves optional needsInput block when present', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage, 30);
    const withInput: DispatchResult = {
      ...baseResult,
      needsInput: { question: 'proceed?', options: ['y', 'n'] },
    };
    await writeDispatchRecord(client, 'd1', { ...withInput, providerTaskId: 'p', target: 't' }, 1);
    const bytes = storage.blobs.get('pangolin://o/dispatches/d1/record.json')!;
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as DispatchRecord;
    expect(parsed.needsInput).toEqual({ question: 'proceed?', options: ['y', 'n'] });
  });
});

describe('readDispatchRecord', () => {
  it('round-trips a previously written record', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage, 30);
    await writeDispatchRecord(
      client,
      'd1',
      { ...baseResult, providerTaskId: 'p-1', target: 'prod' },
      7,
    );
    const read = await readDispatchRecord(client, 'd1');
    expect(read).not.toBeNull();
    expect(read!.dispatchId).toBe('d1');
    expect(read!.providerTaskId).toBe('p-1');
    expect(read!.target).toBe('prod');
    expect(read!.retentionDays).toBe(7);
  });

  it('returns null when the record was never written (typed StorageNotFoundError)', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage, 30);
    const read = await readDispatchRecord(client, 'never-existed');
    expect(read).toBeNull();
  });

  it('returns null when the storage backend throws StorageNotFoundError', async () => {
    const storage: StorageProvider = {
      name: 'enoent',
      async put() {
        return { contentHash: 'x' };
      },
      async get(uri: string) {
        throw new StorageNotFoundError(uri, 'backend object missing');
      },
      async resolveLatest() {
        return null;
      },
      async list() {
        return [];
      },
    };
    const client = makeClient(storage, 30);
    const read = await readDispatchRecord(client, 'expired');
    expect(read).toBeNull();
  });

  it('re-throws unrelated storage errors', async () => {
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
    const client = makeClient(storage, 30);
    await expect(readDispatchRecord(client, 'd1')).rejects.toThrow(/bucket policy/);
  });

  it('rethrows a generic /not found/i message instead of reporting the record missing', async () => {
    const storage: StorageProvider = {
      name: 'flaky-dns',
      async put() {
        return { contentHash: 'x' };
      },
      async get() {
        throw new Error('endpoint not found (DNS)');
      },
      async resolveLatest() {
        return null;
      },
      async list() {
        return [];
      },
    };
    const client = makeClient(storage, 30);
    await expect(readDispatchRecord(client, 'd1')).rejects.toThrow(/endpoint not found/);
  });

  it('round-trips a trace on the dispatch record', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage, 30);
    await writeDispatchRecord(
      client,
      'd-trace',
      {
        dispatchId: 'd-trace',
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 1,
        resolved: { subagent: { name: 's', contentHash: 'sha256:x' }, capabilities: [], env: [] },
        providerTaskId: 'p',
        target: 'local',
        trace: { traceId: 'run-9', runId: 'run-9', itemId: 'a' },
      },
      7,
    );
    const record = await readDispatchRecord(client, 'd-trace');
    expect(record?.trace).toEqual({ traceId: 'run-9', runId: 'run-9', itemId: 'a' });
  });
});
