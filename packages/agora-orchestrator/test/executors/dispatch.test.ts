import { describe, it, expect } from 'vitest';
import { AgoraClient } from '@quarry-systems/agora-client'; // barrel import installs prototype getters
import type {
  ComputeProvider,
  CredentialProvider,
  SecretStore,
  StorageProvider,
  TaskExit,
  TaskHandle,
} from '@quarry-systems/agora-core';
import { DispatchExecutor } from '../../src/executors/dispatch.js';
import type { WorkItem } from '../../src/contracts/index.js';

// ---------------------------------------------------------------------------
// In-memory storage stub (copied from agora-client/test/dispatch.test.ts)
// ---------------------------------------------------------------------------
function makeMemoryStorage(): StorageProvider & {
  blobs: Map<string, Uint8Array>;
  seed(name: string, type: string, namespace: string, contentHash: string, payload: unknown): void;
} {
  const blobs = new Map<string, Uint8Array>();
  const registry = new Map<
    string,
    Array<{ contentHash: string; registeredAt: string; pinnedUri: string }>
  >();
  let monotonic = 0;
  const storage: StorageProvider & {
    blobs: Map<string, Uint8Array>;
    seed(name: string, type: string, namespace: string, contentHash: string, payload: unknown): void;
  } = {
    name: 'memory',
    blobs,
    seed(name: string, type: string, namespace: string, contentHash: string, payload: unknown) {
      const baseUri = `agora://${namespace}/${type}/${name}`;
      const pinnedUri = `${baseUri}/${contentHash}`;
      blobs.set(pinnedUri, new TextEncoder().encode(JSON.stringify(payload)));
      monotonic += 1;
      const list = registry.get(baseUri) ?? [];
      list.push({
        contentHash,
        registeredAt: new Date(1_700_000_000_000 + monotonic).toISOString(),
        pinnedUri,
      });
      registry.set(baseUri, list);
    },
    async put(uri: string, contents: Uint8Array) {
      const parts = uri.split('/');
      const contentHash = parts[parts.length - 1];
      const baseUri = parts.slice(0, -1).join('/');
      blobs.set(uri, contents);
      monotonic += 1;
      const list = registry.get(baseUri) ?? [];
      list.push({
        contentHash,
        registeredAt: new Date(1_700_000_000_000 + monotonic).toISOString(),
        pinnedUri: uri,
      });
      registry.set(baseUri, list);
      return { contentHash };
    },
    async get(uri: string) {
      const v = blobs.get(uri);
      if (!v) throw new Error(`memory storage: not found: ${uri}`);
      return v;
    },
    async resolveLatest(uri: string) {
      const list = registry.get(uri);
      if (!list || list.length === 0) return null;
      const last = list[list.length - 1];
      return { uri: last.pinnedUri, contentHash: last.contentHash, registeredAt: last.registeredAt };
    },
    async list(uri: string) {
      return (registry.get(uri) ?? []).map((e) => ({
        uri: e.pinnedUri,
        contentHash: e.contentHash,
        registeredAt: e.registeredAt,
      }));
    },
    async resolveByHash(_query) {
      return null;
    },
  };
  return storage;
}

function makeCredentials(): CredentialProvider {
  return {
    name: 'fake-creds',
    async resolve() {
      return { kind: 'static', token: 'fake-token' };
    },
  };
}

// ---------------------------------------------------------------------------
// Deferred-exit compute builder — lets tests control when awaitExit resolves
// ---------------------------------------------------------------------------
interface DeferredCompute {
  compute: ComputeProvider;
  resolveExit(exit: TaskExit): void;
  rejectExit(err: unknown): void;
}

function makeDeferredCompute(): DeferredCompute {
  let resolveExit!: (exit: TaskExit) => void;
  let rejectExit!: (err: unknown) => void;
  const exitPromise = new Promise<TaskExit>((res, rej) => {
    resolveExit = res;
    rejectExit = rej;
  });

  const compute: ComputeProvider = {
    name: 'deferred-compute',
    async run(_spec, _ctx): Promise<TaskHandle> {
      return { providerTaskId: 'prov-deferred' };
    },
    async awaitExit(_handle, _ctx): Promise<TaskExit> {
      return exitPromise;
    },
  };
  return { compute, resolveExit, rejectExit };
}

