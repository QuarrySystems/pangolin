import { describe, it, expect } from 'vitest';
import { computeContentHash } from '@quarry-systems/pangolin-core';
import type { StorageProvider } from '@quarry-systems/pangolin-core';
import { registerSubagent } from '../src/subagent-register.js';
import { PangolinClient } from '../src/client.js';

/**
 * In-memory storage stub, mirroring the one in subagent-register.test.ts —
 * blob bytes keyed by pinned URI; resolveLatest walks the registry sorted
 * by registration time so the newest write wins.
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
    namespace: 'ns',
    compute: {},
    credentials: {},
    storage,
    targets: {},
  });
}

describe('registerSubagent contextRequires', () => {
  it('a def without contextRequires hashes to the PRE-EDIT literal', () => {
    // Mirrors subagent-register.ts:70-77 exactly. This literal was derived from the
    // code BEFORE this change; if the guarded assignment regresses to `?? []` the
    // hash becomes sha256:1ba525f0cea7e0f980bdc333e89de66b0df868395ad84ec437c7a0c0adbe0fbe
    // and this goes red. Comparing two live registrations would NOT — both would move
    // together and stay equal.
    const def = {
      name: 'a',
      systemPrompt: 'x',
      promptTemplate: null,
      model: null,
      capabilities: [],
    };
    expect(computeContentHash(def)).toBe(
      'sha256:5001767f43a3fc2eaa7b7664acf684e9ea3236f36aac000a9738fc15e879318f',
    );
  });

  it('stores contextRequires verbatim on the def blob when set', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage);
    const handle = await registerSubagent(client, {
      name: 'runner',
      systemPrompt: 'run things',
      contextRequires: [{ kind: 'exec', bin: 'pnpm' }],
    });
    const pinnedUri = `pangolin://ns/subagent/runner/${handle.contentHash}`;
    const def = JSON.parse(new TextDecoder().decode(await storage.get(pinnedUri)));
    expect(def.contextRequires).toEqual([{ kind: 'exec', bin: 'pnpm' }]);
  });

  it('omits contextRequires from the def when not set, while a sibling that set it has the key', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage);

    const withoutHandle = await registerSubagent(client, {
      name: 'plain',
      systemPrompt: 'plain agent',
    });
    const withoutUri = `pangolin://ns/subagent/plain/${withoutHandle.contentHash}`;
    const withoutDef = JSON.parse(new TextDecoder().decode(await storage.get(withoutUri)));
    expect('contextRequires' in withoutDef).toBe(false);

    // Control: a sibling registration in the same test that DID set the field,
    // proving the read path itself works.
    const withHandle = await registerSubagent(client, {
      name: 'plain',
      systemPrompt: 'plain agent with reqs',
      contextRequires: [{ kind: 'git', needs: 'worktree' }],
    });
    const withUri = `pangolin://ns/subagent/plain/${withHandle.contentHash}`;
    const withDef = JSON.parse(new TextDecoder().decode(await storage.get(withUri)));
    expect('contextRequires' in withDef).toBe(true);
  });

  it('produces different content hashes when contextRequires differs', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage);
    const withA = await registerSubagent(client, {
      name: 'diverge',
      systemPrompt: 'x',
      contextRequires: [{ kind: 'exec', bin: 'pnpm' }],
    });
    const withB = await registerSubagent(client, {
      name: 'diverge',
      systemPrompt: 'x',
      contextRequires: [{ kind: 'exec', bin: 'npm' }],
    });
    expect(withA.contentHash).not.toBe(withB.contentHash);
  });
});
