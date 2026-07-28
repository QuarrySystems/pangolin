import { describe, it, expect, vi } from 'vitest';
import { PangolinClient } from '@quarry-systems/pangolin-client';
import type {
  ComputeProvider,
  CredentialProvider,
  StorageProvider,
  TaskExit,
  TaskHandle,
} from '@quarry-systems/pangolin-core';
import { buildDispatchRecordUri } from '@quarry-systems/pangolin-core';
import * as pangolinProduct from '@quarry-systems/pangolin-product';
import { DispatchExecutor } from '../src/executors/dispatch.js';
import type { WorkItem } from '../src/contracts/index.js';

// Spy on the published reader while preserving its real behavior — proves
// dispatch.ts actually DELEGATES to it (the naming-trap requirement: the
// dispatchId passed through is the exact value reconcile() receives, no
// hash-to-id translation), rather than merely producing equivalent output
// from a still-private local copy.
vi.mock('@quarry-systems/pangolin-product', async () => {
  const actual = await vi.importActual<typeof import('@quarry-systems/pangolin-product')>(
    '@quarry-systems/pangolin-product',
  );
  return { ...actual, readOutputSentinel: vi.fn(actual.readOutputSentinel) };
});

// ---------------------------------------------------------------------------
// Minimal in-memory storage stub (same shape/behavior as the one in
// test/executors/dispatch.test.ts — `get` on a missing key throws a "not
// found" message, matching pangolin-product's isNotFound sniff).
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
    seed(
      name: string,
      type: string,
      namespace: string,
      contentHash: string,
      payload: unknown,
    ): void;
  } = {
    name: 'memory',
    blobs,
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
      return {
        uri: last.pinnedUri,
        contentHash: last.contentHash,
        registeredAt: last.registeredAt,
      };
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
      return { providerTaskId: 'prov-deferred' };
    },
    async awaitExit(_handle, _ctx): Promise<TaskExit> {
      return exitPromise;
    },
  };
  return { compute, resolveExit };
}

function makeSetup(storage: StorageProvider, compute: ComputeProvider) {
  const client = new PangolinClient({
    namespace: 'ns',
    compute: { default: compute },
    credentials: { default: makeCredentials() },
    storage,
    targets: { prod: { compute: 'default', credentials: 'default' } },
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

async function fireAndFinish(
  executor: DispatchExecutor,
  resolveExit: (exit: TaskExit) => void,
): Promise<string> {
  const { dispatchHash } = await executor.fire(baseItem);
  resolveExit({
    exitCode: 0,
    stdout: '',
    stderr: '',
    startedAt: new Date(0),
    finishedAt: new Date(1),
  });
  await new Promise((r) => setImmediate(r));
  return dispatchHash;
}

describe('DispatchExecutor sentinel read (delegated to pangolin-product)', () => {
  it('reconcile delegates to readOutputSentinel with the exact dispatchId reconcile received', async () => {
    const spy = vi.mocked(pangolinProduct.readOutputSentinel);
    spy.mockClear();
    const storage = makeMemoryStorage() as StorageProvider & ReturnType<typeof makeMemoryStorage>;
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { compute, resolveExit } = makeDeferredCompute();
    const { executor } = makeSetup(storage, compute);

    const dispatchHash = await fireAndFinish(executor, resolveExit);
    await executor.reconcile(dispatchHash);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ storage, namespace: 'ns' }, dispatchHash);
  });

  it('reconcile projects patchRef, verify, and outputRefs from an ok sentinel', async () => {
    const storage = makeMemoryStorage() as StorageProvider & ReturnType<typeof makeMemoryStorage>;
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { compute, resolveExit } = makeDeferredCompute();
    const { executor } = makeSetup(storage, compute);

    const { dispatchHash } = await executor.fire(baseItem);
    // Confirm the naming trap: fire's returned dispatchHash IS the id the reader
    // must key the sentinel storage URI on (no hash-to-id translation).
    const sentinelUri = buildDispatchRecordUri('ns', dispatchHash, 'output.json');
    await storage.put(
      sentinelUri,
      new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 1,
          patchRef: 'pangolin://ns/artifact/d/sha256:' + 'a'.repeat(64),
          verify: { passed: true, report: 'ok', durationMs: 12 },
          outputs: [{ path: 'out.txt', ref: 'pangolin://ns/artifact/d/sha256:' + 'b'.repeat(64) }],
        }),
      ),
    );
    resolveExit({
      exitCode: 0,
      stdout: '',
      stderr: '',
      startedAt: new Date(0),
      finishedAt: new Date(1),
    });
    await new Promise((r) => setImmediate(r));

    const res = await executor.reconcile(dispatchHash);
    expect(res?.status).toBe('done');
    expect(res?.resultRef).toBe('pangolin://ns/artifact/d/sha256:' + 'a'.repeat(64));
    expect(res?.verify).toEqual({ passed: true, report: 'ok', durationMs: 12 });
    expect(res?.outputRefs).toEqual({
      'out.txt': 'pangolin://ns/artifact/d/sha256:' + 'b'.repeat(64),
    });
    // Null-prototype projection preserved.
    expect(Object.getPrototypeOf(res!.outputRefs!)).toBeNull();
  });

  it('reconcile yields no patchRef/verify/outputRefs when the sentinel is absent', async () => {
    const storage = makeMemoryStorage() as StorageProvider & ReturnType<typeof makeMemoryStorage>;
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { compute, resolveExit } = makeDeferredCompute();
    const { executor } = makeSetup(storage, compute);

    const dispatchHash = await fireAndFinish(executor, resolveExit);
    // No sentinel written at all.

    const res = await executor.reconcile(dispatchHash);
    expect(res?.status).toBe('done');
    expect(res?.resultRef).toBeUndefined();
    expect(res?.verify).toBeUndefined();
    expect(res?.outputRefs).toBeUndefined();
  });

  it('reconcile yields {} projection when the sentinel is malformed (not JSON)', async () => {
    const storage = makeMemoryStorage() as StorageProvider & ReturnType<typeof makeMemoryStorage>;
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { compute, resolveExit } = makeDeferredCompute();
    const { executor } = makeSetup(storage, compute);

    const dispatchHash = await fireAndFinish(executor, resolveExit);
    const sentinelUri = buildDispatchRecordUri('ns', dispatchHash, 'output.json');
    await storage.put(sentinelUri, new TextEncoder().encode('not valid json {{{'));

    const res = await executor.reconcile(dispatchHash);
    expect(res?.status).toBe('done');
    expect(res?.resultRef).toBeUndefined();
    expect(res?.verify).toBeUndefined();
    expect(res?.outputRefs).toBeUndefined();
  });

  it('reconcile never throws even when storage.get rejects with an unrelated error', async () => {
    const storage = makeMemoryStorage() as StorageProvider & ReturnType<typeof makeMemoryStorage>;
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { compute, resolveExit } = makeDeferredCompute();
    const { executor } = makeSetup(storage, compute);

    const dispatchHash = await fireAndFinish(executor, resolveExit);
    // Replace get with one that rejects for a reason unrelated to "not found".
    const origGet = storage.get.bind(storage);
    storage.get = async (uri: string) => {
      if (uri.includes('output.json')) throw new Error('ECONNRESET: network blip');
      return origGet(uri);
    };

    const res = await executor.reconcile(dispatchHash);
    expect(res?.status).toBe('done');
    expect(res?.resultRef).toBeUndefined();
    expect(res?.verify).toBeUndefined();
    expect(res?.outputRefs).toBeUndefined();
  });
});
