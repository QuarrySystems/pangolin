import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PangolinClient } from '../src/index.js'; // barrel import installs the prototype getters
import type {
  ComputeProvider,
  CredentialProvider,
  StorageProvider,
  TaskExit,
  SecretStore,
} from '@quarry-systems/pangolin-core';

/**
 * In-memory storage stub. Mirrors the helper in dispatch.test.ts.
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
    seed(name: string, type: string, namespace: string, contentHash: string, payload: unknown): void;
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
      return { uri: last.pinnedUri, contentHash: last.contentHash, registeredAt: last.registeredAt };
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

/**
 * Build a minimal in-memory SecretStore stub. `staged` records every call
 * to `stage` for assertion. `stage()` returns `store-ref://<name>` as the ref.
 */
function makeStore(opts: { name?: string; dir?: string } = {}): {
  store: SecretStore;
  staged: Array<{ name: string; value: string; ttlSeconds: number }>;
} {
  const staged: Array<{ name: string; value: string; ttlSeconds: number }> = [];
  const store: SecretStore = {
    name: opts.name ?? 'test-store',
    dir: opts.dir,
    async stage(args) {
      staged.push({ name: args.name, value: args.value, ttlSeconds: args.ttlSeconds });
      return { ref: `store-ref://${args.name}`, ttlSeconds: args.ttlSeconds };
    },
    async resolve(ref: string) {
      const entry = staged.find((s) => `store-ref://${s.name}` === ref);
      return entry?.value ?? '';
    },
    async cleanupByTag(_tagKey: string, _tagValue: string) {
      // no-op
    },
  };
  return { store, staged };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('client.dispatch.fire', () => {
  it('client.dispatch.fire starts the dispatch and returns an InFlightDispatch WITHOUT awaiting exit', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });

    let runCalls = 0;
    let awaitExitCalls = 0;

    const compute: ComputeProvider = {
      name: 'fake-compute',
      async run(_spec, _ctx) {
        runCalls += 1;
        return { providerTaskId: 'prov-fire-test' };
      },
      async awaitExit(_handle, _ctx): Promise<TaskExit> {
        awaitExitCalls += 1;
        return {
          exitCode: 0,
          startedAt: new Date(0),
          finishedAt: new Date(1000),
          stdout: 'done',
          stderr: '',
        };
      },
    };

    const client = new PangolinClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });

    const inflight = await client.dispatch.fire({
      subagent: 's',
      target: 'prod',
      workerImage: 'img',
    });

    expect(runCalls).toBe(1);
    expect(awaitExitCalls).toBe(0); // fire does NOT await exit
    expect(typeof inflight.awaitExit).toBe('function');
    expect(typeof inflight.reconcile).toBe('function');
    expect(typeof inflight.cleanup).toBe('function');
    expect(inflight.dispatchId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('exposes resolved refs + secret references (not values) on the in-flight dispatch', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:abc123', { name: 's' });

    const compute: ComputeProvider = {
      name: 'fake-compute',
      async run(_spec, _ctx) {
        return { providerTaskId: 'prov-resolved-test' };
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

    const { store } = makeStore({ name: 'test-store' });

    const client = new PangolinClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default', secretStore: 's' } },
      secretStores: { s: store },
    });

    const INLINE_VALUE = 'super-secret-value';
    const flight = await client.dispatch.fire({
      subagent: 's',
      target: 'prod',
      workerImage: 'ghcr.io/x/worker@sha256:abc',
      secrets: { MY_KEY: { inline: INLINE_VALUE } },
    });

    expect(flight.resolved.workerImage).toBe('ghcr.io/x/worker@sha256:abc');
    expect(flight.resolved.subagent.contentHash).toMatch(/^sha256:/);
    expect(Array.isArray(flight.resolved.capabilities)).toBe(true);
    expect(Array.isArray(flight.resolved.env)).toBe(true);

    // The secret was staged — MY_KEY should appear as a store ref, not the raw value.
    const myKeyRef = flight.resolved.secretRefs['MY_KEY'];
    expect(typeof myKeyRef).toBe('string');
    // The ref must match what the store's stage() returned (contains the env name).
    expect(myKeyRef).toMatch(/MY_KEY$/);
    // The inline value must NEVER appear as the ref — the no-leak guarantee is load-bearing.
    expect(myKeyRef).not.toBe(INLINE_VALUE);
    // All secret ref values must be strings (general invariant).
    for (const ref of Object.values(flight.resolved.secretRefs)) {
      expect(typeof ref).toBe('string');
    }
  });

  it('threads inputRefs into bundleRefs.inputs with the hash from the pinned URI', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });

    let capturedSpec: import('@quarry-systems/pangolin-core').TaskSpec | undefined;
    const compute: ComputeProvider = {
      name: 'fake-compute',
      async run(spec, _ctx) {
        capturedSpec = spec;
        return { providerTaskId: 'prov-inputrefs-test' };
      },
      async awaitExit(_handle, _ctx): Promise<TaskExit> {
        return { exitCode: 0, startedAt: new Date(0), finishedAt: new Date(1000), stdout: 'done', stderr: '' };
      },
    };

    const client = new PangolinClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });

    const uri = 'pangolin://ns/artifact/d-up/sha256:' + 'a'.repeat(64);
    const inflight = await client.dispatch.fire({
      subagent: 's',
      target: 'prod',
      workerImage: 'img',
      inputRefs: { patch: uri },
    });

    expect(capturedSpec).toBeDefined();
    const bundleRefs = JSON.parse(capturedSpec!.env.PANGOLIN_BUNDLE_REFS_JSON);
    expect(bundleRefs.inputs).toEqual([{ key: 'patch', uri, contentHash: 'sha256:' + 'a'.repeat(64) }]);
    expect(inflight.resolved.inputRefs).toEqual({ patch: uri });
  });

  it('throws before container starts when inputRefs contains an unpinned URI (no contentHash)', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });

    const compute: ComputeProvider = {
      name: 'fake-compute',
      async run(_spec, _ctx) {
        return { providerTaskId: 'never' };
      },
      async awaitExit(_handle, _ctx): Promise<TaskExit> {
        return { exitCode: 0, startedAt: new Date(0), finishedAt: new Date(0), stdout: '', stderr: '' };
      },
    };

    const client = new PangolinClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });

    const unpinnedUri = 'pangolin://ns/artifact/d-up'; // no contentHash segment
    await expect(
      client.dispatch.fire({
        subagent: 's',
        target: 'prod',
        workerImage: 'img',
        inputRefs: { patch: unpinnedUri },
      }),
    ).rejects.toThrow(/inputRefs\['patch'\].*pinned/);
  });

  it('throws before container starts when inputRefs contains a malformed URI', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });

    const compute: ComputeProvider = {
      name: 'fake-compute',
      async run(_spec, _ctx) {
        return { providerTaskId: 'never' };
      },
      async awaitExit(_handle, _ctx): Promise<TaskExit> {
        return { exitCode: 0, startedAt: new Date(0), finishedAt: new Date(0), stdout: '', stderr: '' };
      },
    };

    const client = new PangolinClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });

    const malformedUri = 'not-an-pangolin-uri';
    await expect(
      client.dispatch.fire({
        subagent: 's',
        target: 'prod',
        workerImage: 'img',
        inputRefs: { patch: malformedUri },
      }),
    ).rejects.toThrow(); // parsePangolinUri throws on malformed URIs
  });

  it('omitting inputRefs yields inputs: [] in bundleRefs (additive, old workers tolerate it)', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });

    let capturedSpec: import('@quarry-systems/pangolin-core').TaskSpec | undefined;
    const compute: ComputeProvider = {
      name: 'fake-compute',
      async run(spec, _ctx) {
        capturedSpec = spec;
        return { providerTaskId: 'prov-no-inputs-test' };
      },
      async awaitExit(_handle, _ctx): Promise<TaskExit> {
        return { exitCode: 0, startedAt: new Date(0), finishedAt: new Date(1000), stdout: 'done', stderr: '' };
      },
    };

    const client = new PangolinClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });

    await client.dispatch.fire({
      subagent: 's',
      target: 'prod',
      workerImage: 'img',
      // no inputRefs
    });

    expect(capturedSpec).toBeDefined();
    const bundleRefs = JSON.parse(capturedSpec!.env.PANGOLIN_BUNDLE_REFS_JSON);
    expect(bundleRefs.inputs).toEqual([]);
  });

  it('client.dispatch.fire is a method on the dispatch callable (not a standalone fn)', () => {
    const storage = makeMemoryStorage();
    const compute: ComputeProvider = {
      name: 'noop',
      async run() {
        return { providerTaskId: 'x' };
      },
      async awaitExit(): Promise<TaskExit> {
        return { exitCode: 0, startedAt: new Date(0), finishedAt: new Date(0), stdout: '', stderr: '' };
      },
    };
    const client = new PangolinClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });

    expect(typeof client.dispatch.fire).toBe('function');
    // Existing methods are still intact
    expect(typeof client.dispatch.describe).toBe('function');
    expect(typeof client.dispatch.cancel).toBe('function');
  });
});
