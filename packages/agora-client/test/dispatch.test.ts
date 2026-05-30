import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dispatchWork, fireWork } from '../src/dispatch.js';
import { SecretStoreMismatchError } from '../src/errors.js';
import { AgoraClient } from '../src/client.js';
import type {
  ComputeProvider,
  CredentialProvider,
  StorageProvider,
  TaskSpec,
  TaskHandle,
  TaskExit,
  TelemetryHook,
  LifecycleEvent,
  ResultSink,
  DispatchResult,
  SecretStore,
} from '@quarry-systems/agora-core';
import * as callbackHmac from '../src/callback-hmac.js';

/**
 * In-memory storage stub. `put` indexes the trailing path segment as the
 * content hash so `resolveLatest` returns the most recently written hash for
 * each base URI. `seed()` lets us preload env-bundle blobs without going
 * through `registerEnv`.
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
  };
  return storage;
}

interface RecordedRun {
  spec: TaskSpec;
  credentials: unknown;
}

function makeCompute(opts: { exit?: Partial<TaskExit> } = {}): {
  compute: ComputeProvider;
  runs: RecordedRun[];
} {
  const runs: RecordedRun[] = [];
  let counter = 0;
  const compute: ComputeProvider = {
    name: 'fake-compute',
    async run(spec, ctx) {
      counter += 1;
      runs.push({ spec, credentials: ctx.credentials });
      const handle: TaskHandle = { providerTaskId: `prov-${counter}` };
      return handle;
    },
    async awaitExit(_handle, _ctx): Promise<TaskExit> {
      return {
        exitCode: opts.exit?.exitCode ?? 0,
        startedAt: new Date(0),
        finishedAt: new Date(1000),
        stdout: opts.exit?.stdout ?? 'hello',
        stderr: opts.exit?.stderr ?? '',
      };
    },
  };
  return { compute, runs };
}

function makeCredentials(): CredentialProvider {
  return {
    name: 'fake-creds',
    async resolve() {
      return { kind: 'static', token: 'fake-token' };
    },
  };
}

function makeTelemetry(): { telemetry: TelemetryHook; events: LifecycleEvent[] } {
  const events: LifecycleEvent[] = [];
  const telemetry: TelemetryHook = {
    name: 'fake-telemetry',
    emit(event) {
      events.push(event);
    },
  };
  return { telemetry, events };
}

/**
 * Build a minimal in-memory SecretStore stub. `staged` records every call
 * to `stage` for assertion; `cleanupCalls` records every `cleanupByTag` call.
 */
function makeStore(opts: { name?: string; dir?: string } = {}): {
  store: SecretStore;
  staged: Array<{ name: string; value: string; ttlSeconds: number; tags?: Record<string, string> }>;
  cleanupCalls: Array<{ tagKey: string; tagValue: string }>;
} {
  const staged: Array<{ name: string; value: string; ttlSeconds: number; tags?: Record<string, string> }> = [];
  const cleanupCalls: Array<{ tagKey: string; tagValue: string }> = [];
  const store: SecretStore = {
    name: opts.name ?? 'test-store',
    dir: opts.dir,
    async stage(args) {
      staged.push({ name: args.name, value: args.value, ttlSeconds: args.ttlSeconds, tags: args.tags });
      return { ref: `store-ref://${args.name}`, ttlSeconds: args.ttlSeconds };
    },
    async resolve(ref: string) {
      const entry = staged.find((s) => `store-ref://${s.name}` === ref);
      return entry?.value ?? '';
    },
    async cleanupByTag(tagKey: string, tagValue: string) {
      cleanupCalls.push({ tagKey, tagValue });
    },
  };
  return { store, staged, cleanupCalls };
}

