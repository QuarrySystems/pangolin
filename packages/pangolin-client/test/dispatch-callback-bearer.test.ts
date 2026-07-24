import { describe, it, expect, vi } from 'vitest';
import { fireWork } from '../src/dispatch.js';
import { PangolinClient } from '../src/client.js';
import type {
  ComputeProvider,
  CredentialProvider,
  StorageProvider,
  TaskSpec,
  TaskHandle,
  TaskExit,
  SecretStore,
} from '@quarry-systems/pangolin-core';

const WORKER_IMAGE = 'ghcr.io/x/worker@sha256:' + 'a'.repeat(64);

/**
 * In-memory storage stub. Mirrors the helper in dispatch.test.ts / dispatch-fire.test.ts.
 */
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

interface RecordedRun {
  spec: TaskSpec;
}

function makeCompute(): { compute: ComputeProvider; runs: RecordedRun[] } {
  const runs: RecordedRun[] = [];
  let counter = 0;
  const compute: ComputeProvider = {
    name: 'fake-compute',
    async run(spec, _ctx) {
      counter += 1;
      runs.push({ spec });
      const handle: TaskHandle = { providerTaskId: `prov-${counter}` };
      return handle;
    },
    async awaitExit(_handle, _ctx): Promise<TaskExit> {
      return {
        exitCode: 0,
        startedAt: new Date(0),
        finishedAt: new Date(1000),
        stdout: 'done',
        stderr: '',
      };
    },
  };
  return { compute, runs };
}

/**
 * In-memory SecretStore stub with a spied `resolve` so tests can assert the
 * bearerRef was NEVER passed through it (pure pass-through, never resolved
 * client-side).
 */
function makeStore(opts: { name?: string } = {}): {
  store: SecretStore;
  resolveSpy: ReturnType<typeof vi.fn>;
} {
  const staged: Array<{ name: string; value: string }> = [];
  const resolveSpy = vi.fn(async (ref: string) => {
    const entry = staged.find((s) => `store-ref://${s.name}` === ref);
    return entry?.value ?? '';
  });
  const store: SecretStore = {
    name: opts.name ?? 'test-store',
    async stage(args) {
      staged.push({ name: args.name, value: args.value });
      return { ref: `store-ref://${args.name}`, ttlSeconds: args.ttlSeconds };
    },
    resolve: resolveSpy,
    async cleanupByTag(_tagKey: string, _tagValue: string) {
      // no-op
    },
  };
  return { store, resolveSpy };
}

describe('dispatch: PANGOLIN_CALLBACK_BEARER_REF pass-through', () => {
  it('emits PANGOLIN_CALLBACK_BEARER_REF when callback.bearerRef is set', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { store } = makeStore();
    const { compute, runs } = makeCompute();

    const client = new PangolinClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default', secretStore: 's' } },
      secretStores: { s: store },
    });

    await fireWork(
      client,
      {
        subagent: 's',
        target: 'prod',
        callback: { url: 'https://x', bearerRef: 'secretref://b' },
      },
      { workerImage: WORKER_IMAGE },
    );

    expect(runs[0]!.spec.env.PANGOLIN_CALLBACK_BEARER_REF).toBe('secretref://b');
  });

  it('omits PANGOLIN_CALLBACK_BEARER_REF when bearerRef is absent', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { store } = makeStore();
    const { compute, runs } = makeCompute();

    const client = new PangolinClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default', secretStore: 's' } },
      secretStores: { s: store },
    });

    await fireWork(
      client,
      { subagent: 's', target: 'prod', callback: { url: 'https://x' } },
      { workerImage: WORKER_IMAGE },
    );

    expect(runs[0]!.spec.env.PANGOLIN_CALLBACK_BEARER_REF).toBeUndefined();
    // The existing callback env assignments are unchanged.
    expect(runs[0]!.spec.env.PANGOLIN_CALLBACK_URL).toBe('https://x');
    expect(runs[0]!.spec.env.PANGOLIN_CALLBACK_TOKEN_REF).toBeTruthy();
  });

  it('passes the bearerRef through UNRESOLVED — SecretStore.resolve is never called with it', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { store, resolveSpy } = makeStore();
    const { compute } = makeCompute();

    const client = new PangolinClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default', secretStore: 's' } },
      secretStores: { s: store },
    });

    const bearerRef = 'secretref://b';
    await fireWork(
      client,
      { subagent: 's', target: 'prod', callback: { url: 'https://x', bearerRef } },
      { workerImage: WORKER_IMAGE },
    );

    // resolve() may be called for other refs (e.g. the callback HMAC key), but
    // never with the bearerRef itself — the client never resolves it.
    expect(resolveSpy).not.toHaveBeenCalledWith(bearerRef);
  });
});
