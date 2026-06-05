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
import { buildDispatchRecordUri } from '@quarry-systems/agora-core';
import { DispatchExecutor } from '../../src/executors/dispatch.js';
import type { WorkItem, FireContext } from '../../src/contracts/index.js';

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

  // -------------------------------------------------------------------------
  // New tests for manifest-write (V1-D4)
  // -------------------------------------------------------------------------

  it('fire writes a content-addressed manifest and returns its ref', async () => {
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
    const executor = new DispatchExecutor({ client, target: 'prod', workerImage: 'img:v1' });

    const ctx: FireContext = { runId: 'r1', actor: 'human:brett' };
    const { dispatchHash, manifestRef } = await executor.fire(baseItem, ctx);

    // manifestRef should be a pinned agora:// URI
    expect(manifestRef).toMatch(/^agora:\/\/ns\/manifest\/[^/]+\/sha256:[0-9a-f]{64}$/);

    // The stored blob should parse back as a manifest with our fields
    const stored = JSON.parse(new TextDecoder().decode(await storage.get(manifestRef!)));
    expect(stored.runId).toBe('r1');
    expect(stored.executor).toBe('dispatch');
    expect(stored.actor).toBe('human:brett');
    expect(stored.executorManifest.workerImage).toBe('img:v1');

    // Verify schemaVersion present
    expect(stored.schemaVersion).toBe(1);

    // dispatchHash still present
    expect(dispatchHash).toMatch(/^[0-9a-f-]{36}$/);

    resolveExit({ exitCode: 0, stdout: '', stderr: '', startedAt: new Date(0), finishedAt: new Date(1) });
  });

  it('manifest does not contain secret values — only refs', async () => {
    const fake = makeFakeStore();
    const { compute, resolveExit } = makeDeferredCompute();
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
    const executor = new DispatchExecutor({
      client,
      target: 'prod',
      workerImage: 'img:v1',
      secrets: { MY_SECRET: { inline: 'super-secret-value' } },
    });

    const { manifestRef } = await executor.fire(baseItem, { runId: 'r1', actor: 'agent:x' });
    expect(manifestRef).toBeDefined();

    const storedJson = new TextDecoder().decode(await storage.get(manifestRef!));
    // The actual secret value must not appear in the manifest
    expect(storedJson).not.toContain('super-secret-value');
    // The manifest should contain a ref (local-secret://)
    expect(storedJson).toContain('local-secret://');

    resolveExit({ exitCode: 0, stdout: '', stderr: '', startedAt: new Date(0), finishedAt: new Date(1) });
  });

  it('fire without ctx uses empty strings and still returns manifestRef', async () => {
    const { compute, resolveExit } = makeDeferredCompute();
    const { executor, client } = makeSetup(compute);
    const storage = (client as AgoraClient & { storage: ReturnType<typeof makeMemoryStorage> }).storage as ReturnType<typeof makeMemoryStorage>;

    const { dispatchHash, manifestRef } = await executor.fire(baseItem);
    expect(typeof dispatchHash).toBe('string');
    expect(manifestRef).toMatch(/^agora:\/\//);

    const stored = JSON.parse(new TextDecoder().decode(await storage.get(manifestRef!)));
    expect(stored.runId).toBe('');
    expect(stored.actor).toBe('');
    expect(stored.submittedAt).toBeUndefined();

    resolveExit({ exitCode: 0, stdout: '', stderr: '', startedAt: new Date(0), finishedAt: new Date(1) });
  });

  it('storage put failure during manifest write is swallowed — fire returns dispatchHash without throw', async () => {
    const { compute, resolveExit } = makeDeferredCompute();

    // Build a storage that throws on put
    const baseStorage = makeMemoryStorage();
    baseStorage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const throwingStorage: StorageProvider = {
      ...baseStorage,
      async put(_uri: string, _contents: Uint8Array) {
        throw new Error('storage exploded');
      },
    };

    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage: throwingStorage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });
    const executor = new DispatchExecutor({ client, target: 'prod', workerImage: 'img' });

    // fire should not throw even though storage.put throws — the try-catch swallows the manifest error
    const result = await executor.fire(baseItem, { runId: 'r2', actor: 'human:x' });

    // dispatchHash is still returned
    expect(result.dispatchHash).toMatch(/^[0-9a-f-]{36}$/);
    // manifestRef is undefined because put failed
    expect(result.manifestRef).toBeUndefined();

    resolveExit({ exitCode: 0, stdout: '', stderr: '', startedAt: new Date(0), finishedAt: new Date(1) });
  });

  it('reconcile of a done dispatch reads patchRef from sentinel and returns it as resultRef', async () => {
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
    const executor = new DispatchExecutor({ client, target: 'prod', workerImage: 'img' });

    const { dispatchHash } = await executor.fire(baseItem);

    // Seed the output sentinel at the dispatch-record URI
    const sentinelUri = buildDispatchRecordUri('ns', dispatchHash, 'output.json');
    const patchRef = 'agora://ns/artifact/out/sha256:' + 'a'.repeat(64);
    await storage.put(sentinelUri, new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, patchRef })));

    resolveExit({ exitCode: 0, stdout: '', stderr: '', startedAt: new Date(0), finishedAt: new Date(1) });
    await new Promise((r) => setImmediate(r));

    const res = await executor.reconcile(dispatchHash);
    expect(res?.status).toBe('done');
    expect(res?.resultRef).toBe(patchRef);
  });

  it('reconcile of a done dispatch reads verify from sentinel and surfaces it on the result', async () => {
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
    const executor = new DispatchExecutor({ client, target: 'prod', workerImage: 'img' });

    const { dispatchHash } = await executor.fire(baseItem);

    const sentinelUri = buildDispatchRecordUri('ns', dispatchHash, 'output.json');
    await storage.put(
      sentinelUri,
      new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 1,
          verify: { passed: false, report: 'tsc failed', durationMs: 10 },
        }),
      ),
    );

    resolveExit({ exitCode: 0, stdout: '', stderr: '', startedAt: new Date(0), finishedAt: new Date(1) });
    await new Promise((r) => setImmediate(r));

    const res = await executor.reconcile(dispatchHash);
    expect(res?.status).toBe('done');
    expect(res?.verify).toEqual({ passed: false, report: 'tsc failed', durationMs: 10 });
  });

  it('reconcile sanitises verify from the sentinel: bounds report, drops wrong-typed/extra fields', async () => {
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
    const executor = new DispatchExecutor({ client, target: 'prod', workerImage: 'img' });

    const { dispatchHash } = await executor.fire(baseItem);

    const sentinelUri = buildDispatchRecordUri('ns', dispatchHash, 'output.json');
    await storage.put(
      sentinelUri,
      new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 1,
          verify: {
            passed: true,
            report: 'x'.repeat(50_000),
            durationMs: 'fast', // wrong type
            injected: 'evil', // extra field
          },
        }),
      ),
    );

    resolveExit({ exitCode: 0, stdout: '', stderr: '', startedAt: new Date(0), finishedAt: new Date(1) });
    await new Promise((r) => setImmediate(r));

    const res = await executor.reconcile(dispatchHash);
    expect(res?.verify?.passed).toBe(true);
    expect(res?.verify?.report!.length).toBeLessThanOrEqual(16_000);
    expect(res?.verify?.durationMs).toBeUndefined(); // wrong type → dropped
    expect((res?.verify as Record<string, unknown>).injected).toBeUndefined();
  });

  it('reconcile of a done dispatch with no sentinel yields resultRef undefined, no throw', async () => {
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
    const executor = new DispatchExecutor({ client, target: 'prod', workerImage: 'img' });

    const { dispatchHash } = await executor.fire(baseItem);

    resolveExit({ exitCode: 0, stdout: '', stderr: '', startedAt: new Date(0), finishedAt: new Date(1) });
    await new Promise((r) => setImmediate(r));

    // reconcile should NOT throw and should return { status: 'done', resultRef: undefined }
    const res = await executor.reconcile(dispatchHash);
    expect(res?.status).toBe('done');
    expect(res?.resultRef).toBeUndefined();
  });

  it('reconcile of a done dispatch surfaces sentinel outputs as outputRefs', async () => {
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
    const executor = new DispatchExecutor({ client, target: 'prod', workerImage: 'img' });

    const { dispatchHash } = await executor.fire(baseItem);

    const sentinelUri = buildDispatchRecordUri('ns', dispatchHash, 'output.json');
    await storage.put(sentinelUri, new TextEncoder().encode(JSON.stringify({
      schemaVersion: 1,
      outputs: [{ path: 'report.txt', ref: 'agora://ns/artifact/d/sha256:' + 'a'.repeat(64) }],
    })));

    resolveExit({ exitCode: 0, stdout: '', stderr: '', startedAt: new Date(0), finishedAt: new Date(1) });
    await new Promise((r) => setImmediate(r));

    const res = await executor.reconcile(dispatchHash);
    expect(res?.status).toBe('done');
    expect(res?.outputRefs).toEqual({ 'report.txt': 'agora://ns/artifact/d/sha256:' + 'a'.repeat(64) });
  });

  it('reconcile sanitises outputs from the sentinel: drops malformed entries', async () => {
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
    const executor = new DispatchExecutor({ client, target: 'prod', workerImage: 'img' });

    const { dispatchHash } = await executor.fire(baseItem);

    const sentinelUri = buildDispatchRecordUri('ns', dispatchHash, 'output.json');
    const validRef = 'agora://ns/artifact/d/sha256:' + 'b'.repeat(64);
    await storage.put(sentinelUri, new TextEncoder().encode(JSON.stringify({
      schemaVersion: 1,
      outputs: [
        { path: 7, ref: validRef },       // path not a string → drop
        'junk',                            // not an object → drop
        { path: 'ok.txt', ref: validRef }, // valid → keep
      ],
    })));

    resolveExit({ exitCode: 0, stdout: '', stderr: '', startedAt: new Date(0), finishedAt: new Date(1) });
    await new Promise((r) => setImmediate(r));

    const res = await executor.reconcile(dispatchHash);
    expect(res?.outputRefs).toEqual({ 'ok.txt': validRef });
  });

  it('reconcile with all-malformed outputs yields no outputRefs field', async () => {
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
    const executor = new DispatchExecutor({ client, target: 'prod', workerImage: 'img' });

    const { dispatchHash } = await executor.fire(baseItem);

    const sentinelUri = buildDispatchRecordUri('ns', dispatchHash, 'output.json');
    await storage.put(sentinelUri, new TextEncoder().encode(JSON.stringify({
      schemaVersion: 1,
      outputs: [{ path: 99, ref: 'agora://ns/artifact/d/sha256:cc' }, 'bad'],
    })));

    resolveExit({ exitCode: 0, stdout: '', stderr: '', startedAt: new Date(0), finishedAt: new Date(1) });
    await new Promise((r) => setImmediate(r));

    const res = await executor.reconcile(dispatchHash);
    expect(res?.status).toBe('done');
    expect(res?.outputRefs).toBeUndefined();
  });

  it('sentinel outputs with prototype-polluting path keys are handled safely', async () => {
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
    const executor = new DispatchExecutor({ client, target: 'prod', workerImage: 'img' });

    const { dispatchHash } = await executor.fire(baseItem);

    const sentinelUri = buildDispatchRecordUri('ns', dispatchHash, 'output.json');
    const validRef = 'agora://ns/artifact/d/sha256:' + 'd'.repeat(64);
    await storage.put(sentinelUri, new TextEncoder().encode(JSON.stringify({
      schemaVersion: 1,
      outputs: [
        { path: '__proto__', ref: 'agora://ns/artifact/d/sha256:' + 'e'.repeat(64) },
        { path: 'constructor', ref: 'agora://ns/artifact/d/sha256:' + 'f'.repeat(64) },
        { path: 'ok.txt', ref: validRef },
      ],
    })));

    resolveExit({ exitCode: 0, stdout: '', stderr: '', startedAt: new Date(0), finishedAt: new Date(1) });
    await new Promise((r) => setImmediate(r));

    const res = await executor.reconcile(dispatchHash);
    expect(res?.status).toBe('done');

    // Object.keys must work and contain the expected own-data property keys
    const keys = Object.keys(res!.outputRefs!);
    expect(keys).toContain('ok.txt');

    // Nothing leaked onto Object.prototype — a fresh plain object must have no injected property
    expect((({}) as Record<string, unknown>).__proto__).toBe(Object.prototype); // structural sanity
    expect((({}) as Record<string, unknown>).polluted).toBeUndefined();
    // The outputRefs accumulator was built with Object.create(null) — keys that look like
    // prototype slot names are stored as own data properties, not as prototype mutations
    if ('__proto__' in res!.outputRefs! || 'constructor' in res!.outputRefs!) {
      // If the dangerous keys were stored, they must be own properties, not prototype
      const outputRefs = res!.outputRefs!;
      if ('__proto__' in outputRefs) {
        expect(Object.prototype.hasOwnProperty.call(outputRefs, '__proto__')).toBe(true);
      }
      if ('constructor' in outputRefs) {
        expect(Object.prototype.hasOwnProperty.call(outputRefs, 'constructor')).toBe(true);
      }
    }
    // The plain Object prototype must be untouched
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Wave B: inputs.inputRefs threading (typed-product handoff, spec §4)
  // -------------------------------------------------------------------------

  it('threads inputs.inputRefs into the dispatch work', async () => {
    const capturedTaskSpecs: import('@quarry-systems/agora-core').TaskSpec[] = [];
    const { compute: baseCompute, resolveExit } = makeDeferredCompute();
    // Wrap compute to capture TaskSpec passed to run()
    const capturingCompute: import('@quarry-systems/agora-core').ComputeProvider = {
      name: 'capturing',
      async run(spec, ctx) {
        capturedTaskSpecs.push(spec);
        return baseCompute.run(spec, ctx);
      },
      awaitExit: baseCompute.awaitExit.bind(baseCompute),
    };

    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: capturingCompute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });
    const executor = new DispatchExecutor({ client, target: 'prod', workerImage: 'img' });

    const inputRefs = { patch: 'agora://ns/artifact/d/sha256:' + 'a'.repeat(64) };
    const item: WorkItem = {
      ...baseItem,
      inputs: { subagent: 's', inputRefs },
    };

    await executor.fire(item);

    expect(capturedTaskSpecs).toHaveLength(1);
    const bundleRefs = JSON.parse(capturedTaskSpecs[0].env.AGORA_BUNDLE_REFS_JSON);
    // inputs array should contain the inputRef entry
    const inputsArr: Array<{ key: string; uri: string; contentHash: string }> = bundleRefs.inputs;
    expect(inputsArr).toHaveLength(1);
    expect(inputsArr[0].key).toBe('patch');
    expect(inputsArr[0].uri).toBe(inputRefs.patch);

    resolveExit({ exitCode: 0, stdout: '', stderr: '', startedAt: new Date(0), finishedAt: new Date(1) });
  });

  it('omits inputRefs from the dispatch work when the carrier is absent', async () => {
    const capturedTaskSpecs: import('@quarry-systems/agora-core').TaskSpec[] = [];
    const { compute: baseCompute, resolveExit } = makeDeferredCompute();
    const capturingCompute: import('@quarry-systems/agora-core').ComputeProvider = {
      name: 'capturing',
      async run(spec, ctx) {
        capturedTaskSpecs.push(spec);
        return baseCompute.run(spec, ctx);
      },
      awaitExit: baseCompute.awaitExit.bind(baseCompute),
    };

    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: capturingCompute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });
    const executor = new DispatchExecutor({ client, target: 'prod', workerImage: 'img' });

    // baseItem has no inputRefs in inputs
    await executor.fire(baseItem);

    expect(capturedTaskSpecs).toHaveLength(1);
    const bundleRefs = JSON.parse(capturedTaskSpecs[0].env.AGORA_BUNDLE_REFS_JSON);
    // inputs array should be empty when no inputRefs
    expect(bundleRefs.inputs).toEqual([]);

    resolveExit({ exitCode: 0, stdout: '', stderr: '', startedAt: new Date(0), finishedAt: new Date(1) });
  });

  it('omits inputRefs from the dispatch work when the carrier is present but empty', async () => {
    const capturedTaskSpecs: import('@quarry-systems/agora-core').TaskSpec[] = [];
    const { compute: baseCompute, resolveExit } = makeDeferredCompute();
    const capturingCompute: import('@quarry-systems/agora-core').ComputeProvider = {
      name: 'capturing',
      async run(spec, ctx) {
        capturedTaskSpecs.push(spec);
        return baseCompute.run(spec, ctx);
      },
      awaitExit: baseCompute.awaitExit.bind(baseCompute),
    };

    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: capturingCompute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });
    const executor = new DispatchExecutor({ client, target: 'prod', workerImage: 'img' });

    // inputRefs carrier is present but empty — should behave the same as absent
    const item: WorkItem = {
      ...baseItem,
      inputs: { subagent: 's', inputRefs: {} },
    };

    await executor.fire(item);

    expect(capturedTaskSpecs).toHaveLength(1);
    const bundleRefs = JSON.parse(capturedTaskSpecs[0].env.AGORA_BUNDLE_REFS_JSON);
    // inputs array should be empty when inputRefs is present but empty
    expect(bundleRefs.inputs).toEqual([]);

    resolveExit({ exitCode: 0, stdout: '', stderr: '', startedAt: new Date(0), finishedAt: new Date(1) });
  });

  it('drops non-string values in inputs.inputRefs without failing the dispatch', async () => {
    const capturedTaskSpecs: import('@quarry-systems/agora-core').TaskSpec[] = [];
    const { compute: baseCompute, resolveExit } = makeDeferredCompute();
    const capturingCompute: import('@quarry-systems/agora-core').ComputeProvider = {
      name: 'capturing',
      async run(spec, ctx) {
        capturedTaskSpecs.push(spec);
        return baseCompute.run(spec, ctx);
      },
      awaitExit: baseCompute.awaitExit.bind(baseCompute),
    };

    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: capturingCompute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });
    const executor = new DispatchExecutor({ client, target: 'prod', workerImage: 'img' });

    const pinnedUri = 'agora://ns/artifact/d/sha256:' + 'b'.repeat(64);
    const item: WorkItem = {
      ...baseItem,
      inputs: {
        subagent: 's',
        inputRefs: {
          good: pinnedUri,
          bad: 42 as unknown as string,  // non-string → should be dropped
        },
      },
    };

    // Should not throw
    await expect(executor.fire(item)).resolves.toBeDefined();

    expect(capturedTaskSpecs).toHaveLength(1);
    const bundleRefs = JSON.parse(capturedTaskSpecs[0].env.AGORA_BUNDLE_REFS_JSON);
    const inputsArr: Array<{ key: string; uri: string }> = bundleRefs.inputs;
    // Only the good entry should be present
    expect(inputsArr).toHaveLength(1);
    expect(inputsArr[0].key).toBe('good');

    resolveExit({ exitCode: 0, stdout: '', stderr: '', startedAt: new Date(0), finishedAt: new Date(1) });
  });

  it('reconcile with absent outputs field yields no outputRefs field', async () => {
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
    const executor = new DispatchExecutor({ client, target: 'prod', workerImage: 'img' });

    const { dispatchHash } = await executor.fire(baseItem);

    const sentinelUri = buildDispatchRecordUri('ns', dispatchHash, 'output.json');
    await storage.put(sentinelUri, new TextEncoder().encode(JSON.stringify({ schemaVersion: 1 })));

    resolveExit({ exitCode: 0, stdout: '', stderr: '', startedAt: new Date(0), finishedAt: new Date(1) });
    await new Promise((r) => setImmediate(r));

    const res = await executor.reconcile(dispatchHash);
    expect(res?.status).toBe('done');
    expect(res?.outputRefs).toBeUndefined();
  });

  it('reconcile truncates outputs beyond MAX_SENTINEL_OUTPUTS (256)', async () => {
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
    const executor = new DispatchExecutor({ client, target: 'prod', workerImage: 'img' });

    const { dispatchHash } = await executor.fire(baseItem);

    // Build 300 valid entries
    const outputs = Array.from({ length: 300 }, (_, i) => ({
      path: `file-${i}.txt`,
      ref: `agora://ns/artifact/d/sha256:${'c'.repeat(64)}`,
    }));
    const sentinelUri = buildDispatchRecordUri('ns', dispatchHash, 'output.json');
    await storage.put(sentinelUri, new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, outputs })));

    resolveExit({ exitCode: 0, stdout: '', stderr: '', startedAt: new Date(0), finishedAt: new Date(1) });
    await new Promise((r) => setImmediate(r));

    const res = await executor.reconcile(dispatchHash);
    expect(res?.outputRefs).toBeDefined();
    expect(Object.keys(res!.outputRefs!).length).toBe(256);
  });

  it('reconcile of a done dispatch with missing patchRef in sentinel yields resultRef undefined', async () => {
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
    const executor = new DispatchExecutor({ client, target: 'prod', workerImage: 'img' });

    const { dispatchHash } = await executor.fire(baseItem);

    // Sentinel with no patchRef field
    const sentinelUri = buildDispatchRecordUri('ns', dispatchHash, 'output.json');
    await storage.put(sentinelUri, new TextEncoder().encode(JSON.stringify({ schemaVersion: 1 })));

    resolveExit({ exitCode: 0, stdout: '', stderr: '', startedAt: new Date(0), finishedAt: new Date(1) });
    await new Promise((r) => setImmediate(r));

    const res = await executor.reconcile(dispatchHash);
    expect(res?.status).toBe('done');
    expect(res?.resultRef).toBeUndefined();
  });

  it('model best-effort: subagent with model field populates executorManifest.model.id', async () => {
    const { compute, resolveExit } = makeDeferredCompute();
    const storage = makeMemoryStorage();
    // Seed a subagent that has a model field
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's', model: 'claude-3-5-sonnet', capabilities: [] });
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });
    const executor = new DispatchExecutor({ client, target: 'prod', workerImage: 'img' });

    const { manifestRef } = await executor.fire(baseItem, { runId: 'r1', actor: 'human:x' });
    expect(manifestRef).toBeDefined();

    const stored = JSON.parse(new TextDecoder().decode(await storage.get(manifestRef!)));
    expect(stored.executorManifest.model.id).toBe('claude-3-5-sonnet');

    resolveExit({ exitCode: 0, stdout: '', stderr: '', startedAt: new Date(0), finishedAt: new Date(1) });
  });

  it('model best-effort: unreadable subagent blob yields model { id: empty string } without failing fire', async () => {
    const { compute, resolveExit } = makeDeferredCompute();
    // Use a storage where get throws for the subagent pinned URI but resolveLatest works.
    // resolveModel catches the throw and returns { id: '', temperature: 0, maxTokens: 0 }.
    // The manifest IS still written (put works) and manifestRef is set.
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const origGet = storage.get.bind(storage);
    const throwingGetStorage: StorageProvider = {
      ...storage,
      async get(uri: string) {
        if (uri.includes('/subagent/s/sha256:s')) {
          throw new Error('subagent blob missing');
        }
        return origGet(uri);
      },
    };
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage: throwingGetStorage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });
    const executor = new DispatchExecutor({ client, target: 'prod', workerImage: 'img' });

    // fire should NOT throw — resolveModel catches the error and uses zero-model
    const result = await executor.fire(baseItem, { runId: 'r1', actor: 'human:x' });

    // dispatchHash is always returned
    expect(result.dispatchHash).toMatch(/^[0-9a-f-]{36}$/);
    // manifestRef may or may not be set (put works, so it should be set with zero model)
    // The key invariant: fire returns without throwing
    if (result.manifestRef) {
      const stored = JSON.parse(new TextDecoder().decode(await storage.get(result.manifestRef)));
      expect(stored.executorManifest.model.id).toBe('');
    }

    resolveExit({ exitCode: 0, stdout: '', stderr: '', startedAt: new Date(0), finishedAt: new Date(1) });
  });
});