function makeClient(overrides: Partial<ConstructorParameters<typeof AgoraClient>[0]> = {}) {
  const storage = makeMemoryStorage();
  const { compute } = makeCompute();
  const credentials = makeCredentials();
  const opts = {
    namespace: 'ns',
    compute: { default: compute },
    credentials: { default: credentials },
    storage,
    targets: { prod: { compute: 'default', credentials: 'default' } },
    ...overrides,
  };
  return { client: new AgoraClient(opts), storage, compute, credentials };
}

beforeEach(() => {
  vi.restoreAllMocks();
  // Stub HMAC mint so callbacks don't hit AWS.
  vi.spyOn(callbackHmac, 'mintCallbackHmac').mockResolvedValue({
    ref: 'store-ref://agora/callback-hmac/hmac-AbCdEf',
    ttlSeconds: 7500,
  });
});

const WORKER_IMAGE = 'agora/worker:digest';

describe('dispatchWork — TaskSpec.env', () => {
  it('populates AGORA_DISPATCH_ID and AGORA_BUNDLE_REFS_JSON', async () => {
    const storage = makeMemoryStorage();
    storage.seed('my-sub', 'subagent', 'ns', 'sha256:subhash', {
      name: 'my-sub',
      systemPrompt: 'hi',
      capabilities: [],
    });
    const { compute, runs } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });

    const result = await dispatchWork(
      client,
      { subagent: 'my-sub', target: 'prod' },
      { workerImage: WORKER_IMAGE },
    );

    expect(runs).toHaveLength(1);
    const spec = runs[0].spec;
    expect(spec.image).toBe(WORKER_IMAGE);
    expect(spec.env.AGORA_DISPATCH_ID).toBe(result.dispatchId);
    expect(spec.env.AGORA_DISPATCH_ID).toMatch(/^[0-9a-f-]{36}$/);
    expect(spec.env.AGORA_NAMESPACE).toBe('ns');
    expect(spec.env.AGORA_BUNDLE_REFS_JSON).toBeTruthy();
    const bundleRefs = JSON.parse(spec.env.AGORA_BUNDLE_REFS_JSON);
    expect(bundleRefs.subagent.uri).toBe('agora://ns/subagent/my-sub/sha256:subhash');
    expect(bundleRefs.subagent.contentHash).toBe('sha256:subhash');
    expect(bundleRefs.capabilities).toEqual([]);
    expect(bundleRefs.env).toEqual([]);
    expect(spec.env.AGORA_RUNTIME_ADAPTER).toBe('claude-code');
    expect(spec.env.AGORA_INPUT_JSON).toBe('{}');
    expect(spec.dispatchId).toBe(result.dispatchId);
  });

  it('uses caller-supplied dispatchId when given', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:h', { name: 's' });
    const { compute, runs } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });

    await dispatchWork(
      client,
      { subagent: 's', target: 'prod', dispatchId: 'caller-supplied-id' },
      { workerImage: WORKER_IMAGE },
    );

    expect(runs[0].spec.env.AGORA_DISPATCH_ID).toBe('caller-supplied-id');
  });

  it('serializes input JSON into AGORA_INPUT_JSON', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:h', { name: 's' });
    const { compute, runs } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });

    await dispatchWork(
      client,
      { subagent: 's', target: 'prod', input: { hello: 'world', n: 7 } },
      { workerImage: WORKER_IMAGE },
    );

    expect(JSON.parse(runs[0].spec.env.AGORA_INPUT_JSON)).toEqual({ hello: 'world', n: 7 });
  });
});

