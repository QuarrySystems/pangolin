import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalStorageProvider } from '../src/index.js';

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'pangolin-local-'));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

it('put + get round-trips bytes by content hash', async () => {
  const sp = new LocalStorageProvider({ rootDir });
  const payload = new TextEncoder().encode('hello world');
  const { contentHash } = await sp.put('pangolin://test/capability/foo', payload);
  const uri = `pangolin://test/capability/foo/${contentHash}`;
  const retrieved = await sp.get(uri);
  expect(new TextDecoder().decode(retrieved)).toBe('hello world');
});

it('parallel puts with different content hashes both land in _index.json', async () => {
  // Race-condition regression: without per-indexPath serialization the
  // read-modify-write of _index.json drops one of two concurrent entries.
  const sp = new LocalStorageProvider({ rootDir });
  const uri = 'pangolin://test/capability/race';
  const payloadA = new TextEncoder().encode('payload A');
  const payloadB = new TextEncoder().encode('payload B');

  const [a, b] = await Promise.all([sp.put(uri, payloadA), sp.put(uri, payloadB)]);
  expect(a.contentHash).not.toBe(b.contentHash);

  const indexPath = join(rootDir, 'test', 'capability', 'race', '_index.json');
  const raw = await readFile(indexPath, 'utf8');
  const index = JSON.parse(raw) as {
    entries: Array<{ contentHash: string; registeredAt: string }>;
  };
  const hashes = index.entries.map((e) => e.contentHash).sort();
  expect(hashes).toEqual([a.contentHash, b.contentHash].sort());
});

it('rejects URIs whose namespace contains ".." path-traversal segment', async () => {
  // Path-traversal regression: pangolin-core's URI parser only rejects empty
  // and slash-containing segments, so ".." would resolve outside rootDir
  // unless the provider defends itself.
  const sp = new LocalStorageProvider({ rootDir });
  const payload = new TextEncoder().encode('escape attempt');
  await expect(sp.put('pangolin://../capability/foo', payload)).rejects.toThrow(
    /unsafe/i,
  );
});

it('get() surfaces a descriptive error for missing blob (not raw ENOENT)', async () => {
  const sp = new LocalStorageProvider({ rootDir });
  // Use a valid-looking but never-written content hash.
  const fakeHash = 'sha256:' + '0'.repeat(64);
  const uri = `pangolin://test/capability/ghost/${fakeHash}`;
  await expect(sp.get(uri)).rejects.toThrow(/blob not found/i);
});
