import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireWork } from '../src/dispatch.js';
import { AgoraClient } from '../src/client.js';
import type {
  ComputeProvider,
  CredentialProvider,
  StorageProvider,
  TaskSpec,
  TaskHandle,
  TaskExit,
} from '@quarry-systems/agora-core';
import * as callbackHmac from '../src/callback-hmac.js';

/**
 * In-memory storage stub — mirrors the helper in dispatch.test.ts.
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

function makeCompute(): {
  compute: ComputeProvider;
  capturedSpec: { current: TaskSpec | undefined };
} {
  const capturedSpec: { current: TaskSpec | undefined } = { current: undefined };
  const compute: ComputeProvider = {
    name: 'fake-compute',
    async run(spec, _ctx): Promise<TaskHandle> {
      capturedSpec.current = spec;
      return { providerTaskId: 'prov-pipeline-test' };
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
  return { compute, capturedSpec };
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
  vi.spyOn(callbackHmac, 'mintCallbackHmac').mockResolvedValue({
    ref: 'store-ref://agora/callback-hmac/hmac-AbCdEf',
    ttlSeconds: 7500,
  });
});

const WORKER_IMAGE = 'agora/worker:digest';
const PIPELINE_HASH = 'sha256:' + 'b'.repeat(64);
const PINNED_PIPELINE_URI = `agora://ns/pipeline/my-pipeline/${PIPELINE_HASH}`;

describe('dispatchWork — pipelineRef', () => {
  it('a pinned pipelineRef lands in bundleRefs.pipeline and resolved.pipelineRef', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { compute, capturedSpec } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });

    const inflight = await fireWork(
      client,
      {
        subagent: 's',
        target: 'prod',
        pipelineRef: PINNED_PIPELINE_URI,
      },
      { workerImage: WORKER_IMAGE },
    );

    // bundleRefs.pipeline must be present in AGORA_BUNDLE_REFS_JSON
    expect(capturedSpec.current).toBeDefined();
    const bundleRefs = JSON.parse(capturedSpec.current!.env.AGORA_BUNDLE_REFS_JSON);
    expect(bundleRefs.pipeline).toBeDefined();
    expect(bundleRefs.pipeline.uri).toBe(PINNED_PIPELINE_URI);
    expect(bundleRefs.pipeline.contentHash).toBe(PIPELINE_HASH);

    // resolved.pipelineRef must be threaded through to the in-flight dispatch
    expect(inflight.resolved.pipelineRef).toBe(PINNED_PIPELINE_URI);
  });

  it('an unpinned pipelineRef throws naming pipelineRef', async () => {
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

    const unpinnedUri = 'agora://ns/pipeline/my-pipeline'; // no contentHash segment

    await expect(
      fireWork(
        client,
        {
          subagent: 's',
          target: 'prod',
          pipelineRef: unpinnedUri,
        },
        { workerImage: WORKER_IMAGE },
      ),
    ).rejects.toThrow(/pipelineRef.*pinned/);
  });

  it('a malformed pipelineRef throws (parseAgoraUri rejects it)', async () => {
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

    const malformedUri = 'not-an-agora-uri';

    await expect(
      fireWork(
        client,
        {
          subagent: 's',
          target: 'prod',
          pipelineRef: malformedUri,
        },
        { workerImage: WORKER_IMAGE },
      ),
    ).rejects.toThrow();
  });

  it('absent pipelineRef leaves bundleRefs without a pipeline key', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { compute, capturedSpec } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });

    const inflight = await fireWork(
      client,
      {
        subagent: 's',
        target: 'prod',
        // no pipelineRef
      },
      { workerImage: WORKER_IMAGE },
    );

    // bundleRefs must NOT have a pipeline key — old workers must not be affected
    expect(capturedSpec.current).toBeDefined();
    const bundleRefs = JSON.parse(capturedSpec.current!.env.AGORA_BUNDLE_REFS_JSON);
    expect(Object.prototype.hasOwnProperty.call(bundleRefs, 'pipeline')).toBe(false);

    // resolved.pipelineRef must also be absent
    expect(inflight.resolved.pipelineRef).toBeUndefined();
  });
});