describe('dispatchWork — ref resolution', () => {
  it('resolves subagent short name to a SubagentRef via storage', async () => {
    const storage = makeMemoryStorage();
    storage.seed('sub-x', 'subagent', 'ns', 'sha256:xhash', { name: 'sub-x' });
    const { compute, runs } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });

    const result = await dispatchWork(
      client,
      { subagent: 'sub-x', target: 'prod' },
      { workerImage: WORKER_IMAGE },
    );

    expect(result.resolved.subagent.name).toBe('sub-x');
    expect(result.resolved.subagent.contentHash).toBe('sha256:xhash');
    const bundleRefs = JSON.parse(runs[0].spec.env.AGORA_BUNDLE_REFS_JSON);
    expect(bundleRefs.subagent.contentHash).toBe('sha256:xhash');
  });

  it('passes through a fully-formed SubagentRef', async () => {
    const storage = makeMemoryStorage();
    const { compute, runs } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });

    await dispatchWork(
      client,
      {
        subagent: { name: 'sub-y', registeredAt: '2026-01-01T00:00:00Z', contentHash: 'sha256:yhash' },
        target: 'prod',
      },
      { workerImage: WORKER_IMAGE },
    );

    const bundleRefs = JSON.parse(runs[0].spec.env.AGORA_BUNDLE_REFS_JSON);
    expect(bundleRefs.subagent.contentHash).toBe('sha256:yhash');
  });

  it('throws if subagent short name does not resolve', async () => {
    const storage = makeMemoryStorage();
    const { compute } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });

    await expect(
      dispatchWork(client, { subagent: 'no-such-sub', target: 'prod' }, { workerImage: WORKER_IMAGE }),
    ).rejects.toThrow(/subagent.*no-such-sub/);
  });

  it('resolves env bundle short names and merges env-bundle secrets into TaskSpec.secretRefs', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    storage.seed('shared', 'env', 'ns', 'sha256:envhash', {
      kind: 'env-bundle',
      name: 'shared',
      values: { LOG: 'info' },
      secretRefs: { DB_PASS: 'arn:env-bundle:dbpass' },
    });
    const { compute, runs } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });

    const result = await dispatchWork(
      client,
      { subagent: 's', env: 'shared', target: 'prod' },
      { workerImage: WORKER_IMAGE },
    );

    expect(result.resolved.env?.[0].name).toBe('shared');
    expect(runs[0].spec.secretRefs.DB_PASS).toBe('arn:env-bundle:dbpass');
    const bundleRefs = JSON.parse(runs[0].spec.env.AGORA_BUNDLE_REFS_JSON);
    expect(bundleRefs.env).toHaveLength(1);
    expect(bundleRefs.env[0].contentHash).toBe('sha256:envhash');
  });

  it('replaces subagent capabilities when work.capabilities is given', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', {
      name: 's',
      capabilities: ['sha256:bound-1', 'sha256:bound-2'],
    });
    storage.seed('replace-cap', 'capability', 'ns', 'sha256:replacehash', {});
    const { compute, runs } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });

    const result = await dispatchWork(
      client,
      { subagent: 's', capabilities: ['replace-cap'], target: 'prod' },
      { workerImage: WORKER_IMAGE },
    );

    // Only the explicit replacement cap is present — bound caps are gone.
    expect(result.resolved.capabilities).toHaveLength(1);
    expect(result.resolved.capabilities[0].name).toBe('replace-cap');
    const bundleRefs = JSON.parse(runs[0].spec.env.AGORA_BUNDLE_REFS_JSON);
    expect(bundleRefs.capabilities).toHaveLength(1);
    expect(bundleRefs.capabilities[0].contentHash).toBe('sha256:replacehash');
  });

  it('throws if both capabilities and addCapabilities are given', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { compute } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });

    await expect(
      dispatchWork(
        client,
        { subagent: 's', target: 'prod', capabilities: ['a'], addCapabilities: ['b'] },
        { workerImage: WORKER_IMAGE },
      ),
    ).rejects.toThrow(/capabilities.*addCapabilities/);
  });
});

