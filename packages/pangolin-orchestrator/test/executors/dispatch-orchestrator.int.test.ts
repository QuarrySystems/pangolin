import { describe, it, expect } from 'vitest';
import { PangolinOrchestrator, SqliteRunStateStore, ManualTrigger } from '../../src/index.js';
import { PangolinClient } from '@quarry-systems/pangolin-client';
import { DispatchExecutor } from '../../src/executors/dispatch.js';
import type { Run } from '../../src/contracts/index.js';
import { buildDispatchRecordUri } from '@quarry-systems/pangolin-core';
import type {
  ComputeProvider,
  CredentialProvider,
  SecretStore,
  StorageProvider,
  TaskExit,
  TaskHandle,
} from '@quarry-systems/pangolin-core';

// ---------------------------------------------------------------------------
// In-memory storage stub
// ---------------------------------------------------------------------------
function makeMemoryStorage(): StorageProvider & {
  seed(name: string, type: string, namespace: string, contentHash: string, payload: unknown): void;
} {
  const blobs = new Map<string, Uint8Array>();
  const registry = new Map<
    string,
    Array<{ contentHash: string; registeredAt: string; pinnedUri: string }>
  >();
  let monotonic = 0;
  return {
    name: 'memory',
    seed(name: string, type: string, namespace: string, contentHash: string, payload: unknown) {
      const baseUri = `pangolin://${namespace}/${type}/${name}`;
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
// Deferred-exit compute
// ---------------------------------------------------------------------------
interface DeferredCompute {
  compute: ComputeProvider;
  resolveExit(exit: TaskExit): void;
}

function makeDeferredCompute(): DeferredCompute {
  let resolveExit!: (exit: TaskExit) => void;
  const exitPromise = new Promise<TaskExit>((res) => {
    resolveExit = res;
  });
  const compute: ComputeProvider = {
    name: 'deferred-compute',
    async run(_spec, _ctx): Promise<TaskHandle> {
      return { providerTaskId: 'prov-int' };
    },
    async awaitExit(_handle, _ctx): Promise<TaskExit> {
      return exitPromise;
    },
  };
  return { compute, resolveExit };
}

// ---------------------------------------------------------------------------
// Fake SecretStore — injected via client.secretStores to avoid any AWS calls
// ---------------------------------------------------------------------------
function makeFakeStore(): { store: SecretStore; staged: string[]; cleaned: string[] } {
  const staged: string[] = [];
  const cleaned: string[] = [];
  const store: SecretStore = {
    name: 'local-file',
    dir: '/tmp/pangolin-orch-secrets',
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
// Integration tests
// ---------------------------------------------------------------------------
describe('PangolinOrchestrator + DispatchExecutor', () => {
  it('drives a 1-item run to done across two ticks', async () => {
    const { compute, resolveExit } = makeDeferredCompute();
    const { store: secretStore } = makeFakeStore();
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const client = new PangolinClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default', secretStore: 'local' } },
      secretStores: { local: secretStore },
    });

    const store = new SqliteRunStateStore();
    const executor = new DispatchExecutor({ client, target: 'prod', workerImage: 'img' });
    const orch = new PangolinOrchestrator({
      store,
      executors: { dispatch: executor },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 5 } },
    });

    const run: Run = {
      id: 'r',
      queue: 'default',
      items: [
        {
          id: 'a',
          executor: 'dispatch',
          inputs: { subagent: 's', workerInput: {} },
          depends_on: [],
          resourceLocks: [],
        },
      ],
    };

    orch.submitRun(run);

    // Tick 1: item should fire (status → running)
    const t1 = await orch.tick();
    expect(t1.fired).toBe(1);
    expect(orch.getStatus('r').find((s) => s.id === 'a')!.status).toBe('running');

    // Resolve the fake exit (exit code 0 → done)
    resolveExit({
      exitCode: 0,
      stdout: 'finished',
      stderr: '',
      startedAt: new Date(0),
      finishedAt: new Date(1),
    });
    await new Promise((r) => setImmediate(r)); // let the background .then run in DispatchExecutor

    // Tick 2: reconcile should settle the item to done
    const t2 = await orch.tick();
    expect(t2.reconciled).toBe(1);

    const status = orch.getStatus('r');
    expect(status.find((s) => s.id === 'a')!.status).toBe('done');

    store.close();
  });

  it('drives a 1-item run to failed when exit code is non-zero', async () => {
    const { compute, resolveExit } = makeDeferredCompute();
    const { store: secretStore } = makeFakeStore();
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const client = new PangolinClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default', secretStore: 'local' } },
      secretStores: { local: secretStore },
    });

    const store = new SqliteRunStateStore();
    const executor = new DispatchExecutor({ client, target: 'prod', workerImage: 'img' });
    const orch = new PangolinOrchestrator({
      store,
      executors: { dispatch: executor },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 5 } },
      maxAttempts: 1,
    });

    const run: Run = {
      id: 'r2',
      queue: 'default',
      items: [
        {
          id: 'a',
          executor: 'dispatch',
          inputs: { subagent: 's', workerInput: {} },
          depends_on: [],
          resourceLocks: [],
        },
      ],
    };

    orch.submitRun(run);

    await orch.tick(); // fires

    resolveExit({
      exitCode: 1,
      stdout: '',
      stderr: 'error',
      startedAt: new Date(0),
      finishedAt: new Date(1),
    });
    await new Promise((r) => setImmediate(r));

    await orch.tick(); // reconciles

    expect(orch.getStatus('r2').find((s) => s.id === 'a')!.status).toBe('failed');

    store.close();
  });

  // ---------------------------------------------------------------------------
  // Helpers for escape + manifest tests
  // ---------------------------------------------------------------------------

  /** The known secret value used in the secret-leak assertion. */
  const KNOWN_SECRET_VALUE = 'super-secret-value-do-not-leak';

  /**
   * Seed the worker output sentinel so reconcile can pick up patchRef.
   * Also seeds the patchRef artifact so it is fetchable.
   */
  async function seedSentinel(
    storage: ReturnType<typeof makeMemoryStorage>,
    namespace: string,
    dispatchId: string,
    patchRef: string,
  ): Promise<void> {
    const sentinelUri = buildDispatchRecordUri(namespace, dispatchId, 'output.json');
    const sentinelBytes = new TextEncoder().encode(
      JSON.stringify({ schemaVersion: 1, patchRef }),
    );
    // Directly insert into the blob map via put — the memory stub stores by
    // exact URI and storage.get() returns it unchanged.
    await storage.put(sentinelUri, sentinelBytes);
    // Also put the artifact blob so patchRef is fetchable (content is opaque).
    await storage.put(patchRef, new TextEncoder().encode(JSON.stringify({ patch: 'some-diff' })));
  }

  it('surfaces result_ref + manifest_ref end to end and keeps secrets as refs', async () => {
    const { compute, resolveExit } = makeDeferredCompute();
    const { store: fakeSecretStore } = makeFakeStore();
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });

    // Wire a deploy-time inline secret — after staging it becomes a ref, not a value.
    const client = new PangolinClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default', secretStore: 'local' } },
      secretStores: { local: fakeSecretStore },
    });

    const runStateStore = new SqliteRunStateStore();
    const executor = new DispatchExecutor({
      client,
      target: 'prod',
      workerImage: 'img',
      secrets: {
        MY_SECRET: { inline: KNOWN_SECRET_VALUE },
      },
    });
    const orch = new PangolinOrchestrator({
      store: runStateStore,
      executors: { dispatch: executor },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 5 } },
      maxAttempts: 1,
    });

    const run: Run = {
      id: 'r3',
      queue: 'default',
      items: [
        {
          id: 'edit-1',
          executor: 'dispatch',
          inputs: { subagent: 's', workerInput: {} },
          depends_on: [],
          resourceLocks: [],
        },
      ],
    };

    orch.submitRun(run, 'human:brett', '2026-05-31T00:00:00.000Z');

    // Tick 1: fire — item goes running.
    const t1 = await orch.tick();
    expect(t1.fired).toBe(1);
    expect(orch.getStatus('r3').find((s) => s.id === 'edit-1')!.status).toBe('running');

    // Capture the dispatchHash minted by fireWork so we can seed the sentinel.
    // store.getItems() returns the raw ItemState including dispatchHash.
    const runItems = runStateStore.getItems('r3');
    const dispatchHash = runItems[0]!.dispatchHash;
    expect(typeof dispatchHash).toBe('string');

    // Seed the worker output sentinel at the correct dispatch record URI.
    const patchRef = `pangolin://ns/artifact/patch-1/sha256:abc123def456`;
    await seedSentinel(storage, 'ns', dispatchHash!, patchRef);

    // Resolve the fake exit (exit code 0 → done).
    resolveExit({
      exitCode: 0,
      stdout: 'done',
      stderr: '',
      startedAt: new Date(0),
      finishedAt: new Date(1),
    });
    await new Promise((r) => setImmediate(r)); // let the background awaitExit settle

    // Tick 2: reconcile — item should transition to done with refs.
    const t2 = await orch.tick();
    expect(t2.reconciled).toBe(1);

    const status = orch.getStatus('r3').find((s) => s.id === 'edit-1')!;
    expect(status.status).toBe('done');

    // resultRef should be the patchRef read from the sentinel.
    expect(status.resultRef).toMatch(/\/artifact\/.*\/sha256:/);

    // manifestRef should be a content-addressed manifest URI.
    expect(status.manifestRef).toMatch(/\/manifest\/.*\/sha256:/);

    // The manifest should be fetchable and carry actor + runId from the submission.
    const manifestBytes = await storage.get(status.manifestRef!);
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Record<string, unknown>;
    expect(manifest.actor).toBe('human:brett');
    expect(manifest.runId).toBe('r3');

    // No secret value should appear in the serialized manifest — only refs.
    expect(JSON.stringify(manifest)).not.toContain(KNOWN_SECRET_VALUE);
    // The secretRefs field should be an array of strings (refs, not values).
    expect(Array.isArray(manifest.secretRefs)).toBe(true);
    expect((manifest.secretRefs as string[]).every((r) => typeof r === 'string')).toBe(true);
    expect((manifest.secretRefs as string[]).length).toBeGreaterThan(0);

    runStateStore.close();
  });

  it('reconciles done with resultRef undefined when worker wrote no sentinel', async () => {
    const { compute, resolveExit } = makeDeferredCompute();
    const { store: secretStore } = makeFakeStore();
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });

    const client = new PangolinClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default', secretStore: 'local' } },
      secretStores: { local: secretStore },
    });

    const runStateStore = new SqliteRunStateStore();
    const executor = new DispatchExecutor({ client, target: 'prod', workerImage: 'img' });
    const orch = new PangolinOrchestrator({
      store: runStateStore,
      executors: { dispatch: executor },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 5 } },
      maxAttempts: 1,
    });

    const run: Run = {
      id: 'r4',
      queue: 'default',
      items: [
        {
          id: 'edit-2',
          executor: 'dispatch',
          inputs: { subagent: 's', workerInput: {} },
          depends_on: [],
          resourceLocks: [],
        },
      ],
    };

    orch.submitRun(run);

    // Fire
    await orch.tick();

    // No sentinel seeded — worker produced nothing.
    resolveExit({
      exitCode: 0,
      stdout: '',
      stderr: '',
      startedAt: new Date(0),
      finishedAt: new Date(1),
    });
    await new Promise((r) => setImmediate(r));

    // Reconcile — should not throw; item becomes done with no resultRef.
    await expect(orch.tick()).resolves.toMatchObject({ reconciled: 1 });

    const status = orch.getStatus('r4').find((s) => s.id === 'edit-2')!;
    expect(status.status).toBe('done');
    expect(status.resultRef).toBeUndefined();

    runStateStore.close();
  });
});
