import { describe, it, expect } from 'vitest';
import { registerSubagent } from '../src/subagent-register.js';
import { PangolinClient } from '../src/client.js';
import type { StorageProvider } from '@quarry-systems/pangolin-core';

/**
 * In-memory storage stub that satisfies the StorageProvider contract well enough
 * for these tests: blob bytes are keyed by pinned URI; resolveLatest walks the
 * registry sorted by registration time so the newest write wins.
 */
function makeMemoryStorage(): StorageProvider & {
  blobs: Map<string, Uint8Array>;
  registry: Map<string, Array<{ contentHash: string; registeredAt: string; pinnedUri: string }>>;
} {
  const blobs = new Map<string, Uint8Array>();
  const registry = new Map<
    string,
    Array<{ contentHash: string; registeredAt: string; pinnedUri: string }>
  >();
  let monotonic = 0;
  return {
    name: 'memory',
    blobs,
    registry,
    async put(uri: string, contents: Uint8Array) {
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

describe('registerSubagent', () => {
  it('rejects subagents with neither systemPrompt nor promptTemplate', async () => {
    const client = makeClient(makeMemoryStorage());
    await expect(registerSubagent(client, { name: 'broken' })).rejects.toThrow(
      /systemPrompt or promptTemplate/,
    );
  });

  it('returns a SubagentHandle with name, registeredAt, contentHash, and assign()', async () => {
    const client = makeClient(makeMemoryStorage());
    const handle = await registerSubagent(client, {
      name: 'reviewer',
      systemPrompt: 'review carefully',
    });
    expect(handle.name).toBe('reviewer');
    expect(typeof handle.registeredAt).toBe('string');
    expect(handle.contentHash).toMatch(/^sha256:[0-9a-f]+$/);
    expect(typeof handle.assign).toBe('function');
  });

  it('carries a verify command through into the stored subagent definition', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage);
    const handle = await registerSubagent(client, {
      name: 'editor',
      systemPrompt: 'edit',
      verify: { command: 'dotnet test', timeout: 300 },
    });
    const pinnedUri = `pangolin://ns/subagent/editor/${handle.contentHash}`;
    const def = JSON.parse(new TextDecoder().decode(await storage.get(pinnedUri)));
    expect(def.verify).toEqual({ command: 'dotnet test', timeout: 300 });
  });

  it('omits verify from the stored def when not provided (hash-stable for existing subagents)', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage);
    const handle = await registerSubagent(client, {
      name: 'editor',
      systemPrompt: 'edit',
    });
    const pinnedUri = `pangolin://ns/subagent/editor/${handle.contentHash}`;
    const def = JSON.parse(new TextDecoder().decode(await storage.get(pinnedUri)));
    expect('verify' in def).toBe(false);
  });

  it('writes the subagent definition to storage at the pinned URI', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage);
    const handle = await registerSubagent(client, {
      name: 'reviewer',
      systemPrompt: 'review carefully',
    });
    const pinnedUri = `pangolin://ns/subagent/reviewer/${handle.contentHash}`;
    expect(storage.blobs.has(pinnedUri)).toBe(true);
  });

  it('is idempotent: identical inputs reuse the existing registeredAt and skip a duplicate put', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage);
    const first = await registerSubagent(client, {
      name: 'reviewer',
      systemPrompt: 'review carefully',
    });
    const blobCountAfterFirst = storage.blobs.size;
    const second = await registerSubagent(client, {
      name: 'reviewer',
      systemPrompt: 'review carefully',
    });
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.registeredAt).toBe(first.registeredAt);
    expect(storage.blobs.size).toBe(blobCountAfterFirst);
  });

  it('throws when a short-name capability ref cannot be resolved', async () => {
    const client = makeClient(makeMemoryStorage());
    await expect(
      registerSubagent(client, {
        name: 'reviewer',
        systemPrompt: 'hi',
        capabilities: ['missing-cap'],
      }),
    ).rejects.toThrow(/capability not found: missing-cap/);
  });

  it('resolves short-name capability refs against storage.resolveLatest', async () => {
    const storage = makeMemoryStorage();
    // Pre-register a "capability" so resolveLatest can find it
    await storage.put('pangolin://ns/capability/web-search/sha256:capabilityhash', new TextEncoder().encode('{}'));
    const client = makeClient(storage);
    const handle = await registerSubagent(client, {
      name: 'reviewer',
      systemPrompt: 'hi',
      capabilities: ['web-search'],
    });
    expect(handle.contentHash).toMatch(/^sha256:[0-9a-f]+$/);
  });

  it('content hash depends on the resolved capability hashes', async () => {
    const storage = makeMemoryStorage();
    await storage.put('pangolin://ns/capability/cap-a/sha256:caphasha', new TextEncoder().encode('{}'));
    await storage.put('pangolin://ns/capability/cap-b/sha256:caphashb', new TextEncoder().encode('{}'));
    const client = makeClient(storage);
    const handleA = await registerSubagent(client, {
      name: 'reviewer',
      systemPrompt: 'hi',
      capabilities: ['cap-a'],
    });
    const handleB = await registerSubagent(client, {
      name: 'reviewer',
      systemPrompt: 'hi',
      capabilities: ['cap-b'],
    });
    expect(handleA.contentHash).not.toBe(handleB.contentHash);
  });

  it('assign() creates a new version with a different content hash; both versions remain in storage', async () => {
    const storage = makeMemoryStorage();
    await storage.put('pangolin://ns/capability/cap-a/sha256:caphasha', new TextEncoder().encode('{}'));
    await storage.put('pangolin://ns/capability/cap-b/sha256:caphashb', new TextEncoder().encode('{}'));
    const client = makeClient(storage);
    const original = await registerSubagent(client, {
      name: 'reviewer',
      systemPrompt: 'hi',
      capabilities: ['cap-a'],
    });
    const evolved = await original.assign(['cap-b']);
    expect(evolved.contentHash).not.toBe(original.contentHash);
    const originalPinned = `pangolin://ns/subagent/reviewer/${original.contentHash}`;
    const evolvedPinned = `pangolin://ns/subagent/reviewer/${evolved.contentHash}`;
    expect(storage.blobs.has(originalPinned)).toBe(true);
    expect(storage.blobs.has(evolvedPinned)).toBe(true);
  });

  it('accepts a fully-realized CapabilityRef without round-tripping through resolveLatest', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage);
    // Note: no capability registered in storage; we pass a pre-resolved ref instead.
    const handle = await registerSubagent(client, {
      name: 'reviewer',
      systemPrompt: 'hi',
      capabilities: [{ name: 'preresolved', registeredAt: '2026-01-01T00:00:00.000Z', contentHash: 'sha256:abc' }],
    });
    expect(handle.contentHash).toMatch(/^sha256:[0-9a-f]+$/);
  });

  it('throws if resolveLatest returns null immediately after a successful put (inconsistent storage)', async () => {
    // Storage that "succeeds" on put but never indexes the result — simulates
    // a buggy provider where the registry update path is broken.
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
      registerSubagent(client, { name: 'reviewer', systemPrompt: 'hi' }),
    ).rejects.toThrow(/resolveLatest returned null immediately after put/);
  });

  it('persists model into the stored canonical def', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage);
    const handle = await registerSubagent(client, {
      name: 'analyst',
      systemPrompt: 'analyze carefully',
      model: 'max',
    });
    const pinnedUri = `pangolin://ns/subagent/analyst/${handle.contentHash}`;
    const def = JSON.parse(new TextDecoder().decode(await storage.get(pinnedUri)));
    expect(def.model).toBe('max');
  });

  it('stores null for model when not provided', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage);
    const handle = await registerSubagent(client, {
      name: 'analyst',
      systemPrompt: 'analyze carefully',
    });
    const pinnedUri = `pangolin://ns/subagent/analyst/${handle.contentHash}`;
    const def = JSON.parse(new TextDecoder().decode(await storage.get(pinnedUri)));
    expect(def.model).toBe(null);
  });

  it('content hash differs between model and no-model registrations', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage);
    const withModel = await registerSubagent(client, {
      name: 'analyst',
      systemPrompt: 'analyze',
      model: 'max',
    });
    const withoutModel = await registerSubagent(client, {
      name: 'analyst',
      systemPrompt: 'analyze',
    });
    expect(withModel.contentHash).not.toBe(withoutModel.contentHash);
  });
});