describe('dispatchWork — secrets + callback', () => {
  it('stages per-dispatch inline secrets via the target store and emits AGORA_SECRET_STORE_KIND + AGORA_SECRET_STORE_DIR', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { store, staged } = makeStore({ name: 'local-file', dir: '/tmp/agora-secrets' });
    const { compute, runs } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default', secretStore: 's' } },
      secretStores: { s: store },
    });

    const inflight = await fireWork(
      client,
      { subagent: 's', target: 'prod', secrets: { TOKEN: { inline: 'v' } } },
      { workerImage: WORKER_IMAGE },
    );

    // The staged entry should have name `<dispatchId>/TOKEN`
    expect(staged).toHaveLength(1);
    expect(staged[0].name).toBe(`${inflight.dispatchId}/TOKEN`);
    expect(staged[0].value).toBe('v');

    const spec = runs[0].spec;
    expect(spec.env.AGORA_SECRET_STORE_KIND).toBe('local-file');
    expect(spec.env.AGORA_SECRET_STORE_DIR).toBe('/tmp/agora-secrets');
  });

  it('emits AGORA_SECRET_STORE_KIND but NOT AGORA_SECRET_STORE_DIR when store has no dir', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { store } = makeStore({ name: 'aws-secrets-manager' }); // no dir
    const { compute, runs } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default', secretStore: 's' } },
      secretStores: { s: store },
    });

    await dispatchWork(
      client,
      { subagent: 's', target: 'prod', secrets: { TOKEN: { inline: 'v' } } },
      { workerImage: WORKER_IMAGE },
    );

    expect(runs[0].spec.env.AGORA_SECRET_STORE_KIND).toBe('aws-secrets-manager');
    expect(runs[0].spec.env.AGORA_SECRET_STORE_DIR).toBeUndefined();
  });

  it('throws when inline secrets are staged but target has no secretStore', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { compute } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } }, // no secretStore
    });

    await expect(
      dispatchWork(
        client,
        { subagent: 's', target: 'prod', secrets: { TOKEN: { inline: 'v' } } },
        { workerImage: WORKER_IMAGE },
      ),
    ).rejects.toThrow(/secretStore/);
  });

  it('throws when callback is set but target has no secretStore', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { compute } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } }, // no secretStore
    });

    await expect(
      dispatchWork(
        client,
        { subagent: 's', target: 'prod', callback: { url: 'https://example.com/cb' } },
        { workerImage: WORKER_IMAGE },
      ),
    ).rejects.toThrow(/secretStore/);
  });

  it('stages inline per-dispatch secrets and merges with per-dispatch precedence over env-bundle secrets', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    storage.seed('shared', 'env', 'ns', 'sha256:e', {
      kind: 'env-bundle',
      name: 'shared',
      values: {},
      secretRefs: { GH_TOKEN: 'arn:env-bundle:gh-token', DB: 'arn:env-bundle:db' },
    });
    const { store } = makeStore({ name: 'test-store' });
    const { compute, runs } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default', secretStore: 's' } },
      secretStores: { s: store },
    });

    await dispatchWork(
      client,
      {
        subagent: 's',
        env: 'shared',
        target: 'prod',
        secrets: {
          GH_TOKEN: { inline: 'override-me' },           // collides → per-dispatch wins
          API_KEY: { ref: 'store-ref://per-dispatch:api-key' },  // pre-resolved ref form
        },
      },
      { workerImage: WORKER_IMAGE },
    );

    const refs = runs[0].spec.secretRefs;
    // env-bundle secret survives when no collision
    expect(refs.DB).toBe('arn:env-bundle:db');
    // pre-resolved per-dispatch ref passes through
    expect(refs.API_KEY).toBe('store-ref://per-dispatch:api-key');
    // collision: per-dispatch (store-staged) wins, NOT env-bundle
    expect(refs.GH_TOKEN).not.toBe('arn:env-bundle:gh-token');
    expect(refs.GH_TOKEN).toMatch(/GH_TOKEN$/);
  });

  it('passes per-dispatch secret refs to the worker via AGORA_PER_DISPATCH_SECRET_REFS_JSON', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    storage.seed('shared', 'env', 'ns', 'sha256:e', {
      kind: 'env-bundle',
      name: 'shared',
      values: {},
      secretRefs: { DB: 'arn:env-bundle:db' },
    });
    const { store } = makeStore({ name: 'test-store' });
    const { compute, runs } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default', secretStore: 's' } },
      secretStores: { s: store },
    });

    await dispatchWork(
      client,
      {
        subagent: 's',
        env: 'shared',
        target: 'prod',
        secrets: {
          API_KEY: { ref: 'store-ref://per-dispatch:api-key' },
          INLINE_TOK: { inline: 'v' },
        },
      },
      { workerImage: WORKER_IMAGE },
    );

    const raw = runs[0].spec.env.AGORA_PER_DISPATCH_SECRET_REFS_JSON;
    expect(raw).toBeTruthy();
    const refs = JSON.parse(raw);
    // Per-dispatch refs are present so the worker can resolve + register them.
    expect(refs.API_KEY).toBe('store-ref://per-dispatch:api-key');
    expect(refs.INLINE_TOK).toMatch(/INLINE_TOK$/);
    // Env-bundle secrets are NOT in this map — the worker resolves those from
    // the env-bundle blob itself; duplicating them here would double-resolve.
    expect(refs.DB).toBeUndefined();
  });

  it('mints callback HMAC and injects AGORA_CALLBACK_URL + AGORA_CALLBACK_TOKEN_REF when work.callback set', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { store } = makeStore({ name: 'test-store' });
    const { compute, runs } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default', secretStore: 's' } },
      secretStores: { s: store },
    });

    await dispatchWork(
      client,
      { subagent: 's', target: 'prod', callback: { url: 'https://example.com/cb' } },
      { workerImage: WORKER_IMAGE },
    );

    expect(callbackHmac.mintCallbackHmac).toHaveBeenCalledTimes(1);
    expect(runs[0].spec.env.AGORA_CALLBACK_URL).toBe('https://example.com/cb');
    expect(runs[0].spec.env.AGORA_CALLBACK_TOKEN_REF).toMatch(/hmac-AbCdEf/);
  });

  it('does not mint HMAC when no callback is configured', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { compute, runs } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });

    await dispatchWork(client, { subagent: 's', target: 'prod' }, { workerImage: WORKER_IMAGE });

    expect(callbackHmac.mintCallbackHmac).not.toHaveBeenCalled();
    expect(runs[0].spec.env.AGORA_CALLBACK_URL).toBeUndefined();
    expect(runs[0].spec.env.AGORA_CALLBACK_TOKEN_REF).toBeUndefined();
  });

  it('flows dispatchTimeoutSeconds to the store stage call via computeInlineSecretTtl', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { store, staged } = makeStore({ name: 'test-store' });
    const { compute } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default', secretStore: 's' } },
      secretStores: { s: store },
    });

    await dispatchWork(
      client,
      {
        subagent: 's',
        target: 'prod',
        timeoutSeconds: 1800,
        secrets: { K: { inline: 'v' } },
      },
      { workerImage: WORKER_IMAGE },
    );

    expect(staged).toHaveLength(1);
    // TTL = 1800 + 300 = 2100
    expect(staged[0].ttlSeconds).toBe(2100);
  });
});

