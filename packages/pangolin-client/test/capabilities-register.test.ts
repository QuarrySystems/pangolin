import { describe, it, expect } from 'vitest';
import { registerCapability } from '../src/capabilities-register.js';
import { PangolinClient } from '../src/client.js';
import { CapabilityTooLargeError, CredentialsInEnvError } from '@quarry-systems/pangolin-core';
import type { StorageProvider } from '@quarry-systems/pangolin-core';

/**
 * In-memory storage stub mirroring the pattern in subagent-register.test.ts:
 * blob bytes are keyed by the pinned URI, and resolveLatest walks the
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

describe('registerCapability', () => {
  it('returns a CapabilityRef with name, registeredAt, and contentHash', async () => {
    const client = makeClient(makeMemoryStorage());
    const ref = await registerCapability(client, {
      name: 'web-search',
      files: { 'index.js': 'export const search = () => {}\n' },
    });
    expect(ref.name).toBe('web-search');
    expect(typeof ref.registeredAt).toBe('string');
    expect(ref.contentHash).toMatch(/^sha256:[0-9a-f]+$/);
  });

  it('writes the bundle blob to storage at the pinned URI', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage);
    const ref = await registerCapability(client, {
      name: 'web-search',
      files: { 'index.js': 'export const search = () => {}\n' },
    });
    const pinnedUri = `pangolin://ns/capability/web-search/${ref.contentHash}`;
    expect(storage.blobs.has(pinnedUri)).toBe(true);
  });

  it('rejects bundles exceeding 50 MiB', async () => {
    const client = makeClient(makeMemoryStorage());
    const huge = new Uint8Array(50 * 1024 * 1024 + 1);
    await expect(
      registerCapability(client, { name: 'big', files: { 'big.bin': huge } }),
    ).rejects.toBeInstanceOf(CapabilityTooLargeError);
  });

  it('rejects file contents matching a credential pattern', async () => {
    const client = makeClient(makeMemoryStorage());
    await expect(
      registerCapability(client, {
        name: 'leaky',
        files: { 'settings.json': '{"key":"AKIAIOSFODNN7EXAMPLE"}' },
      }),
    ).rejects.toBeInstanceOf(CredentialsInEnvError);
  });

  it('credential pattern error names the offending path as capability:<name>:<path>', async () => {
    const client = makeClient(makeMemoryStorage());
    try {
      await registerCapability(client, {
        name: 'leaky',
        files: { 'settings.json': '{"key":"AKIAIOSFODNN7EXAMPLE"}' },
      });
      throw new Error('expected CredentialsInEnvError');
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialsInEnvError);
      expect((err as CredentialsInEnvError).field).toBe('capability:leaky:settings.json');
    }
  });

  it('honors allowCredentialPatterns opt-out', async () => {
    const client = makeClient(makeMemoryStorage());
    const ref = await registerCapability(client, {
      name: 'ok',
      files: { 'settings.json': '{"key":"AKIAIOSFODNN7EXAMPLE"}' },
      allowCredentialPatterns: ['aws-access-key'],
    });
    expect(ref.contentHash).toMatch(/^sha256:[0-9a-f]+$/);
  });

  it('content hash is order-independent across file paths', async () => {
    const clientA = makeClient(makeMemoryStorage());
    const clientB = makeClient(makeMemoryStorage());
    const refA = await registerCapability(clientA, {
      name: 'cap',
      files: { 'a.js': 'A', 'b.js': 'B' },
    });
    const refB = await registerCapability(clientB, {
      name: 'cap',
      files: { 'b.js': 'B', 'a.js': 'A' },
    });
    expect(refA.contentHash).toBe(refB.contentHash);
  });

  it('different file content produces a different content hash', async () => {
    const clientA = makeClient(makeMemoryStorage());
    const clientB = makeClient(makeMemoryStorage());
    const refA = await registerCapability(clientA, {
      name: 'cap',
      files: { 'a.js': 'A' },
    });
    const refB = await registerCapability(clientB, {
      name: 'cap',
      files: { 'a.js': 'B' },
    });
    expect(refA.contentHash).not.toBe(refB.contentHash);
  });

  it('is idempotent: identical re-register reuses existing registeredAt and skips a duplicate put', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage);
    const first = await registerCapability(client, {
      name: 'web-search',
      files: { 'index.js': 'export const search = () => {}\n' },
    });
    const blobCountAfterFirst = storage.blobs.size;
    const second = await registerCapability(client, {
      name: 'web-search',
      files: { 'index.js': 'export const search = () => {}\n' },
    });
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.registeredAt).toBe(first.registeredAt);
    expect(storage.blobs.size).toBe(blobCountAfterFirst);
  });

  it('changed content produces a new entry with a new contentHash and a new pinned write', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage);
    const first = await registerCapability(client, {
      name: 'web-search',
      files: { 'index.js': 'old' },
    });
    const second = await registerCapability(client, {
      name: 'web-search',
      files: { 'index.js': 'new' },
    });
    expect(second.contentHash).not.toBe(first.contentHash);
    expect(storage.blobs.has(`pangolin://ns/capability/web-search/${first.contentHash}`)).toBe(true);
    expect(storage.blobs.has(`pangolin://ns/capability/web-search/${second.contentHash}`)).toBe(true);
  });

  it('accepts Uint8Array file contents without scanning them for credential patterns', async () => {
    const client = makeClient(makeMemoryStorage());
    // The byte sequence below contains an AWS access-key pattern, but as raw
    // bytes we do not scan it (the pattern scanner is text-only by contract).
    const bytes = new TextEncoder().encode('AKIAIOSFODNN7EXAMPLE');
    const ref = await registerCapability(client, {
      name: 'binary',
      files: { 'blob.bin': bytes },
    });
    expect(ref.contentHash).toMatch(/^sha256:[0-9a-f]+$/);
  });
});
