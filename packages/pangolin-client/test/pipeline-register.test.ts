import { describe, it, expect } from 'vitest';
import { registerPipeline } from '../src/pipeline-register.js';
import { PangolinClient } from '../src/client.js';
import type { StorageProvider, PipelineSpec } from '@quarry-systems/pangolin-core';

/**
 * In-memory storage stub that satisfies the StorageProvider contract well enough
 * for these tests: blob bytes are keyed by pinned URI; resolveLatest walks the
 * registry sorted by registration time so the newest write wins.
 */
function makeMemoryStorage(): StorageProvider & {
  blobs: Map<string, Uint8Array>;
  registry: Map<string, Array<{ contentHash: string; registeredAt: string; pinnedUri: string }>>;
  putCount: number;
} {
  const blobs = new Map<string, Uint8Array>();
  const registry = new Map<
    string,
    Array<{ contentHash: string; registeredAt: string; pinnedUri: string }>
  >();
  let monotonic = 0;
  let putCount = 0;
  return {
    name: 'memory',
    blobs,
    registry,
    get putCount() {
      return putCount;
    },
    async put(uri: string, contents: Uint8Array) {
      putCount++;
      // Pinned uri shape: pangolin://ns/type/name/<contentHash>
      const parts = uri.split('/');
      const contentHash = parts[parts.length - 1];
      const baseUri = parts.slice(0, -1).join('/');
      blobs.set(uri, contents);
      const list = registry.get(baseUri) ?? [];
      // give each registration a distinct, monotonic timestamp so that
      // resolveLatest order is stable in tests
      monotonic += 1;
      const registeredAt = new Date(1_700_000_000_000 + monotonic).toISOString();
      list.push({ contentHash, registeredAt, pinnedUri: uri });
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
      const latest = list[list.length - 1];
      return { uri: latest.pinnedUri, contentHash: latest.contentHash, registeredAt: latest.registeredAt };
    },
    async list(uri: string) {
      const list = registry.get(uri) ?? [];
      return list.map((e) => ({ uri: e.pinnedUri, contentHash: e.contentHash, registeredAt: e.registeredAt }));
    },
  };
}

function makeClient(storage: StorageProvider): PangolinClient {
  return new PangolinClient({
    namespace: 'ns',
    compute: {},
    credentials: {},
    storage,
    targets: {},
  });
}

const validSpec: PipelineSpec = {
  schemaVersion: 1,
  id: 'data.transform',
  blocks: [{ kind: 'agent' }],
};

describe('registerPipeline', () => {
  it('rejects an invalid spec and surfaces all validator errors', async () => {
    const client = makeClient(makeMemoryStorage());
    const badSpec = {
      schemaVersion: 1,
      id: 'bad-id-no-dot',
      blocks: [],
    } as unknown as PipelineSpec;
    await expect(registerPipeline(client, badSpec)).rejects.toThrow(
      /pipeline.register: invalid spec/,
    );
  });

  it('returns a PipelineRef with id, registeredAt, and contentHash', async () => {
    const client = makeClient(makeMemoryStorage());
    const ref = await registerPipeline(client, validSpec);
    expect(ref.id).toBe('data.transform');
    expect(typeof ref.registeredAt).toBe('string');
    expect(ref.contentHash).toMatch(/^sha256:[0-9a-f]+$/);
  });

  it('writes the pipeline definition to storage at the pinned URI', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage);
    const ref = await registerPipeline(client, validSpec);
    const pinnedUri = `pangolin://ns/pipeline/data.transform/${ref.contentHash}`;
    expect(storage.blobs.has(pinnedUri)).toBe(true);
  });

  it('pinned URI content is valid canonical JSON matching the spec', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage);
    const ref = await registerPipeline(client, validSpec);
    const pinnedUri = `pangolin://ns/pipeline/data.transform/${ref.contentHash}`;
    const bytes = await storage.get(pinnedUri);
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    expect(parsed.id).toBe('data.transform');
    expect(parsed.schemaVersion).toBe(1);
  });

  it('is idempotent: re-registering an identical spec returns same registeredAt, no second put', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage);
    const first = await registerPipeline(client, validSpec);
    const putCountAfterFirst = storage.putCount;
    const second = await registerPipeline(client, validSpec);
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.registeredAt).toBe(first.registeredAt);
    expect(storage.putCount).toBe(putCountAfterFirst);
  });

  it('different spec same id produces a NEW pinned version; both are retrievable', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage);
    const specV1: PipelineSpec = {
      schemaVersion: 1,
      id: 'data.transform',
      blocks: [{ kind: 'agent' }],
    };
    const specV2: PipelineSpec = {
      schemaVersion: 1,
      id: 'data.transform',
      blocks: [{ kind: 'agent' }, { kind: 'capture', what: 'outputs' }],
    };
    const refV1 = await registerPipeline(client, specV1);
    const refV2 = await registerPipeline(client, specV2);
    expect(refV1.contentHash).not.toBe(refV2.contentHash);
    const pinnedV1 = `pangolin://ns/pipeline/data.transform/${refV1.contentHash}`;
    const pinnedV2 = `pangolin://ns/pipeline/data.transform/${refV2.contentHash}`;
    expect(storage.blobs.has(pinnedV1)).toBe(true);
    expect(storage.blobs.has(pinnedV2)).toBe(true);
  });

  it('throws if resolveLatest returns null immediately after a successful put (inconsistent storage)', async () => {
    const brokenStorage: StorageProvider = {
      name: 'broken',
      async put(_uri: string, _contents: Uint8Array) {
        return { contentHash: 'sha256:ignored' };
      },
      async get(uri: string) {
        throw new Error(`broken storage: not found: ${uri}`);
      },
      async resolveLatest(_uri: string) {
        return null;
      },
      async list(_uri: string) {
        return [];
      },
    };
    const client = makeClient(brokenStorage);
    await expect(
      registerPipeline(client, validSpec),
    ).rejects.toThrow(/resolveLatest returned null immediately after put/);
  });

  it('client.pipeline.register is reachable via the namespace API', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage);
    // Import the barrel to ensure prototype extension is wired
    const { PangolinClient: _ } = await import('../src/index.js');
    const ref = await (client as unknown as { pipeline: { register(spec: PipelineSpec): Promise<unknown> } }).pipeline.register(validSpec);
    expect((ref as { id: string }).id).toBe('data.transform');
  });
});
