import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgoraClient } from '../src/index.js'; // barrel import installs the prototype getters
import type {
  ComputeProvider,
  CredentialProvider,
  StorageProvider,
  TaskExit,
} from '@quarry-systems/agora-core';
import * as secretsManager from '../src/secrets-manager.js';

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
  vi.spyOn(secretsManager.InlineSecretStager.prototype, 'stage').mockImplementation(
    async ({ dispatchId, envName }) => ({
      arn: `arn:aws:secretsmanager:us-east-1:000000000000:secret:${dispatchId}/${envName}-AbCdEf`,
      ttlSeconds: 7500,
    }),
  );
  vi.spyOn(secretsManager.InlineSecretStager.prototype, 'cleanup').mockResolvedValue(undefined);
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

    const client = new AgoraClient({
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
    const client = new AgoraClient({
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
