import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PangolinClient, fireWork } from '../src/index.js'; // barrel import installs the prototype getters
import { DispatchAlreadyExistsError } from '../src/errors.js';
import type {
  ComputeProvider,
  CredentialProvider,
  StorageProvider,
  TaskExit,
  SecretStore,
} from '@quarry-systems/pangolin-core';
import { buildDispatchRecordUri, StorageNotFoundError } from '@quarry-systems/pangolin-core';

/**
 * In-memory storage stub. Mirrors the helper in dispatch-fire.test.ts, plus
 * records every `put`/`get` call (with the caller-supplied URI) into a shared
 * `callOrder` array so ordering can be asserted across storage AND the
 * SecretStore below.
 */
function makeMemoryStorage(callOrder: string[]): StorageProvider & {
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
      callOrder.push(`storage.put:${uri}`);
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
      callOrder.push(`storage.get:${uri}`);
      const v = blobs.get(uri);
      // `StorageProvider.get` MUST signal absence with StorageNotFoundError
      // (pangolin-core/src/storage.ts) — a plain Error here made this double
      // claim a contract it did not honour, and `markerPresent` now depends on
      // the distinction to tell "absent" from "could not look".
      if (!v) throw new StorageNotFoundError(uri, `memory storage: not found: ${uri}`);
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
  } as StorageProvider & {
    blobs: Map<string, Uint8Array>;
    seed(
      name: string,
      type: string,
      namespace: string,
      contentHash: string,
      payload: unknown,
    ): void;
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
 * to `stage` for assertion; `callOrder` (shared with the storage stub above)
 * records `store.stage:<name>` so cross-object call ordering can be verified.
 */
function makeStore(
  callOrder: string[],
  opts: { name?: string; dir?: string } = {},
): {
  store: SecretStore;
  staged: Array<{ name: string; value: string; ttlSeconds: number }>;
} {
  const staged: Array<{ name: string; value: string; ttlSeconds: number }> = [];
  const store: SecretStore = {
    name: opts.name ?? 'test-store',
    dir: opts.dir,
    async stage(args) {
      callOrder.push(`store.stage:${args.name}`);
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

function makeCompute(runImpl?: (spec: unknown) => void): {
  compute: ComputeProvider;
  runMock: ReturnType<typeof vi.fn>;
} {
  const runMock = vi.fn(async (spec: unknown, _ctx: unknown) => {
    runImpl?.(spec);
    return { providerTaskId: 'prov-dedupe-test' };
  });
  const compute: ComputeProvider = {
    name: 'fake-compute',
    run: runMock as unknown as ComputeProvider['run'],
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
  return { compute, runMock };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('fireWork dedupeOnDispatchId', () => {
  it('throws DispatchAlreadyExistsError on a second fire of the same id, and does not re-run compute', async () => {
    const callOrder: string[] = [];
    const storage = makeMemoryStorage(callOrder);
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { compute, runMock } = makeCompute();

    const client = new PangolinClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });

    const opts = { workerImage: 'img' };
    const work = { subagent: 's', target: 'prod' };

    await fireWork(client, { ...work, dedupeOnDispatchId: true, dispatchId: 'D1' }, opts);
    await expect(
      fireWork(client, { ...work, dedupeOnDispatchId: true, dispatchId: 'D1' }, opts),
    ).rejects.toBeInstanceOf(DispatchAlreadyExistsError);

    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it('rejection carries the dispatchId', async () => {
    const callOrder: string[] = [];
    const storage = makeMemoryStorage(callOrder);
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { compute } = makeCompute();

    const client = new PangolinClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });

    const opts = { workerImage: 'img' };
    const work = { subagent: 's', target: 'prod' };

    await fireWork(client, { ...work, dedupeOnDispatchId: true, dispatchId: 'D1' }, opts);
    try {
      await fireWork(client, { ...work, dedupeOnDispatchId: true, dispatchId: 'D1' }, opts);
      expect.fail('expected fireWork to throw DispatchAlreadyExistsError');
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchAlreadyExistsError);
      expect((err as DispatchAlreadyExistsError).dispatchId).toBe('D1');
    }
  });

  it('orders the fired.json marker put BEFORE per-dispatch secret staging and the callback HMAC mint', async () => {
    const callOrder: string[] = [];
    const storage = makeMemoryStorage(callOrder);
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { compute } = makeCompute();
    const { store } = makeStore(callOrder, { name: 'test-store' });

    const client = new PangolinClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default', secretStore: 's' } },
      secretStores: { s: store },
    });

    const markerUri = buildDispatchRecordUri('ns', 'D2', 'fired.json');

    await fireWork(
      client,
      {
        subagent: 's',
        target: 'prod',
        dedupeOnDispatchId: true,
        dispatchId: 'D2',
        secrets: { MY_KEY: { inline: 'super-secret-value' } },
        callback: { url: 'https://example.com/callback' },
      },
      { workerImage: 'img' },
    );

    const markerPutIdx = callOrder.indexOf(`storage.put:${markerUri}`);
    const secretStageIdx = callOrder.indexOf('store.stage:D2/MY_KEY');
    const callbackStageIdx = callOrder.findIndex((c) =>
      c.startsWith('store.stage:pangolin/callback-hmac/D2'),
    );

    expect(markerPutIdx).toBeGreaterThanOrEqual(0);
    expect(secretStageIdx).toBeGreaterThanOrEqual(0);
    expect(callbackStageIdx).toBeGreaterThanOrEqual(0);
    expect(markerPutIdx).toBeLessThan(secretStageIdx);
    expect(markerPutIdx).toBeLessThan(callbackStageIdx);
  });

  it('with dedupeOnDispatchId absent, no marker put/get occurs, and a repeated id fires twice', async () => {
    const callOrder: string[] = [];
    const storage = makeMemoryStorage(callOrder);
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { compute, runMock } = makeCompute();

    const client = new PangolinClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });

    const opts = { workerImage: 'img' };
    const work = { subagent: 's', target: 'prod', dispatchId: 'D3' };

    await fireWork(client, work, opts);
    await fireWork(client, work, opts);

    expect(runMock).toHaveBeenCalledTimes(2);
    const markerUri = buildDispatchRecordUri('ns', 'D3', 'fired.json');
    expect(callOrder.some((c) => c.includes(markerUri))).toBe(false);
  });

  it('the marker body deep-equals { dispatchId, firedAt, traceId } — no secret, no url', async () => {
    const callOrder: string[] = [];
    const storage = makeMemoryStorage(callOrder);
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { compute } = makeCompute();

    const client = new PangolinClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });

    await fireWork(
      client,
      { subagent: 's', target: 'prod', dedupeOnDispatchId: true, dispatchId: 'D4' },
      { workerImage: 'img' },
    );

    const markerUri = buildDispatchRecordUri('ns', 'D4', 'fired.json');
    const raw = storage.blobs.get(markerUri);
    expect(raw).toBeDefined();
    const body = JSON.parse(new TextDecoder().decode(raw));
    expect(Object.keys(body).sort()).toEqual(['dispatchId', 'firedAt', 'traceId']);
    expect(body.dispatchId).toBe('D4');
    expect(body.traceId).toBe('D4'); // default trace is { traceId: dispatchId }
    expect(typeof body.firedAt).toBe('string');
    expect(new Date(body.firedAt).toISOString()).toBe(body.firedAt);
  });

  /**
   * The guard's failure mode is that it stops guarding *silently*. A bare
   * `catch` cannot tell "the marker is absent" — the answer it wants — from
   * "I am not authorised to look", so a mis-scoped storage policy turns
   * `dedupeOnDispatchId: true` into a permanent no-op with no error and no
   * warning. Reproduced against real MinIO before these were written: an
   * identity with `s3:PutObject` but no `s3:GetObject` gets 403 AccessDenied
   * on a marker that demonstrably exists, and the guard reports "not fired".
   *
   * Only `StorageNotFoundError` means absent. `StorageProvider.get` is
   * contractually required to throw it (`pangolin-core/src/storage.ts`), and
   * `readDispatchRecord` already relies on exactly that for the same
   * `dispatches/<id>/` prefix — these pin the same posture for the guard.
   */
  describe('a non-not-found storage error must not read as "not fired"', () => {
    /** Storage whose `get` always fails with `err`; `put` succeeds and records. */
    function makeFailingGetStorage(err: unknown, callOrder: string[]): StorageProvider {
      const blobs = new Map<string, Uint8Array>();
      return {
        name: 'failing-get',
        async put(uri: string, contents: Uint8Array) {
          callOrder.push(`storage.put:${uri}`);
          blobs.set(uri, contents);
          return { contentHash: 'sha256:x' };
        },
        async get(uri: string) {
          callOrder.push(`storage.get:${uri}`);
          throw err;
        },
        async resolveLatest() {
          return {
            uri: 'pangolin://ns/subagent/s/sha256:s',
            contentHash: 'sha256:s',
            registeredAt: new Date(0).toISOString(),
          };
        },
        async list() {
          return [];
        },
      } as StorageProvider;
    }

    function makeClientWith(storage: StorageProvider, compute: ComputeProvider): PangolinClient {
      return new PangolinClient({
        namespace: 'ns',
        compute: { default: compute },
        credentials: { default: makeCredentials() },
        storage,
        targets: { prod: { compute: 'default', credentials: 'default' } },
      });
    }

    it('rethrows an authorization failure instead of firing (the mis-scoped-policy case)', async () => {
      const callOrder: string[] = [];
      const denied = Object.assign(new Error('Access Denied'), {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      });
      const storage = makeFailingGetStorage(denied, callOrder);
      const { compute, runMock } = makeCompute();
      const client = makeClientWith(storage, compute);

      await expect(
        fireWork(
          client,
          { subagent: 's', target: 'prod', dedupeOnDispatchId: true, dispatchId: 'D6' },
          { workerImage: 'img' },
        ),
      ).rejects.toThrow(/Access Denied/);

      // The whole point: no container, and no marker overwriting a live one.
      expect(runMock).not.toHaveBeenCalled();
      expect(callOrder.some((c) => c.startsWith('storage.put:'))).toBe(false);
    });

    it('rethrows a transient network failure instead of firing', async () => {
      const callOrder: string[] = [];
      const storage = makeFailingGetStorage(
        Object.assign(new Error('socket hang up'), { name: 'TimeoutError' }),
        callOrder,
      );
      const { compute, runMock } = makeCompute();
      const client = makeClientWith(storage, compute);

      await expect(
        fireWork(
          client,
          { subagent: 's', target: 'prod', dedupeOnDispatchId: true, dispatchId: 'D7' },
          { workerImage: 'img' },
        ),
      ).rejects.toThrow(/socket hang up/);
      expect(runMock).not.toHaveBeenCalled();
    });

    it('rethrows a generic /not found/i message rather than reading it as absent', async () => {
      // Mirrors retention.test.ts: the check is type-based, not a string sniff,
      // so a DNS error that merely says "not found" must not disarm the guard.
      const callOrder: string[] = [];
      const storage = makeFailingGetStorage(new Error('endpoint not found (DNS)'), callOrder);
      const { compute, runMock } = makeCompute();
      const client = makeClientWith(storage, compute);

      await expect(
        fireWork(
          client,
          { subagent: 's', target: 'prod', dedupeOnDispatchId: true, dispatchId: 'D8' },
          { workerImage: 'img' },
        ),
      ).rejects.toThrow(/endpoint not found/);
      expect(runMock).not.toHaveBeenCalled();
    });

    it('still treats StorageNotFoundError as absent, so a genuine first fire proceeds', async () => {
      const callOrder: string[] = [];
      const storage = makeFailingGetStorage(
        new StorageNotFoundError('pangolin://ns/dispatches/D9/fired.json'),
        callOrder,
      );
      const { compute, runMock } = makeCompute();
      const client = makeClientWith(storage, compute);

      await fireWork(
        client,
        { subagent: 's', target: 'prod', dedupeOnDispatchId: true, dispatchId: 'D9' },
        { workerImage: 'img' },
      );

      expect(runMock).toHaveBeenCalledTimes(1);
      const markerUri = buildDispatchRecordUri('ns', 'D9', 'fired.json');
      expect(callOrder).toContain(`storage.put:${markerUri}`);
    });

    it('treats a duck-typed StorageNotFoundError as absent (duplicate package copies)', async () => {
      // `isStorageNotFound`'s name check is the load-bearing leg — a provider
      // resolved from a second copy of pangolin-core fails `instanceof`.
      const callOrder: string[] = [];
      const storage = makeFailingGetStorage(
        Object.assign(new Error('storage object not found'), { name: 'StorageNotFoundError' }),
        callOrder,
      );
      const { compute, runMock } = makeCompute();
      const client = makeClientWith(storage, compute);

      await fireWork(
        client,
        { subagent: 's', target: 'prod', dedupeOnDispatchId: true, dispatchId: 'D10' },
        { workerImage: 'img' },
      );
      expect(runMock).toHaveBeenCalledTimes(1);
    });
  });

  it('the marker URI is built with buildDispatchRecordUri', async () => {
    const callOrder: string[] = [];
    const storage = makeMemoryStorage(callOrder);
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { compute } = makeCompute();

    const client = new PangolinClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });

    await fireWork(
      client,
      { subagent: 's', target: 'prod', dedupeOnDispatchId: true, dispatchId: 'D5' },
      { workerImage: 'img' },
    );

    const expectedUri = buildDispatchRecordUri('ns', 'D5', 'fired.json');
    expect(storage.blobs.has(expectedUri)).toBe(true);
  });
});
