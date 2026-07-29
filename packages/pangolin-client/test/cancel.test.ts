import { describe, it, expect } from 'vitest';
import { cancelDispatch } from '../src/cancel.js';
import { PangolinClient } from '../src/client.js';
import { writeDispatchRecord } from '../src/retention.js';
import {
  StorageNotFoundError,
  type ComputeProvider,
  type CredentialProvider,
  type LifecycleEvent,
  type StorageProvider,
  type ProviderContext,
  type TaskHandle,
} from '@quarry-systems/pangolin-core';

/**
 * Minimal in-memory storage stub satisfying the StorageProvider contract.
 * Records (uri, bytes) and throws a typed `StorageNotFoundError` on get for
 * missing keys, mirroring LocalStorageProvider behaviour.
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

function makeNotFoundStorage(): StorageProvider {
  return {
    name: 'not-found',
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
}

function makeCredentialProvider(kind = 'static-bearer'): CredentialProvider {
  return {
    name: 'creds',
    async resolve() {
      return { kind, token: 'tok' };
    },
  };
}

interface RecordingProvider extends ComputeProvider {
  cancelCalls: Array<{ handle: TaskHandle; ctx: ProviderContext }>;
}

function makeRecordingProvider(opts?: {
  cancel?: ((handle: TaskHandle, ctx: ProviderContext) => Promise<void>) | null;
}): RecordingProvider {
  const cancelCalls: RecordingProvider['cancelCalls'] = [];
  const provider: RecordingProvider = {
    name: 'recording',
    cancelCalls,
    async run() {
      return { providerTaskId: 'pt-1' };
    },
    async awaitExit() {
      return {
        exitCode: 0,
        startedAt: new Date(),
        finishedAt: new Date(),
        stdout: '',
        stderr: '',
      };
    },
  };
  if (opts?.cancel === null) {
    // omit cancel entirely
  } else {
    const inner = opts?.cancel;
    provider.cancel = async (handle, ctx) => {
      cancelCalls.push({ handle, ctx });
      if (inner) await inner(handle, ctx);
    };
  }
  return provider;
}

describe('cancelDispatch', () => {
  it('is a no-op when the storage backend throws StorageNotFoundError', async () => {
    const storage = makeNotFoundStorage();
    const client = new PangolinClient({
      namespace: 'o',
      compute: {},
      credentials: {},
      storage,
      targets: {},
    });
    await expect(cancelDispatch(client, 'missing')).resolves.toBeUndefined();
  });

  it('is a no-op when the dispatch record was never written (typed StorageNotFoundError)', async () => {
    const storage = makeMemoryStorage();
    const client = new PangolinClient({
      namespace: 'o',
      compute: {},
      credentials: {},
      storage,
      targets: {},
    });
    await expect(cancelDispatch(client, 'never-existed')).resolves.toBeUndefined();
  });

  it('calls provider.cancel with the providerTaskId from the persisted record', async () => {
    const storage = makeMemoryStorage();
    const compute = makeRecordingProvider();
    const credentials = makeCredentialProvider();
    const client = new PangolinClient({
      namespace: 'o',
      compute: { recording: compute },
      credentials: { creds: credentials },
      storage,
      targets: { prod: { compute: 'recording', credentials: 'creds' } },
    });
    await writeDispatchRecord(
      client,
      'd1',
      {
        dispatchId: 'd1',
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 0,
        resolved: {
          subagent: { name: 's', contentHash: 'sha256:s' },
          capabilities: [],
        },
        providerTaskId: 'pt-42',
        target: 'prod',
      },
      7,
    );

    await cancelDispatch(client, 'd1');

    expect(compute.cancelCalls).toHaveLength(1);
    expect(compute.cancelCalls[0].handle.providerTaskId).toBe('pt-42');
  });

  it('passes resolved credentials and client telemetry in the provider context', async () => {
    const storage = makeMemoryStorage();
    const compute = makeRecordingProvider();
    const credentials = makeCredentialProvider('aws-sts');
    const telemetry = { emit: () => {} };
    const client = new PangolinClient({
      namespace: 'o',
      compute: { recording: compute },
      credentials: { creds: credentials },
      storage,
      targets: { prod: { compute: 'recording', credentials: 'creds' } },
      telemetry,
    });
    await writeDispatchRecord(
      client,
      'd1',
      {
        dispatchId: 'd1',
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 0,
        resolved: {
          subagent: { name: 's', contentHash: 'sha256:s' },
          capabilities: [],
        },
        providerTaskId: 'pt-1',
        target: 'prod',
      },
      7,
    );

    await cancelDispatch(client, 'd1');

    expect(compute.cancelCalls[0].ctx.credentials.kind).toBe('aws-sts');
    expect(compute.cancelCalls[0].ctx.telemetry).toBe(telemetry);
  });

  it('is a no-op when the persisted target has since been removed from the client', async () => {
    // Write a record naming a target, then build a client whose targets map
    // no longer contains it (simulating a config rotation between dispatch
    // and cancel). Should silently no-op rather than throw.
    const storage = makeMemoryStorage();
    const compute = makeRecordingProvider();
    const credentials = makeCredentialProvider();
    const seedingClient = new PangolinClient({
      namespace: 'o',
      compute: { recording: compute },
      credentials: { creds: credentials },
      storage,
      targets: { prod: { compute: 'recording', credentials: 'creds' } },
    });
    await writeDispatchRecord(
      seedingClient,
      'd1',
      {
        dispatchId: 'd1',
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 0,
        resolved: {
          subagent: { name: 's', contentHash: 'sha256:s' },
          capabilities: [],
        },
        providerTaskId: 'pt-1',
        target: 'prod',
      },
      7,
    );

    const reconfiguredClient = new PangolinClient({
      namespace: 'o',
      compute: { recording: compute },
      credentials: { creds: credentials },
      storage,
      targets: {}, // 'prod' is gone
    });
    await expect(cancelDispatch(reconfiguredClient, 'd1')).resolves.toBeUndefined();
    expect(compute.cancelCalls).toHaveLength(0);
  });

  it('is a no-op when the resolved provider does not support cancel', async () => {
    const storage = makeMemoryStorage();
    const compute = makeRecordingProvider({ cancel: null });
    expect(compute.cancel).toBeUndefined();
    const credentials = makeCredentialProvider();
    const client = new PangolinClient({
      namespace: 'o',
      compute: { recording: compute },
      credentials: { creds: credentials },
      storage,
      targets: { prod: { compute: 'recording', credentials: 'creds' } },
    });
    await writeDispatchRecord(
      client,
      'd1',
      {
        dispatchId: 'd1',
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 0,
        resolved: {
          subagent: { name: 's', contentHash: 'sha256:s' },
          capabilities: [],
        },
        providerTaskId: 'pt-1',
        target: 'prod',
      },
      7,
    );

    await expect(cancelDispatch(client, 'd1')).resolves.toBeUndefined();
  });

  it('swallows errors thrown by provider.cancel (idempotent re-cancel)', async () => {
    const storage = makeMemoryStorage();
    const compute = makeRecordingProvider({
      cancel: async () => {
        throw new Error('already stopped');
      },
    });
    const credentials = makeCredentialProvider();
    const client = new PangolinClient({
      namespace: 'o',
      compute: { recording: compute },
      credentials: { creds: credentials },
      storage,
      targets: { prod: { compute: 'recording', credentials: 'creds' } },
    });
    await writeDispatchRecord(
      client,
      'd1',
      {
        dispatchId: 'd1',
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 0,
        resolved: {
          subagent: { name: 's', contentHash: 'sha256:s' },
          capabilities: [],
        },
        providerTaskId: 'pt-1',
        target: 'prod',
      },
      7,
    );

    await expect(cancelDispatch(client, 'd1')).resolves.toBeUndefined();
    expect(compute.cancelCalls).toHaveLength(1);
  });

  it('cancelDispatch emits dispatch.cancelled (intent) even when there is no provider to reap', async () => {
    const storage = makeMemoryStorage();
    const events: LifecycleEvent[] = [];
    const client = new PangolinClient({
      namespace: 'ns',
      compute: {},
      credentials: {},
      storage,
      targets: {},
      telemetry: { name: 'rec', emit: (e) => events.push(e) },
    });
    await cancelDispatch(client, 'd-123'); // unknown id → no-op reap, but intent is observable
    expect(events).toEqual([
      {
        kind: 'dispatch.cancelled',
        dispatchId: 'd-123',
        at: expect.any(String),
        trace: { traceId: 'd-123' },
      },
    ]);
  });
});