describe('dispatchWork — provider + telemetry + sink + record', () => {
  it('selects target provider, calls run + awaitExit, and writes the dispatch record', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { compute, runs } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });

    const result = await dispatchWork(
      client,
      { subagent: 's', target: 'prod' },
      { workerImage: WORKER_IMAGE },
    );

    expect(runs).toHaveLength(1);
    expect(runs[0].credentials).toEqual({ kind: 'static', token: 'fake-token' });

    // Record was written under the canonical URI.
    const recordUri = `agora://ns/dispatches/${result.dispatchId}/record.json`;
    expect(storage.blobs.has(recordUri)).toBe(true);
    const parsed = JSON.parse(new TextDecoder().decode(storage.blobs.get(recordUri)!));
    expect(parsed.providerTaskId).toBe('prov-1');
    expect(parsed.target).toBe('prod');
    expect(parsed.dispatchId).toBe(result.dispatchId);
    expect(parsed.retentionDays).toBe(30);
  });

  it('throws when work.target does not resolve', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { compute } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });

    await expect(
      dispatchWork(client, { subagent: 's', target: 'staging' }, { workerImage: WORKER_IMAGE }),
    ).rejects.toThrow(/staging/);
  });

  it('emits dispatch.accepted with resolved refs when telemetry is set', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    storage.seed('cap-a', 'capability', 'ns', 'sha256:caphash', {});
    const { telemetry, events } = makeTelemetry();
    const { compute } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
      telemetry,
    });

    await dispatchWork(
      client,
      { subagent: 's', target: 'prod', capabilities: ['cap-a'] },
      { workerImage: WORKER_IMAGE },
    );

    const accepted = events.find((e) => e.kind === 'dispatch.accepted');
    expect(accepted).toBeDefined();
    if (accepted && accepted.kind === 'dispatch.accepted') {
      expect(accepted.target).toBe('prod');
      // ResolvedRefs is currently typed as CapabilityRef[]; verify capability is echoed back.
      expect(accepted.resolved).toBeDefined();
    }
  });

  it('uses ResultSink.collect when set, otherwise builds a minimal result from exit', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const sinkResult: DispatchResult = {
      dispatchId: 'will-be-overridden',
      exitCode: 0,
      stdout: 'SINK-STDOUT',
      stderr: '',
      durationMs: 9999,
      resolved: {
        subagent: { name: 's', registeredAt: 'x', contentHash: 'sha256:s' },
        capabilities: [],
      },
    };
    const sink: ResultSink = {
      name: 'fake-sink',
      collect: vi.fn(async () => sinkResult),
    };
    const { compute } = makeCompute({ exit: { stdout: 'EXIT-STDOUT' } });
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
      resultSink: sink,
    });

    const result = await dispatchWork(
      client,
      { subagent: 's', target: 'prod' },
      { workerImage: WORKER_IMAGE },
    );
    expect(sink.collect).toHaveBeenCalledTimes(1);
    expect(result.stdout).toBe('SINK-STDOUT');
  });

  it('builds minimal DispatchResult when no sink is set', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { compute } = makeCompute({ exit: { stdout: 'EXIT-STDOUT', exitCode: 7 } });
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });

    const result = await dispatchWork(
      client,
      { subagent: 's', target: 'prod' },
      { workerImage: WORKER_IMAGE },
    );
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe('EXIT-STDOUT');
    expect(result.resolved.subagent.contentHash).toBe('sha256:s');
  });

  it('cleans up per-dispatch staged secrets after awaitExit via store.cleanupByTag', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { store, cleanupCalls } = makeStore({ name: 'test-store' });
    const { compute } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default', secretStore: 's' } },
      secretStores: { s: store },
    });

    const result = await dispatchWork(
      client,
      { subagent: 's', target: 'prod', secrets: { TOKEN: { inline: 'x' } } },
      { workerImage: WORKER_IMAGE },
    );

    // cleanup is best-effort; allow microtask flush
    await new Promise((r) => setImmediate(r));
    expect(cleanupCalls).toHaveLength(1);
    expect(cleanupCalls[0].tagKey).toBe('agora:dispatchId');
    expect(cleanupCalls[0].tagValue).toBe(result.dispatchId);
  });

  it('cleans up per-dispatch staged secrets even when awaitExit throws', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { store, cleanupCalls } = makeStore({ name: 'test-store' });
    // Compute provider whose awaitExit throws — simulates a provider-side
    // failure between run() and exit. The cleanup of per-dispatch staged
    // secrets must still happen (best-effort, never propagate).
    const throwingCompute: ComputeProvider = {
      name: 'throwing-compute',
      async run(_spec, _ctx): Promise<TaskHandle> {
        return { providerTaskId: 'prov-throws' };
      },
      async awaitExit(_handle, _ctx): Promise<TaskExit> {
        throw new Error('awaitExit failed');
      },
    };
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: throwingCompute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default', secretStore: 's' } },
      secretStores: { s: store },
    });

    await expect(
      dispatchWork(
        client,
        {
          subagent: 's',
          target: 'prod',
          dispatchId: 'cleanup-on-throw-id',
          secrets: { TOKEN: { inline: 'x' } },
        },
        { workerImage: WORKER_IMAGE },
      ),
    ).rejects.toThrow(/awaitExit failed/);

    // cleanup is best-effort; allow microtask flush
    await new Promise((r) => setImmediate(r));
    expect(cleanupCalls).toHaveLength(1);
    expect(cleanupCalls[0].tagKey).toBe('agora:dispatchId');
    expect(cleanupCalls[0].tagValue).toBe('cleanup-on-throw-id');
  });

  it('honors work.retentionDays in the written record', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { compute } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });

    const result = await dispatchWork(
      client,
      { subagent: 's', target: 'prod', retentionDays: 90 },
      { workerImage: WORKER_IMAGE },
    );
    const recordUri = `agora://ns/dispatches/${result.dispatchId}/record.json`;
    const parsed = JSON.parse(new TextDecoder().decode(storage.blobs.get(recordUri)!));
    expect(parsed.retentionDays).toBe(90);
  });
});

