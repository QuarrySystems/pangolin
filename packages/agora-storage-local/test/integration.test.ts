// Integration tests for `LocalStorageProvider` against a real filesystem.
//
// Each test gets its own `mkdtemp` directory under the OS tmpdir and tears it
// down in `afterEach`, so the suite has zero shared state between cases.
// Anchors the storage contract that downstream packages will rely on.

import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalStorageProvider } from '../src/index.js';
import { IntegrityMismatchError } from '@quarry-systems/agora-core';

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'agora-local-'));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe('LocalStorageProvider', () => {
  it('idempotent put: re-registering identical content returns same hash, no dup index entry', async () => {
    const sp = new LocalStorageProvider({ rootDir });
    const payload = new TextEncoder().encode('content-A');
    const { contentHash: h1 } = await sp.put(
      'agora://test/capability/x',
      payload,
    );
    const { contentHash: h2 } = await sp.put(
      'agora://test/capability/x',
      payload,
    );
    expect(h1).toBe(h2);
    const list = await sp.list('agora://test/capability/x');
    expect(list).toHaveLength(1);
    expect(list[0]!.contentHash).toBe(h1);
  });

  it('changed content creates a new index entry; resolveLatest returns the newest', async () => {
    const sp = new LocalStorageProvider({ rootDir });
    const uri = 'agora://test/capability/y';

    const payloadV1 = new TextEncoder().encode('version-1');
    const { contentHash: h1 } = await sp.put(uri, payloadV1);

    // Force a measurable timestamp gap so `registeredAt` strictly orders.
    // ISO timestamps have millisecond resolution; sleep 10ms to be safe.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const payloadV2 = new TextEncoder().encode('version-2');
    const { contentHash: h2 } = await sp.put(uri, payloadV2);

    expect(h1).not.toBe(h2);

    const list = await sp.list(uri);
    expect(list).toHaveLength(2);

    const latest = await sp.resolveLatest(uri);
    expect(latest).not.toBeNull();
    expect(latest!.contentHash).toBe(h2);
    expect(latest!.uri).toBe(`agora://test/capability/y/${h2}`);
  });

  it('get throws IntegrityMismatchError on tampered blob', async () => {
    const sp = new LocalStorageProvider({ rootDir });
    const uri = 'agora://test/capability/z';
    const payload = new TextEncoder().encode('honest-content');
    const { contentHash } = await sp.put(uri, payload);

    // The on-disk filename uses an underscore separator (sha256_<hex>.blob)
    // because ":" is not a legal filename character on Windows.
    const safeHash = contentHash.replace(':', '_');
    const blobPath = join(
      rootDir,
      'test',
      'capability',
      'z',
      `${safeHash}.blob`,
    );

    // Sanity-check the path: reading the original payload should still match.
    const original = await readFile(blobPath);
    expect(new TextDecoder().decode(original)).toBe('honest-content');

    // Tamper: overwrite blob with different bytes while keeping the same
    // filename (so the URI still resolves to a file, but content has drifted).
    await writeFile(blobPath, new TextEncoder().encode('tampered-content'));

    const pinnedUri = `${uri}/${contentHash}`;
    await expect(sp.get(pinnedUri)).rejects.toThrow(IntegrityMismatchError);
  });

  it('list returns entries ordered by registeredAt descending', async () => {
    const sp = new LocalStorageProvider({ rootDir });
    const uri = 'agora://test/capability/w';

    const { contentHash: hA } = await sp.put(
      uri,
      new TextEncoder().encode('alpha'),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const { contentHash: hB } = await sp.put(
      uri,
      new TextEncoder().encode('bravo'),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const { contentHash: hC } = await sp.put(
      uri,
      new TextEncoder().encode('charlie'),
    );

    const list = await sp.list(uri);
    expect(list).toHaveLength(3);
    // Newest first.
    expect(list.map((e) => e.contentHash)).toEqual([hC, hB, hA]);

    // And the registeredAt timestamps are monotonically non-increasing.
    for (let i = 1; i < list.length; i++) {
      expect(
        list[i - 1]!.registeredAt >= list[i]!.registeredAt,
      ).toBe(true);
    }
  });

  it('resolveLatest returns null for unknown name', async () => {
    const sp = new LocalStorageProvider({ rootDir });
    const latest = await sp.resolveLatest(
      'agora://test/capability/never-registered',
    );
    expect(latest).toBeNull();
  });
});
