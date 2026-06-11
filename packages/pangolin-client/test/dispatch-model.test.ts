import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PangolinClient } from '../src/index.js';
import type {
  ComputeProvider,
  CredentialProvider,
  StorageProvider,
  TaskExit,
  TaskSpec,
} from '@quarry-systems/pangolin-core';

/**
 * Minimal in-memory storage stub — mirrors dispatch-fire.test.ts.
 */
function makeMemoryStorage(): StorageProvider & {
  seed(name: string, type: string, namespace: string, contentHash: string, payload: unknown): void;
} {
  const blobs = new Map<string, Uint8Array>();
  const registry = new Map<
    string,
    Array<{ contentHash: string; registeredAt: string; pinnedUri: string }>
  >();
  let monotonic = 0;
  const storage: StorageProvider & {
    seed(name: string, type: string, namespace: string, contentHash: string, payload: unknown): void;
  } = {
    name: 'memory',
    seed(name, type, namespace, contentHash, payload) {
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

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('client.dispatch model passthrough', () => {
  /**
   * Build a shared test harness: one storage, one compute that captures the
   * TaskSpec, one client. Returns helpers to fire dispatches and inspect the
   * captured spec.
   */
  function makeHarness() {
    const storage = makeMemoryStorage();
    storage.seed('echo', 'subagent', 'ns', 'sha256:echo', { name: 'echo' });

    let capturedSpec: TaskSpec | undefined;
    const compute: ComputeProvider = {
      name: 'fake-compute',
      async run(spec, _ctx) {
        capturedSpec = spec;
        return { providerTaskId: 'prov-model-test' };
      },
      async awaitExit(_handle, _ctx): Promise<TaskExit> {
        return {
          exitCode: 0,
          startedAt: new Date(0),
          finishedAt: new Date(1000),
          stdout: 'ok',
          stderr: '',
        };
      },
    };

    const client = new PangolinClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { local: { compute: 'default', credentials: 'default' } },
    });

    return {
      client,
      getLastSpec: () => capturedSpec,
    };
  }

  it('emits PANGOLIN_MODEL verbatim when work.model is set', async () => {
    const { client, getLastSpec } = makeHarness();

    await client.dispatch.fire({
      subagent: 'echo',
      target: 'local',
      workerImage: 'img:latest',
      model: 'max',
    });

    const spec = getLastSpec();
    expect(spec).toBeDefined();
    expect(spec!.env.PANGOLIN_MODEL).toBe('max'); // verbatim — no level mapping client-side
  });

  it('does not emit PANGOLIN_MODEL when work.model is unset', async () => {
    const { client, getLastSpec } = makeHarness();

    await client.dispatch.fire({
      subagent: 'echo',
      target: 'local',
      workerImage: 'img:latest',
      // model intentionally omitted
    });

    const spec = getLastSpec();
    expect(spec).toBeDefined();
    expect('PANGOLIN_MODEL' in spec!.env).toBe(false);
  });

  it('passes through model level values verbatim (fast, standard, max)', async () => {
    const levels = ['fast', 'standard', 'max'] as const;
    for (const level of levels) {
      const { client, getLastSpec } = makeHarness();

      await client.dispatch.fire({
        subagent: 'echo',
        target: 'local',
        workerImage: 'img:latest',
        model: level,
      });

      const spec = getLastSpec();
      expect(spec!.env.PANGOLIN_MODEL).toBe(level);
    }
  });

  it('passes through a provider-native model id verbatim (no mapping)', async () => {
    const { client, getLastSpec } = makeHarness();

    await client.dispatch.fire({
      subagent: 'echo',
      target: 'local',
      workerImage: 'img:latest',
      model: 'claude-opus-4-5',
    });

    const spec = getLastSpec();
    expect(spec!.env.PANGOLIN_MODEL).toBe('claude-opus-4-5');
  });

  it('does not apply client.defaultModel to PANGOLIN_MODEL when work.model is unset (no client-side def-fallback)', async () => {
    // Regression pin: the client owns no model defaulting logic; the worker owns the def-fallback.
    const storage = makeMemoryStorage();
    storage.seed('echo', 'subagent', 'ns', 'sha256:echo', { name: 'echo' });

    let capturedSpec: TaskSpec | undefined;
    const compute: ComputeProvider = {
      name: 'fake-compute',
      async run(spec, _ctx) {
        capturedSpec = spec;
        return { providerTaskId: 'prov-nodefault-test' };
      },
      async awaitExit(_handle, _ctx): Promise<TaskExit> {
        return { exitCode: 0, startedAt: new Date(0), finishedAt: new Date(1000), stdout: '', stderr: '' };
      },
    };

    // Client is constructed WITH a defaultModel — it must NOT be injected as PANGOLIN_MODEL
    // when the dispatch omits work.model.
    const client = new PangolinClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { local: { compute: 'default', credentials: 'default' } },
      defaultModel: 'standard', // client has a default — but the worker owns def-fallback
    });

    await client.dispatch.fire({
      subagent: 'echo',
      target: 'local',
      workerImage: 'img:latest',
      // no work.model
    });

    expect(capturedSpec).toBeDefined();
    // Key must be ABSENT — client must NOT fall back to defaultModel for PANGOLIN_MODEL
    expect('PANGOLIN_MODEL' in capturedSpec!.env).toBe(false);
  });

  it('emits empty-string PANGOLIN_MODEL is excluded (treats empty string as unset)', async () => {
    // Per the implementation contract: `work.model !== ''` guard ensures empty
    // string is treated the same as undefined — PANGOLIN_MODEL is not emitted.
    const { client, getLastSpec } = makeHarness();

    await client.dispatch.fire({
      subagent: 'echo',
      target: 'local',
      workerImage: 'img:latest',
      model: '',
    });

    const spec = getLastSpec();
    expect(spec).toBeDefined();
    expect('PANGOLIN_MODEL' in spec!.env).toBe(false);
  });
});