describe('fireWork / reconcile split (D9)', () => {
  it('fireWork runs the provider once and returns an in-flight handle WITHOUT awaiting exit', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    let awaitExitCalls = 0;
    const runs: RecordedRun[] = [];
    const compute: ComputeProvider = {
      name: 'fire-compute',
      async run(spec, ctx) {
        runs.push({ spec, credentials: ctx.credentials });
        return { providerTaskId: 'prov-fire' };
      },
      async awaitExit(): Promise<TaskExit> {
        awaitExitCalls += 1;
        return { exitCode: 0, startedAt: new Date(0), finishedAt: new Date(1000), stdout: 'x', stderr: '' };
      },
    };
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });

    const inflight = await fireWork(client, { subagent: 's', target: 'prod' }, { workerImage: WORKER_IMAGE });

    expect(runs).toHaveLength(1);
    expect(awaitExitCalls).toBe(0); // fire fires; it does NOT await exit
    expect(inflight.handle.providerTaskId).toBe('prov-fire');
    expect(inflight.dispatchId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reconcile(exit) builds the result and writes the dispatch record, independently of awaitExit', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { compute } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });

    const inflight = await fireWork(client, { subagent: 's', target: 'prod' }, { workerImage: WORKER_IMAGE });
    const syntheticExit: TaskExit = {
      exitCode: 3,
      startedAt: new Date(0),
      finishedAt: new Date(1000),
      stdout: 'RECON',
      stderr: '',
    };
    const result = await inflight.reconcile(syntheticExit);

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe('RECON');
    expect(result.resolved.subagent.contentHash).toBe('sha256:s');
    const recordUri = `agora://ns/dispatches/${result.dispatchId}/record.json`;
    expect(storage.blobs.has(recordUri)).toBe(true);
    const parsed = JSON.parse(new TextDecoder().decode(storage.blobs.get(recordUri)!));
    expect(parsed.providerTaskId).toBe('prov-1');
    expect(parsed.target).toBe('prod');
  });

  it('cleanup() calls store.cleanupByTag for per-dispatch staged secrets', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { store, cleanupCalls } = makeStore({ name: 'test-store' });
    const { compute } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default', secretStore: 's' } },
      secretStores: { s: store },
    });

    const inflight = await fireWork(
      client,
      { subagent: 's', target: 'prod', secrets: { TOKEN: { inline: 'x' } } },
      { workerImage: WORKER_IMAGE },
    );
    inflight.cleanup();

    await new Promise((r) => setImmediate(r)); // cleanup is best-effort; flush microtasks
    expect(cleanupCalls).toHaveLength(1);
    expect(cleanupCalls[0].tagKey).toBe('agora:dispatchId');
    expect(cleanupCalls[0].tagValue).toBe(inflight.dispatchId);
  });
});

