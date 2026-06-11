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
import { IntegrityMismatchError } from '@quarry-systems/pangolin-core';

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'pangolin-local-'));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe('LocalStorageProvider', () => {
  it('idempotent put: re-registering identical content returns same hash, no dup index entry', async () => {
    const sp = new LocalStorageProvider({ rootDir });
    const payload = new TextEncoder().encode('content-A');
    const { contentHash: h1 } = await sp.put(
      'pangolin://test/capability/x',
      payload,
    );
    const { contentHash: h2 } = await sp.put(
      'pangolin://test/capability/x',
      payload,
    );
    expect(h1).toBe(h2);
    const list = await sp.list('pangolin://test/capability/x');
    expect(list).toHaveLength(1);
    expect(list[0]!.contentHash).toBe(h1);
  });

  it('changed content creates a new index entry; resolveLatest returns the newest', async () => {
    const sp = new LocalStorageProvider({ rootDir });
    const uri = 'pangolin://test/capability/y';

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
    expect(latest!.uri).toBe(`pangolin://test/capability/y/${h2}`);
  });

  it('get throws IntegrityMismatchError on tampered blob', async () => {
    const sp = new LocalStorageProvider({ rootDir });
    const uri = 'pangolin://test/capability/z';
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
    const uri = 'pangolin://test/capability/w';

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
      'pangolin://test/capability/never-registered',
    );
    expect(latest).toBeNull();
  });

  // ── resolveByHash ────────────────────────────────────────────────────
  //
  // The dispatch path uses this to round-trip the subagent's bound
  // capability set (stored as content hashes) back to `CapabilityRef[]`.
  // O(N) walk of (ns, type) is acceptable for v0.1.

  describe('resolveByHash', () => {
    it('returns null when no blobs are registered under (ns, type)', async () => {
      const sp = new LocalStorageProvider({ rootDir });
      const hit = await sp.resolveByHash({
        namespace: 'test',
        type: 'capability',
        contentHash:
          'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      });
      expect(hit).toBeNull();
    });

    it('finds the matching name when one capability is registered', async () => {
      const sp = new LocalStorageProvider({ rootDir });
      const { contentHash } = await sp.put(
        'pangolin://test/capability/alpha',
        new TextEncoder().encode('alpha-bytes'),
      );
      const hit = await sp.resolveByHash({
        namespace: 'test',
        type: 'capability',
        contentHash,
      });
      expect(hit).not.toBeNull();
      expect(hit!.name).toBe('alpha');
      expect(hit!.contentHash).toBe(contentHash);
      expect(hit!.uri).toBe(`pangolin://test/capability/alpha/${contentHash}`);
      expect(hit!.registeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('distinguishes between multiple names sharing the same (ns, type)', async () => {
      const sp = new LocalStorageProvider({ rootDir });
      const { contentHash: hA } = await sp.put(
        'pangolin://test/capability/alpha',
        new TextEncoder().encode('alpha-bytes'),
      );
      const { contentHash: hB } = await sp.put(
        'pangolin://test/capability/bravo',
        new TextEncoder().encode('bravo-bytes'),
      );
      expect(hA).not.toBe(hB);

      const hitA = await sp.resolveByHash({
        namespace: 'test',
        type: 'capability',
        contentHash: hA,
      });
      const hitB = await sp.resolveByHash({
        namespace: 'test',
        type: 'capability',
        contentHash: hB,
      });
      expect(hitA!.name).toBe('alpha');
      expect(hitB!.name).toBe('bravo');
    });

    it('does not bleed across types (capability hash not matched against subagent type)', async () => {
      const sp = new LocalStorageProvider({ rootDir });
      const { contentHash } = await sp.put(
        'pangolin://test/capability/alpha',
        new TextEncoder().encode('alpha-bytes'),
      );
      const hit = await sp.resolveByHash({
        namespace: 'test',
        type: 'subagent',
        contentHash,
      });
      expect(hit).toBeNull();
    });

    it('returns null for a hash that does not match any registered entry', async () => {
      const sp = new LocalStorageProvider({ rootDir });
      await sp.put(
        'pangolin://test/capability/alpha',
        new TextEncoder().encode('alpha-bytes'),
      );
      const hit = await sp.resolveByHash({
        namespace: 'test',
        type: 'capability',
        contentHash:
          'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      });
      expect(hit).toBeNull();
    });
  });

  // ── Dispatch-record prefix (reserved `dispatches/`) support ─────────────
  //
  // The retention layer in pangolin-client writes dispatch records to URIs
  // like `pangolin://<ns>/dispatches/<id>/record.json` via the dedicated
  // `buildDispatchRecordUri` helper. The general `parsePangolinUri` rejects
  // `type === 'dispatches'`, but the storage provider uses the permissive
  // `parseStorageUri` so these writes go through.

  describe('dispatch-record prefix', () => {
    it('put + get round-trips bytes under the reserved dispatches prefix', async () => {
      const sp = new LocalStorageProvider({ rootDir });
      const uri = 'pangolin://test/dispatches/d-123/record.json';
      const payload = new TextEncoder().encode('{"hello":"dispatch"}');
      const { contentHash } = await sp.put(uri, payload);
      expect(contentHash).toMatch(/^sha256:/);

      const retrieved = await sp.get(uri);
      expect(new TextDecoder().decode(retrieved)).toBe('{"hello":"dispatch"}');
    });

    it('put + get round-trips bytes under a nested dispatches suffix', async () => {
      const sp = new LocalStorageProvider({ rootDir });
      const uri = 'pangolin://test/dispatches/d-abc/events/0001.json';
      const payload = new TextEncoder().encode('{"event":1}');
      await sp.put(uri, payload);
      const retrieved = await sp.get(uri);
      expect(new TextDecoder().decode(retrieved)).toBe('{"event":1}');
    });

    it('get on a missing dispatch record surfaces a descriptive not-found error', async () => {
      const sp = new LocalStorageProvider({ rootDir });
      const uri = 'pangolin://test/dispatches/d-missing/record.json';
      await expect(sp.get(uri)).rejects.toThrow(/not found/i);
    });

    it('overwriting a dispatch record replaces the prior bytes (NOT content-addressed)', async () => {
      // Dispatch records live at a known URI — they are NOT content-addressed,
      // so writing twice to the same URI overwrites (unlike blob puts, which
      // would just register a new content hash alongside the first).
      const sp = new LocalStorageProvider({ rootDir });
      const uri = 'pangolin://test/dispatches/d-overwrite/record.json';
      await sp.put(uri, new TextEncoder().encode('first'));
      await sp.put(uri, new TextEncoder().encode('second'));
      const retrieved = await sp.get(uri);
      expect(new TextDecoder().decode(retrieved)).toBe('second');
    });
  });
});
