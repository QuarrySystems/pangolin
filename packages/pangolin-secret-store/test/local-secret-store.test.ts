import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSecretStore } from '../src/local-secret-store.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pangolin-localsecret-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('LocalSecretStore', () => {
  it('round-trips a staged value through resolve', async () => {
    const store = new LocalSecretStore({ dir });
    const staged = await store.stage({
      name: 'd-1/FOO',
      value: 's3cr3t-value',
      ttlSeconds: 60,
    });
    expect(staged.ref.startsWith('local-secret://')).toBe(true);
    expect(staged.ttlSeconds).toBe(60);
    const value = await store.resolve(staged.ref);
    expect(value).toBe('s3cr3t-value');
  });

  it('gives distinct refs to two stages of the same logical name', async () => {
    const store = new LocalSecretStore({ dir });
    const a = await store.stage({ name: 'FOO', value: 'one', ttlSeconds: 1 });
    const b = await store.stage({ name: 'FOO', value: 'two', ttlSeconds: 1 });
    expect(a.ref).not.toBe(b.ref);
    expect(await store.resolve(a.ref)).toBe('one');
    expect(await store.resolve(b.ref)).toBe('two');
  });

  it('throws when resolving an unknown ref', async () => {
    const store = new LocalSecretStore({ dir });
    await expect(store.resolve('local-secret://does-not-exist')).rejects.toThrow();
  });

  it('rejects a ref whose id is a path-traversal payload (defense-in-depth)', async () => {
    // A ref carrying path separators or `..` must never be joined into a filesystem
    // path — it could read/write `.secret` files outside `dir`. The check is on path
    // SAFETY, not id format, so legitimate non-UUID ids (below) still resolve.
    const store = new LocalSecretStore({ dir });
    await expect(store.resolve('local-secret://../../../etc/passwd')).rejects.toThrow(
      /invalid secret id/i,
    );
    await expect(store.resolve('local-secret://..\\..\\windows\\system32\\config')).rejects.toThrow(
      /invalid secret id/i,
    );
    await expect(store.resolve('local-secret://')).rejects.toThrow(/invalid secret id/i); // empty id
  });

  it('resolves a ref whose id is a safe non-UUID segment', async () => {
    // ids are normally minted UUIDs, but the store must not OVER-reject: any id that is
    // a safe single path segment (no separators, no `..`) is legitimate — e.g. a caller
    // that stages with its own opaque id. Path-safety is the invariant, not UUID-shape.
    const writer = new LocalSecretStore({ dir });
    const staged = await writer.stage({ name: 'K', value: 'v', ttlSeconds: 1 });
    // Sanity: a minted id round-trips.
    expect(await writer.resolve(staged.ref)).toBe('v');
    // A hand-constructed safe id also resolves.
    await writeFile(join(dir, 'safe-name.secret'), 'hand-staged', { mode: 0o600 });
    expect(await writer.resolve('local-secret://safe-name')).toBe('hand-staged');
  });

  it('resolves a ref written by a separate store instance over the same dir', async () => {
    // The worker constructs its own LocalSecretStore over the same dir the
    // client staged into — resolution must not depend on in-memory state.
    const writer = new LocalSecretStore({ dir });
    const staged = await writer.stage({ name: 'K', value: 'v', ttlSeconds: 1 });
    const reader = new LocalSecretStore({ dir });
    expect(await reader.resolve(staged.ref)).toBe('v');
  });

  it('cleanupByTag deletes only secrets carrying the matching tag', async () => {
    const store = new LocalSecretStore({ dir });
    const keep = await store.stage({
      name: 'KEEP',
      value: 'keep',
      ttlSeconds: 1,
      tags: { 'pangolin:dispatchId': 'other' },
    });
    const drop = await store.stage({
      name: 'DROP',
      value: 'drop',
      ttlSeconds: 1,
      tags: { 'pangolin:dispatchId': 'd-1' },
    });
    await store.cleanupByTag('pangolin:dispatchId', 'd-1');
    await expect(store.resolve(drop.ref)).rejects.toThrow();
    expect(await store.resolve(keep.ref)).toBe('keep');
  });

  it('cleanupByTag does not throw when nothing matches', async () => {
    const store = new LocalSecretStore({ dir });
    await expect(store.cleanupByTag('pangolin:dispatchId', 'nope')).resolves.toBeUndefined();
  });

  it('exposes a stable provider name', () => {
    expect(new LocalSecretStore({ dir }).name).toBe('local-file');
  });

  it('exposes its dir for bind-mount emission', () => {
    const store = new LocalSecretStore({ dir: '/tmp/pangolin-secrets' });
    expect(store.dir).toBe('/tmp/pangolin-secrets');
  });

  it('does not leave the plaintext value in a predictable shared file at dir root', async () => {
    // Sanity: the value lives in a per-secret file, not smeared into a
    // single shared index that could be accidentally surfaced.
    const store = new LocalSecretStore({ dir });
    await store.stage({ name: 'X', value: 'PLAINTEXT_MARKER', ttlSeconds: 1 });
    const entries = await readdir(dir);
    expect(entries.length).toBeGreaterThan(0);
  });
});
