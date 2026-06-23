// Regression test for per-provider liveness-deadline (R5).
// Verifies that a hung provider's awaitExit settles as a `timeout` failure
// rather than hanging the dispatch indefinitely, and that the client's
// defaultDispatchTimeoutSeconds floor defaults to 7200.

import { describe, it, expect } from 'vitest';
import { PangolinClient } from '../src/index.js';
import type {
  ComputeProvider,
  CredentialProvider,
  DispatchResult,
  ResultSink,
  SinkContext,
  StorageProvider,
  TaskExit,
  TaskHandle,
  TaskSpec,
} from '@quarry-systems/pangolin-core';

/** Minimal ResultSink that maps providerFailureReason to failure without writing to stdout. */
function makeMinimalSink(): ResultSink {
  return {
    name: 'test-sink',
    async collect(_handle: TaskHandle, exit: TaskExit, ctx: SinkContext): Promise<DispatchResult> {
      const result: DispatchResult = {
        dispatchId: ctx.dispatchId,
        exitCode: exit.exitCode,
        stdout: exit.stdout,
        stderr: exit.stderr,
        durationMs: exit.finishedAt.getTime() - exit.startedAt.getTime(),
        resolved: ctx.resolved,
      };
      if (exit.providerFailureReason !== undefined) {
        const raw = exit.providerFailureReason;
        result.failure = {
          reason: raw === 'timeout' ? 'timeout' : 'provider-failed',
          detail: raw,
        };
      }
      return result;
    },
  };
}

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
    seed(
      name: string,
      type: string,
      namespace: string,
      contentHash: string,
      payload: unknown,
    ): void;
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

/** A compute provider whose awaitExit hangs forever — simulates a stuck provider. */
function makeHungCompute(): ComputeProvider {
  return {
    name: 'hung-compute',
    async run(_spec: TaskSpec): Promise<TaskHandle> {
      return { providerTaskId: 'hung-task-1' };
    },
    async awaitExit(_handle: TaskHandle): Promise<TaskExit> {
      // Never resolves — simulates a provider that is stuck (R5: timeout path).
      return new Promise<TaskExit>(() => {});
    },
  };
}

function makeClient(opts: { defaultDispatchTimeoutSeconds?: number } = {}) {
  const storage = makeMemoryStorage();
  storage.seed('agent-x', 'subagent', 'ns', 'sha256:agent-x', { name: 'agent-x' });

  const client = new PangolinClient({
    namespace: 'ns',
    compute: { default: makeHungCompute() },
    credentials: { default: makeCredentials() },
    storage,
    targets: { local: { compute: 'default', credentials: 'default' } },
    // Wire the minimal sink so providerFailureReason maps to failure.reason (R5).
    resultSink: makeMinimalSink(),
    ...opts,
  });
  return client;
}

describe('dispatch deadline (per-provider liveness, R5)', () => {
  it('a hung provider awaitExit settles as a timeout failure (does not hang the dispatch)', async () => {
    const client = makeClient();
    // R5: pass work.timeoutSeconds = 0.001 (1 ms) to force the deadline immediately.
    const result = await client.dispatch({
      subagent: 'agent-x',
      target: 'local',
      workerImage: 'img@sha256:' + '0'.repeat(64),
      timeoutSeconds: 0.001, // 1ms — forces the deadline
    });
    // R5: a timeout exit must propagate as failure.reason === 'timeout'
    expect(result.failure?.reason).toBe('timeout');
  });

  it('default floor is 7200 when neither work nor option override is set', () => {
    const client = makeClient();
    expect(client.defaultDispatchTimeoutSeconds).toBe(7200);
  });

  it('constructor option overrides the 7200s default floor', () => {
    const client = makeClient({ defaultDispatchTimeoutSeconds: 3600 });
    expect(client.defaultDispatchTimeoutSeconds).toBe(3600);
  });
});