// ---------------------------------------------------------------------------
// Fake SecretStore — replaces InlineSecretStager prototype spies
// ---------------------------------------------------------------------------
function makeFakeStore(): { store: SecretStore; staged: string[]; cleaned: string[] } {
  const staged: string[] = [];
  const cleaned: string[] = [];
  const store: SecretStore = {
    name: 'local-file',
    dir: '/tmp/agora-orch-secrets',
    stage: async (a: { name: string; value: string }) => {
      staged.push(a.name);
      return { ref: `local-secret://${a.name}`, ttlSeconds: 1 };
    },
    resolve: async () => 'v',
    cleanupByTag: async (_k: string, v: string) => {
      cleaned.push(v);
    },
  };
  return { store, staged, cleaned };
}

// ---------------------------------------------------------------------------
// Helper: build a wired AgoraClient + DispatchExecutor for a given compute
// (without a secretStore — suitable for tests that don't exercise cleanup)
// ---------------------------------------------------------------------------
function makeSetup(compute: ComputeProvider): {
  client: AgoraClient;
  executor: DispatchExecutor;
} {
  const storage = makeMemoryStorage();
  storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
  const client = new AgoraClient({
    namespace: 'ns',
    compute: { default: compute },
    credentials: { default: makeCredentials() },
    storage,
    targets: { prod: { compute: 'default', credentials: 'default' } },
  });
  const executor = new DispatchExecutor({ client, target: 'prod', workerImage: 'img' });
  return { client, executor };
}

// ---------------------------------------------------------------------------
// Helper: build a wired AgoraClient + DispatchExecutor with an injected fake
// SecretStore — for tests that assert staging and cleanup behaviour.
// ---------------------------------------------------------------------------
function makeSetupWithStore(
  compute: ComputeProvider,
  fake: { store: SecretStore; staged: string[]; cleaned: string[] },
): {
  client: AgoraClient;
  executor: DispatchExecutor;
} {
  const storage = makeMemoryStorage();
  storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
  const client = new AgoraClient({
    namespace: 'ns',
    compute: { default: compute },
    credentials: { default: makeCredentials() },
    storage,
    targets: { prod: { compute: 'default', credentials: 'default', secretStore: 'local' } },
    secretStores: { local: fake.store },
  });
  const executor = new DispatchExecutor({ client, target: 'prod', workerImage: 'img' });
  return { client, executor };
}