describe('dispatchWork — store kind mismatch', () => {
  it('throws SecretStoreMismatchError when a bundle\'s store kind != the target store kind', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    // Bundle was staged with store kind "local-file"
    storage.seed('localBundle', 'env', 'ns', 'sha256:lb', {
      kind: 'env-bundle',
      name: 'localBundle',
      store: 'local-file',
      secretRefs: { DB_PASS: 'file:///secrets/db' },
    });
    // Target's store is "aws-secrets-manager"
    const { store } = makeStore({ name: 'aws-secrets-manager' });
    const { compute } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { awsTarget: { compute: 'default', credentials: 'default', secretStore: 'aws' } },
      secretStores: { aws: store },
    });

    await expect(
      fireWork(client, { target: 'awsTarget', subagent: 's', env: 'localBundle' }, { workerImage: WORKER_IMAGE }),
    ).rejects.toThrow(/staged for store kind "local-file"/);
  });

  it('throws a SecretStoreMismatchError with correct bundle name and kinds', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    storage.seed('myBundle', 'env', 'ns', 'sha256:mb', {
      kind: 'env-bundle',
      name: 'myBundle',
      store: 'local-file',
      secretRefs: {},
    });
    const { store } = makeStore({ name: 'aws-secrets-manager' });
    const { compute } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { awsTarget: { compute: 'default', credentials: 'default', secretStore: 'aws' } },
      secretStores: { aws: store },
    });

    let caughtError: unknown;
    try {
      await fireWork(client, { target: 'awsTarget', subagent: 's', env: 'myBundle' }, { workerImage: WORKER_IMAGE });
    } catch (e) {
      caughtError = e;
    }
    expect(caughtError).toBeInstanceOf(SecretStoreMismatchError);
    const err = caughtError as SecretStoreMismatchError;
    expect(err.bundle).toBe('myBundle');
    expect(err.bundleKind).toBe('local-file');
    expect(err.targetKind).toBe('aws-secrets-manager');
  });

  it('dispatches normally when a bundle has no recorded store kind (values-only / legacy)', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    // Bundle has no store field — legacy / values-only
    storage.seed('legacyBundle', 'env', 'ns', 'sha256:lg', {
      kind: 'env-bundle',
      name: 'legacyBundle',
      secretRefs: { DB: 'arn:aws:secretsmanager:us-east-1:123:secret:db' },
    });
    const { store } = makeStore({ name: 'aws-secrets-manager' });
    const { compute } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { awsTarget: { compute: 'default', credentials: 'default', secretStore: 'aws' } },
      secretStores: { aws: store },
    });

    // Should NOT throw even though target uses aws-secrets-manager
    await expect(
      fireWork(client, { target: 'awsTarget', subagent: 's', env: 'legacyBundle' }, { workerImage: WORKER_IMAGE }),
    ).resolves.toBeDefined();
  });

  it('dispatches normally when a bundle\'s store kind matches the target store kind', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    // Bundle recorded with same store kind as the target
    storage.seed('awsBundle', 'env', 'ns', 'sha256:ab', {
      kind: 'env-bundle',
      name: 'awsBundle',
      store: 'aws-secrets-manager',
      secretRefs: { DB: 'arn:aws:secretsmanager:us-east-1:123:secret:db' },
    });
    const { store } = makeStore({ name: 'aws-secrets-manager' });
    const { compute } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { awsTarget: { compute: 'default', credentials: 'default', secretStore: 'aws' } },
      secretStores: { aws: store },
    });

    // Should NOT throw — kinds match
    await expect(
      fireWork(client, { target: 'awsTarget', subagent: 's', env: 'awsBundle' }, { workerImage: WORKER_IMAGE }),
    ).resolves.toBeDefined();
  });
});
