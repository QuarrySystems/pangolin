// E2E: §4.3 auto-versioning — "content hash drives identity"
//
// Three facets of the same invariant covered here:
//
//   1. Identical re-registration of a capability returns the SAME ref
//      (same contentHash, same registeredAt) — idempotency.
//   2. Changed capability content under the same logical name produces a
//      NEW immutable version (different contentHash).
//   3. `subagent.assign()` rebinds the capability set and therefore yields
//      a NEW subagent version with a distinct content hash — and both the
//      old and new versions remain in storage as immutable rows.
//
// No Docker, no compute providers — the test exercises just the client +
// LocalStorageProvider against a per-test scratch directory.

// Workspace packages are not declared as deps of the repo-root manifest,
// so we import them from their built `dist/` outputs via relative paths.
// (Running this suite from the root keeps the e2e folder out of any single
// package's vitest scope.) Both packages are built by their own `pnpm
// build` — see the repo-level build script.
import {
  AgoraClient,
  NoopCredentialProvider,
  StdoutResultSink,
} from '../../packages/agora-client/dist/index.js';
import { LocalStorageProvider } from '../../packages/agora-storage-local/dist/index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

let storageRoot: string;

beforeEach(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'e2e-version-'));
});

afterEach(async () => {
  await rm(storageRoot, { recursive: true, force: true });
});

function makeClient(): AgoraClient {
  return new AgoraClient({
    namespace: 'versioning-tests',
    compute: {},
    credentials: { none: new NoopCredentialProvider() },
    storage: new LocalStorageProvider({ rootDir: storageRoot }),
    targets: {},
    resultSink: new StdoutResultSink(),
  });
}

describe('E2E: content-hash drives identity', () => {
  it('identical re-registration of a capability returns the existing ref', async () => {
    const client = makeClient();
    const a = await client.capabilities.register({
      name: 'cap',
      files: { 'a.txt': 'hello' },
    });
    const b = await client.capabilities.register({
      name: 'cap',
      files: { 'a.txt': 'hello' },
    });
    expect(b.contentHash).toBe(a.contentHash);
    expect(b.registeredAt).toBe(a.registeredAt);
    expect(b.name).toBe(a.name);
  });

  it('changed capability content creates a new version with a new hash', async () => {
    const client = makeClient();
    const a = await client.capabilities.register({
      name: 'cap',
      files: { 'a.txt': 'hello' },
    });
    const b = await client.capabilities.register({
      name: 'cap',
      files: { 'a.txt': 'changed' },
    });
    expect(b.contentHash).not.toBe(a.contentHash);

    // Both versions remain in storage (immutability).
    const baseUri = `agora://versioning-tests/capability/cap`;
    const versions = await client.storage.list(baseUri);
    const hashes = versions.map((v) => v.contentHash);
    expect(hashes).toContain(a.contentHash);
    expect(hashes).toContain(b.contentHash);
    expect(versions.length).toBe(2);
  });

  it('identical re-registration of a subagent returns the same ref', async () => {
    const client = makeClient();
    const cap = await client.capabilities.register({
      name: 'cap',
      files: { 'a.txt': 'hello' },
    });
    const a = await client.subagent.register({
      name: 'sub',
      systemPrompt: 'p',
      capabilities: [cap],
    });
    const b = await client.subagent.register({
      name: 'sub',
      systemPrompt: 'p',
      capabilities: [cap],
    });
    expect(b.contentHash).toBe(a.contentHash);
    expect(b.registeredAt).toBe(a.registeredAt);
  });

  it('subagent.assign() produces a new subagent version with a distinct content hash', async () => {
    const client = makeClient();
    const capA = await client.capabilities.register({
      name: 'capA',
      files: { 'x.txt': '1' },
    });
    const capB = await client.capabilities.register({
      name: 'capB',
      files: { 'y.txt': '2' },
    });
    const sub = await client.subagent.register({
      name: 'sub',
      systemPrompt: 'p',
      capabilities: [capA],
    });
    const reassigned = await sub.assign([capA, capB]);

    // The reassigned subagent is a new immutable version under the same name.
    expect(reassigned.name).toBe(sub.name);
    expect(reassigned.contentHash).not.toBe(sub.contentHash);

    // Both versions coexist in storage (§4.3 immutability).
    const baseUri = `agora://versioning-tests/subagent/sub`;
    const versions = await client.storage.list(baseUri);
    const hashes = versions.map((v) => v.contentHash);
    expect(hashes).toContain(sub.contentHash);
    expect(hashes).toContain(reassigned.contentHash);
    expect(versions.length).toBe(2);
  });
});