const baseItem: WorkItem = {
  id: 'a',
  executor: 'dispatch',
  inputs: { subagent: 's', workerInput: { x: 1 } },
  depends_on: [],
  resourceLocks: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DispatchExecutor', () => {
  it('fire returns a hash without awaiting exit; reconcile is null until exit, then done', async () => {
    const { compute, resolveExit } = makeDeferredCompute();
    const { executor } = makeSetup(compute);

    const { dispatchHash } = await executor.fire(baseItem);
    expect(dispatchHash).toMatch(/^[0-9a-f-]{36}$/);

    // awaitExit still pending — reconcile returns null
    expect(await executor.reconcile(dispatchHash)).toBeNull();

    // Resolve the exit
    resolveExit({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      startedAt: new Date(0),
      finishedAt: new Date(1),
    });
    await new Promise((r) => setImmediate(r)); // let the background .then run

    const result = await executor.reconcile(dispatchHash);
    expect(result?.status).toBe('done');
  });

  it('non-zero exit (exitCode 7) → reconcile → { status: failed }', async () => {
    const { compute, resolveExit } = makeDeferredCompute();
    const { executor } = makeSetup(compute);

    const { dispatchHash } = await executor.fire(baseItem);
    resolveExit({
      exitCode: 7,
      stdout: '',
      stderr: 'boom',
      startedAt: new Date(0),
      finishedAt: new Date(1),
    });
    await new Promise((r) => setImmediate(r));

    const result = await executor.reconcile(dispatchHash);
    expect(result?.status).toBe('failed');
  });

  it('awaitExit REJECTS → reconcile → { status: failed } and does NOT throw', async () => {
    const { compute, rejectExit } = makeDeferredCompute();
    const { executor } = makeSetup(compute);

    const { dispatchHash } = await executor.fire(baseItem);
    rejectExit(new Error('provider exploded'));
    await new Promise((r) => setImmediate(r));

    let result: Awaited<ReturnType<DispatchExecutor['reconcile']>>;
    await expect(async () => {
      result = await executor.reconcile(dispatchHash);
    }).not.toThrow();
    expect(result!?.status).toBe('failed');
  });

  it('terminal reconcile invokes inflight.cleanup (via the injected store\'s cleanupByTag)', async () => {
    const fake = makeFakeStore();
    const { compute, resolveExit } = makeDeferredCompute();
    const { executor } = makeSetupWithStore(compute, fake);

    const { dispatchHash } = await executor.fire({
      ...baseItem,
      inputs: { subagent: 's', workerInput: {}, secrets: {} },
    });

    resolveExit({
      exitCode: 0,
      stdout: '',
      stderr: '',
      startedAt: new Date(0),
      finishedAt: new Date(1),
    });
    await new Promise((r) => setImmediate(r));

    await executor.reconcile(dispatchHash);

    // cleanup should have been called (cleanupByTag invoked with the dispatchId)
    expect(fake.cleaned).toContain(dispatchHash);
  });

  it('terminal reconcile invokes cleanup — directly verified via inline-secret dispatch', async () => {
    const fake = makeFakeStore();
    const { compute, resolveExit } = makeDeferredCompute();
    const { executor } = makeSetupWithStore(compute, fake);

    const { dispatchHash } = await executor.fire(baseItem);

    resolveExit({
      exitCode: 0,
      stdout: '',
      stderr: '',
      startedAt: new Date(0),
      finishedAt: new Date(1),
    });
    await new Promise((r) => setImmediate(r));

    await executor.reconcile(dispatchHash);
    // The injected store's cleanupByTag should have been called with the dispatchId.
    expect(fake.cleaned).toContain(dispatchHash);
  });

  it('after terminal reconcile, second reconcile call returns null (entry removed)', async () => {
    const { compute, resolveExit } = makeDeferredCompute();
    const { executor } = makeSetup(compute);

    const { dispatchHash } = await executor.fire(baseItem);
    resolveExit({
      exitCode: 0,
      stdout: '',
      stderr: '',
      startedAt: new Date(0),
      finishedAt: new Date(1),
    });
    await new Promise((r) => setImmediate(r));

    await executor.reconcile(dispatchHash); // first terminal call
    expect(await executor.reconcile(dispatchHash)).toBeNull(); // entry removed → null
  });

  it('fire on an item with missing inputs.subagent throws', async () => {
    const { compute } = makeDeferredCompute();
    const { executor } = makeSetup(compute);

    const badItem: WorkItem = { ...baseItem, inputs: {} };
    await expect(executor.fire(badItem)).rejects.toThrow(/missing.*subagent/i);
  });

  it('fire on an item with non-string inputs.subagent throws', async () => {
    const { compute } = makeDeferredCompute();
    const { executor } = makeSetup(compute);

    const badItem: WorkItem = { ...baseItem, inputs: { subagent: 42 } };
    await expect(executor.fire(badItem)).rejects.toThrow(/missing.*subagent/i);
  });

  it('reconcile on an unknown hash returns null', async () => {
    const { compute } = makeDeferredCompute();
    const { executor } = makeSetup(compute);

    expect(await executor.reconcile('unknown-hash-abc')).toBeNull();
  });

  it('target and workerImage come only from executor config, not from WorkItem inputs', async () => {
    // This test verifies that even if inputs has target/workerImage, executor config wins.
    // We build a storage without a 'staging' target to confirm target is read from config.
    const { compute, resolveExit } = makeDeferredCompute();
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });
    // Executor uses 'prod' target and 'img' workerImage from config
    const executor = new DispatchExecutor({ client, target: 'prod', workerImage: 'img' });

    // Item has spurious target/workerImage in inputs — those should be ignored
    const itemWithSpuriousInputs: WorkItem = {
      ...baseItem,
      inputs: { subagent: 's', target: 'staging', workerImage: 'wrong-img' },
    };
    const { dispatchHash } = await executor.fire(itemWithSpuriousInputs);
    expect(dispatchHash).toMatch(/^[0-9a-f-]{36}$/); // fire succeeded using config target 'prod'

    resolveExit({ exitCode: 0, stdout: '', stderr: '', startedAt: new Date(0), finishedAt: new Date(1) });
    await new Promise((r) => setImmediate(r));
    expect((await executor.reconcile(dispatchHash))?.status).toBe('done');
  });
});
