import { describe, it, expect } from 'vitest';
import { AgoraOrchestrator, SqliteRunStateStore, ManualTrigger } from '../../src/index.js';
import { AgoraClient } from '@quarry-systems/agora-client';
import { DispatchExecutor } from '../../src/executors/dispatch.js';
import type { Run } from '../../src/contracts/index.js';
import type {
  ComputeProvider,
  CredentialProvider,
  SecretStore,
  StorageProvider,
  TaskExit,
  TaskHandle,
} from '@quarry-systems/agora-core';

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
// Integration tests
// ---------------------------------------------------------------------------
describe('AgoraOrchestrator + DispatchExecutor', () => {
  it('drives a 1-item run to done across two ticks', async () => {
    const { compute, resolveExit } = makeDeferredCompute();
    const { store: secretStore } = makeFakeStore();
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default', secretStore: 'local' } },
      secretStores: { local: secretStore },
    });

    const store = new SqliteRunStateStore();
    const executor = new DispatchExecutor({ client, target: 'prod', workerImage: 'img' });
    const orch = new AgoraOrchestrator({
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
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default', secretStore: 'local' } },
      secretStores: { local: secretStore },
    });

    const store = new SqliteRunStateStore();
    const executor = new DispatchExecutor({ client, target: 'prod', workerImage: 'img' });
    const orch = new AgoraOrchestrator({
      store,
      executors: { dispatch: executor },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 5 } },
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
});
