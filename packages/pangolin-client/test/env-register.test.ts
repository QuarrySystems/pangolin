import { describe, it, expect } from 'vitest';
import { registerEnv } from '../src/env-register.js';
import { PangolinClient } from '../src/client.js';
import {
  CredentialsInEnvError,
  type StorageProvider,
  type SecretStore,
  type StageSecretArgs,
  type StagedSecret,
} from '@quarry-systems/pangolin-core';

/**
 * In-memory storage stub (mirrors the subagent-register test stub). Pinned
 * URIs are split into `<baseUri>/<contentHash>`; resolveLatest returns the
 * newest registration for a base URI.
 */
function makeMemoryStorage(): StorageProvider & {
  blobs: Map<string, Uint8Array>;
  registry: Map<
    string,
    Array<{ contentHash: string; registeredAt: string; pinnedUri: string }>
  >;
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

/**
 * Build a minimal fake SecretStore for test injection.
 */
function makeFakeStore(storeName = 'fake-store'): SecretStore & {
  staged: Array<StageSecretArgs>;
} {
  const staged: Array<StageSecretArgs> = [];
  let counter = 0;
  return {
    name: storeName,
    staged,
    async stage(args: StageSecretArgs): Promise<StagedSecret> {
      staged.push(args);
      counter += 1;
      return { ref: `local-secret://fake-${counter}`, ttlSeconds: 7500 };
    },
    async resolve(_ref: string): Promise<string> {
      return '';
    },
    async cleanupByTag(_tagKey: string, _tagValue: string): Promise<void> {},
  };
}

function makeClient(
  storage: StorageProvider,
  secretStores?: Record<string, SecretStore>,
): PangolinClient {
  return new PangolinClient({
    namespace: 'ns',
    compute: {},
    credentials: {},
    storage,
    targets: {},
    secretStores,
  });
}

describe('registerEnv', () => {
  it('rejects values matching a credential pattern with field env-bundle:<name>:<key>', async () => {
    const client = makeClient(makeMemoryStorage());
    try {
      await registerEnv(client, {
        name: 'leaky',
        values: { AWS_KEY: 'AKIAIOSFODNN7EXAMPLE' },
      });
      throw new Error('expected CredentialsInEnvError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialsInEnvError);
      expect((err as CredentialsInEnvError).field).toBe(
        'env-bundle:leaky:AWS_KEY',
      );
    }
  });

  it('passes allowCredentialPatterns through to the scanner', async () => {
    const client = makeClient(makeMemoryStorage());
    // Without the allow-list this would throw; with it, the registration succeeds.
    const ref = await registerEnv(client, {
      name: 'allowed',
      values: { AWS_KEY: 'AKIAIOSFODNN7EXAMPLE' },
      allowCredentialPatterns: ['aws-access-key'],
    });
    expect(ref.name).toBe('allowed');
    expect(ref.contentHash).toMatch(/^sha256:[0-9a-f]+$/);
  });

  it('returns an EnvRef with name, registeredAt, and contentHash', async () => {
    const client = makeClient(makeMemoryStorage());
    const ref = await registerEnv(client, {
      name: 'prod',
      values: { LOG_LEVEL: 'info' },
    });
    expect(ref.name).toBe('prod');
    expect(typeof ref.registeredAt).toBe('string');
    expect(ref.contentHash).toMatch(/^sha256:[0-9a-f]+$/);
  });

  it('writes the env definition to storage at the pinned URI', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage);
    const ref = await registerEnv(client, {
      name: 'prod',
      values: { LOG_LEVEL: 'info' },
    });
    const pinnedUri = `pangolin://ns/env/prod/${ref.contentHash}`;
    expect(storage.blobs.has(pinnedUri)).toBe(true);
  });

  it('passes through an opaque ref-form secret unchanged (no stage call)', async () => {
    const store = makeFakeStore();
    const client = makeClient(makeMemoryStorage(), { mystore: store });
    const secretRef = 'arn:aws:secretsmanager:us-east-1:123:secret:preexisting';
    const ref = await registerEnv(client, {
      name: 'prod',
      secrets: { GH_TOKEN: { ref: secretRef } },
      // no secretStore needed for ref-form secrets
    });
    expect(ref.contentHash).toMatch(/^sha256:[0-9a-f]+$/);
    expect(store.staged).toHaveLength(0);
  });

  it('stages inline secrets via the named store and records store kind on the blob', async () => {
    const storage = makeMemoryStorage();
    const store = makeFakeStore('local-file');
    const client = makeClient(storage, { local: store });
    const ref = await registerEnv(client, {
      name: 'b',
      secretStore: 'local',
      secrets: { K: { inline: 'super-inline-value' } },
    });

    // The store was called for the inline secret.
    expect(store.staged).toHaveLength(1);

    // Read back the stored blob and assert def.store === "local-file"
    // and def.secretRefs.K === the opaque ref (not the inline value)
    const pinnedUri = `pangolin://ns/env/b/${ref.contentHash}`;
    const blob = storage.blobs.get(pinnedUri);
    expect(blob).toBeDefined();
    const decoded = new TextDecoder().decode(blob!);
    const def = JSON.parse(decoded) as {
      store?: string;
      secretRefs: Record<string, string>;
    };
    expect(def.store).toBe('local-file');
    expect(def.secretRefs['K']).toBe('local-secret://fake-1');
    expect(decoded).not.toContain('super-inline-value'); // inline value never stored
  });

  it('stages inline secrets and records ref — not inline value — in the bundle', async () => {
    const storage = makeMemoryStorage();
    const store = makeFakeStore('test-store');
    const client = makeClient(storage, { mystore: store });
    const ref = await registerEnv(client, {
      name: 'prod',
      secrets: { GH_TOKEN: { inline: 'super-secret-value' } },
      secretStore: 'mystore',
    });

    // The store was called for the inline secret.
    expect(store.staged).toHaveLength(1);
    expect(store.staged[0].name).toContain('GH_TOKEN');

    // The blob written to storage MUST contain the ref but NOT the inline value.
    const pinnedUri = `pangolin://ns/env/prod/${ref.contentHash}`;
    const blob = storage.blobs.get(pinnedUri);
    expect(blob).toBeDefined();
    const decoded = new TextDecoder().decode(blob!);
    expect(decoded).toContain('local-secret://fake-1');
    expect(decoded).not.toContain('super-secret-value');
  });

  it('throws a clear error when inline secrets are present but secretStore is not provided', async () => {
    const client = makeClient(makeMemoryStorage());
    await expect(
      registerEnv(client, {
        name: 'prod',
        secrets: { GH_TOKEN: { inline: 'secret' } },
        // no secretStore
      }),
    ).rejects.toThrow('registerEnv: secretStore is required when the bundle has inline secrets');
  });

  it('throws a clear error when the named secretStore does not exist in client.secretStores', async () => {
    const client = makeClient(makeMemoryStorage(), {});
    await expect(
      registerEnv(client, {
        name: 'prod',
        secrets: { GH_TOKEN: { inline: 'secret' } },
        secretStore: 'nonexistent',
      }),
    ).rejects.toThrow('registerEnv: unknown secretStore nonexistent');
  });

  it('content hash depends on secret refs, not inline values', async () => {
    // Two registrations whose only difference is the inline value (the store
    // returns the SAME ref for both) should produce the SAME content hash —
    // because the hash covers placeholder names, not inline values.
    const client1 = makeClient(makeMemoryStorage(), {
      mystore: {
        name: 'fixed-store',
        async stage(_args: StageSecretArgs): Promise<StagedSecret> {
          return { ref: 'local-secret://fixed', ttlSeconds: 7500 };
        },
        async resolve(_ref: string): Promise<string> { return ''; },
        async cleanupByTag(_tagKey: string, _tagValue: string): Promise<void> {},
      },
    });
    const client2 = makeClient(makeMemoryStorage(), {
      mystore: {
        name: 'fixed-store',
        async stage(_args: StageSecretArgs): Promise<StagedSecret> {
          return { ref: 'local-secret://fixed', ttlSeconds: 7500 };
        },
        async resolve(_ref: string): Promise<string> { return ''; },
        async cleanupByTag(_tagKey: string, _tagValue: string): Promise<void> {},
      },
    });

    const refA = await registerEnv(client1, {
      name: 'prod',
      secrets: { GH_TOKEN: { inline: 'value-A' } },
      secretStore: 'mystore',
    });
    const refB = await registerEnv(client2, {
      name: 'prod',
      secrets: { GH_TOKEN: { inline: 'value-B' } },
      secretStore: 'mystore',
    });

    expect(refA.contentHash).toBe(refB.contentHash);
  });

  it('content hash differs when secret refs differ', async () => {
    const client1 = makeClient(makeMemoryStorage());
    const client2 = makeClient(makeMemoryStorage());

    const refA = await registerEnv(client1, {
      name: 'prod',
      secrets: { GH_TOKEN: { ref: 'arn:one' } },
    });
    const refB = await registerEnv(client2, {
      name: 'prod',
      secrets: { GH_TOKEN: { ref: 'arn:two' } },
    });

    expect(refA.contentHash).not.toBe(refB.contentHash);
  });

  it('content hash depends on values', async () => {
    const client1 = makeClient(makeMemoryStorage());
    const client2 = makeClient(makeMemoryStorage());

    const refA = await registerEnv(client1, {
      name: 'prod',
      values: { LOG_LEVEL: 'info' },
    });
    const refB = await registerEnv(client2, {
      name: 'prod',
      values: { LOG_LEVEL: 'debug' },
    });

    expect(refA.contentHash).not.toBe(refB.contentHash);
  });

  it('is idempotent: identical inputs reuse the existing registeredAt and skip a duplicate put', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage);

    const first = await registerEnv(client, {
      name: 'prod',
      values: { LOG_LEVEL: 'info' },
      secrets: { GH_TOKEN: { ref: 'arn:fixed' } },
    });
    const blobCountAfterFirst = storage.blobs.size;
    const second = await registerEnv(client, {
      name: 'prod',
      values: { LOG_LEVEL: 'info' },
      secrets: { GH_TOKEN: { ref: 'arn:fixed' } },
    });

    expect(second.contentHash).toBe(first.contentHash);
    expect(second.registeredAt).toBe(first.registeredAt);
    expect(storage.blobs.size).toBe(blobCountAfterFirst);
  });

  it('works with no values and no secrets (empty env)', async () => {
    const client = makeClient(makeMemoryStorage());
    const ref = await registerEnv(client, { name: 'empty' });
    expect(ref.name).toBe('empty');
    expect(ref.contentHash).toMatch(/^sha256:[0-9a-f]+$/);
  });

  it('is idempotent for inline secrets — second identical call reuses bundle without re-staging', async () => {
    // Regression: previously, inline secrets were staged BEFORE the
    // idempotency check. With a real Secrets Manager backing, the second
    // CreateSecretCommand would either throw ResourceExistsException or
    // return a different ref — either way breaking the idempotency contract.
    //
    // The fix is to compute the lookup contentHash using a deterministic
    // placeholder for inline secrets (the staged secret NAME, not the returned
    // ref). The second identical call must short-circuit on idempotency
    // BEFORE invoking the store. The fake store here returns a fresh
    // ref per call (counter-suffixed), exactly the failure mode the fix
    // exists to defend against.
    const storage = makeMemoryStorage();
    const store = makeFakeStore();
    const client = makeClient(storage, { mystore: store });

    const first = await registerEnv(client, {
      name: 'prod',
      values: { LOG_LEVEL: 'info' },
      secrets: { GH_TOKEN: { inline: 'super-secret-value' } },
      secretStore: 'mystore',
    });
    const stageCallsAfterFirst = store.staged.length;
    const blobCountAfterFirst = storage.blobs.size;

    const second = await registerEnv(client, {
      name: 'prod',
      values: { LOG_LEVEL: 'info' },
      secrets: { GH_TOKEN: { inline: 'super-secret-value' } },
      secretStore: 'mystore',
    });

    // Idempotency holds end-to-end.
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.registeredAt).toBe(first.registeredAt);
    expect(storage.blobs.size).toBe(blobCountAfterFirst);

    // The store was NOT called the second time — this is the load-bearing
    // assertion. Re-staging on a second identical call would either crash
    // (ResourceExistsException) or produce a fresh ref that breaks the
    // hash-equality contract.
    expect(store.staged.length).toBe(stageCallsAfterFirst);
  });

  it('pure values / ref-only bundles register with no secretStore needed', async () => {
    const client = makeClient(makeMemoryStorage());
    // No secretStore provided — must succeed because no inline secrets
    const ref = await registerEnv(client, {
      name: 'pure',
      values: { LOG_LEVEL: 'warn' },
      secrets: { TOKEN: { ref: 'arn:aws:some:ref' } },
    });
    expect(ref.name).toBe('pure');
    expect(ref.contentHash).toMatch(/^sha256:[0-9a-f]+$/);
  });
});
