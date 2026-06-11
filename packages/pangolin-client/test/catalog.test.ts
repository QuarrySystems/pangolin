import { describe, it, expect } from 'vitest';
import {
  getCapability,
  getSubagent,
  getEnv,
  listCapabilities,
  listSubagents,
  listEnvs,
} from '../src/catalog.js';
import { PangolinClient } from '../src/client.js';
import type { StorageProvider } from '@quarry-systems/pangolin-core';

/**
 * In-memory storage stub: blob bytes keyed by pinned URI; resolveLatest
 * returns the most recent registration for a logical (namespace,type,name).
 */
function makeMemoryStorage(): StorageProvider & {
  registry: Map<
    string,
    Array<{ contentHash: string; registeredAt: string; pinnedUri: string }>
  >;
} {
  const registry = new Map<
    string,
    Array<{ contentHash: string; registeredAt: string; pinnedUri: string }>
  >();
  let monotonic = 0;
  return {
    name: 'memory',
    registry,
    async put(uri: string, _contents: Uint8Array) {
      const parts = uri.split('/');
      const contentHash = parts[parts.length - 1]!;
      const baseUri = parts.slice(0, -1).join('/');
      const list = registry.get(baseUri) ?? [];
      monotonic += 1;
      const registeredAt = new Date(1_700_000_000_000 + monotonic).toISOString();
      list.push({ contentHash, registeredAt, pinnedUri: uri });
      registry.set(baseUri, list);
      return { contentHash };
    },
    async get(_uri: string) {
      throw new Error('memory storage: get not used in catalog tests');
    },
    async resolveLatest(uri: string) {
      const list = registry.get(uri);
      if (!list || list.length === 0) return null;
      const latest = list[list.length - 1]!;
      return {
        uri: latest.pinnedUri,
        contentHash: latest.contentHash,
        registeredAt: latest.registeredAt,
      };
    },
    async list(uri: string) {
      const list = registry.get(uri) ?? [];
      return list.map((e) => ({
        uri: e.pinnedUri,
        contentHash: e.contentHash,
        registeredAt: e.registeredAt,
      }));
    },
  };
}

function makeClient(storage: StorageProvider): PangolinClient {
  return new PangolinClient({
    namespace: 'org',
    compute: {},
    credentials: {},
    storage,
    targets: {},
  });
}

/**
 * Register a synthetic entry under the storage stub by writing directly to
 * the registry so the catalog tests don't depend on the (separate) register
 * code paths landing first.
 */
function seed(
  storage: ReturnType<typeof makeMemoryStorage>,
  namespace: string,
  type: string,
  name: string,
  contentHash: string,
  registeredAt: string,
): void {
  const baseUri = `pangolin://${namespace}/${type}/${name}`;
  const pinnedUri = `${baseUri}/${contentHash}`;
  const list = storage.registry.get(baseUri) ?? [];
  list.push({ contentHash, registeredAt, pinnedUri });
  storage.registry.set(baseUri, list);
}

describe('catalog get*', () => {
  it('getCapability returns null when the name is not registered', async () => {
    const client = makeClient(makeMemoryStorage());
    expect(await getCapability(client, 'missing')).toBeNull();
  });

  it('getSubagent returns null when the name is not registered', async () => {
    const client = makeClient(makeMemoryStorage());
    expect(await getSubagent(client, 'missing')).toBeNull();
  });

  it('getEnv returns null when the name is not registered', async () => {
    const client = makeClient(makeMemoryStorage());
    expect(await getEnv(client, 'missing')).toBeNull();
  });

  it('getCapability returns the metadata triple for a registered capability', async () => {
    const storage = makeMemoryStorage();
    seed(storage, 'org', 'capability', 'lint', 'sha256:aaa', '2026-01-01T00:00:00.000Z');
    const ref = await getCapability(makeClient(storage), 'lint');
    expect(ref).toEqual({
      name: 'lint',
      registeredAt: '2026-01-01T00:00:00.000Z',
      contentHash: 'sha256:aaa',
    });
  });

  it('getSubagent returns the metadata triple for a registered subagent', async () => {
    const storage = makeMemoryStorage();
    seed(storage, 'org', 'subagent', 'reviewer', 'sha256:bbb', '2026-02-02T00:00:00.000Z');
    const ref = await getSubagent(makeClient(storage), 'reviewer');
    expect(ref).toEqual({
      name: 'reviewer',
      registeredAt: '2026-02-02T00:00:00.000Z',
      contentHash: 'sha256:bbb',
    });
  });

  it('getEnv returns the metadata triple for a registered env', async () => {
    const storage = makeMemoryStorage();
    seed(storage, 'org', 'env', 'prod', 'sha256:ccc', '2026-03-03T00:00:00.000Z');
    const ref = await getEnv(makeClient(storage), 'prod');
    expect(ref).toEqual({
      name: 'prod',
      registeredAt: '2026-03-03T00:00:00.000Z',
      contentHash: 'sha256:ccc',
    });
  });

  it('getCapability returns the latest registration when multiple versions exist', async () => {
    const storage = makeMemoryStorage();
    seed(storage, 'org', 'capability', 'lint', 'sha256:old', '2026-01-01T00:00:00.000Z');
    seed(storage, 'org', 'capability', 'lint', 'sha256:new', '2026-06-01T00:00:00.000Z');
    const ref = await getCapability(makeClient(storage), 'lint');
    expect(ref?.contentHash).toBe('sha256:new');
  });

  it('get* never returns blob contents — only the metadata triple', async () => {
    const storage = makeMemoryStorage();
    seed(storage, 'org', 'subagent', 'reviewer', 'sha256:bbb', '2026-02-02T00:00:00.000Z');
    const ref = await getSubagent(makeClient(storage), 'reviewer');
    expect(Object.keys(ref ?? {}).sort()).toEqual(['contentHash', 'name', 'registeredAt']);
  });

  it('get* scopes lookups to the client namespace', async () => {
    const storage = makeMemoryStorage();
    // Same logical name exists under a different namespace; client must not see it.
    seed(storage, 'other-org', 'capability', 'lint', 'sha256:xxx', '2026-01-01T00:00:00.000Z');
    const client = makeClient(storage); // namespace: 'org'
    expect(await getCapability(client, 'lint')).toBeNull();
  });
});

describe('catalog list*', () => {
  it('listCapabilities throws not-implemented (deferred per spec)', async () => {
    const client = makeClient(makeMemoryStorage());
    await expect(listCapabilities(client)).rejects.toThrow(/not yet implemented/);
  });

  it('listSubagents throws not-implemented (deferred per spec)', async () => {
    const client = makeClient(makeMemoryStorage());
    await expect(listSubagents(client)).rejects.toThrow(/not yet implemented/);
  });

  it('listEnvs throws not-implemented (deferred per spec)', async () => {
    const client = makeClient(makeMemoryStorage());
    await expect(listEnvs(client)).rejects.toThrow(/not yet implemented/);
  });
});
