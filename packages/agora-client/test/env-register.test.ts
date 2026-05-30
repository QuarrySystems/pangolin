import { describe, it, expect } from 'vitest';
import { registerEnv } from '../src/env-register.js';
import { AgoraClient } from '../src/client.js';
import {
  CredentialsInEnvError,
  type StorageProvider,
} from '@quarry-systems/agora-core';
import type {
  InlineSecretStager,
  StageInlineSecretArgs,
  StageInlineSecretResult,
} from '../src/secrets-manager.js';

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

function makeClient(storage: StorageProvider): AgoraClient {
  return new AgoraClient({
    namespace: 'ns',
    compute: {},
    credentials: {},
    storage,
    targets: {},
  });
}

/**
 * Minimal fake stager that records calls and returns a synthetic ARN.
 * Implements only the {@link InlineSecretStager.stage} surface that
 * env-register depends on.
 */
function makeFakeStager(): Pick<InlineSecretStager, 'stage'> & {
  calls: StageInlineSecretArgs[];
} {
  const calls: StageInlineSecretArgs[] = [];
  let counter = 0;
  return {
    calls,
    async stage(args: StageInlineSecretArgs): Promise<StageInlineSecretResult> {
      calls.push(args);
      counter += 1;
      return {
        arn: `arn:aws:secretsmanager:us-east-1:123:secret:fake-${counter}`,
        ttlSeconds: 7500,
      };
    },
  };
}

describe('registerEnv', () => {
  it('rejects values matching a credential pattern with field env-bundle:<name>:<key>', async () => {
    const client = makeClient(makeMemoryStorage());
    const stager = makeFakeStager();
    try {
      await registerEnv(client, {
        name: 'leaky',
        values: { AWS_KEY: 'AKIAIOSFODNN7EXAMPLE' },
        stager: stager as unknown as InlineSecretStager,
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
    const stager = makeFakeStager();
    // Without the allow-list this would throw; with it, the registration succeeds.
    const ref = await registerEnv(client, {
      name: 'allowed',
      values: { AWS_KEY: 'AKIAIOSFODNN7EXAMPLE' },
      allowCredentialPatterns: ['aws-access-key'],
      stager: stager as unknown as InlineSecretStager,
    });
    expect(ref.name).toBe('allowed');
    expect(ref.contentHash).toMatch(/^sha256:[0-9a-f]+$/);
  });

  it('returns an EnvRef with name, registeredAt, and contentHash', async () => {
    const client = makeClient(makeMemoryStorage());
    const stager = makeFakeStager();
    const ref = await registerEnv(client, {
      name: 'prod',
      values: { LOG_LEVEL: 'info' },
      stager: stager as unknown as InlineSecretStager,
    });
    expect(ref.name).toBe('prod');
    expect(typeof ref.registeredAt).toBe('string');
    expect(ref.contentHash).toMatch(/^sha256:[0-9a-f]+$/);
  });

  it('writes the env definition to storage at the pinned URI', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage);
    const stager = makeFakeStager();
    const ref = await registerEnv(client, {
      name: 'prod',
      values: { LOG_LEVEL: 'info' },
      stager: stager as unknown as InlineSecretStager,
    });
    const pinnedUri = `agora://ns/env/prod/${ref.contentHash}`;
    expect(storage.blobs.has(pinnedUri)).toBe(true);
  });

  it('passes through an opaque ref-form secret unchanged (no stage call)', async () => {
    const client = makeClient(makeMemoryStorage());
    const stager = makeFakeStager();
    const secretRef = 'arn:aws:secretsmanager:us-east-1:123:secret:preexisting';
    const ref = await registerEnv(client, {
      name: 'prod',
      secrets: { GH_TOKEN: { ref: secretRef } },
      stager: stager as unknown as InlineSecretStager,
    });
    expect(ref.contentHash).toMatch(/^sha256:[0-9a-f]+$/);
    expect(stager.calls).toHaveLength(0);
  });

  it('stages inline secrets and records ARN — not inline value — in the bundle', async () => {
    const storage = makeMemoryStorage();
    const client = makeClient(storage);
    const stager = makeFakeStager();
    const ref = await registerEnv(client, {
      name: 'prod',
      secrets: { GH_TOKEN: { inline: 'super-secret-value' } },
      stager: stager as unknown as InlineSecretStager,
    });

    // The stager was called for the inline secret.
    expect(stager.calls).toHaveLength(1);
    expect(stager.calls[0].envName).toBe('GH_TOKEN');
    expect(stager.calls[0].inline).toEqual({ inline: 'super-secret-value' });

    // The blob written to storage MUST contain the ARN but NOT the inline value.
    const pinnedUri = `agora://ns/env/prod/${ref.contentHash}`;
    const blob = storage.blobs.get(pinnedUri);
    expect(blob).toBeDefined();
    const decoded = new TextDecoder().decode(blob!);
    expect(decoded).toContain(
      'arn:aws:secretsmanager:us-east-1:123:secret:fake-1',
    );
    expect(decoded).not.toContain('super-secret-value');
  });

  it('content hash depends on secret ARN refs, not inline values', async () => {
    // Two registrations whose only difference is the inline value (the stager
    // returns the SAME ARN for both) should produce the SAME content hash —
    // because the hash covers ARN refs, not inline values.
    const client1 = makeClient(makeMemoryStorage());
    const client2 = makeClient(makeMemoryStorage());

    const fixedArnStager: Pick<InlineSecretStager, 'stage'> = {
      async stage(_args: StageInlineSecretArgs): Promise<StageInlineSecretResult> {
        return { arn: 'arn:fixed', ttlSeconds: 7500 };
      },
    };

    const refA = await registerEnv(client1, {
      name: 'prod',
      secrets: { GH_TOKEN: { inline: 'value-A' } },
      stager: fixedArnStager as unknown as InlineSecretStager,
    });
    const refB = await registerEnv(client2, {
      name: 'prod',
      secrets: { GH_TOKEN: { inline: 'value-B' } },
      stager: fixedArnStager as unknown as InlineSecretStager,
    });

    expect(refA.contentHash).toBe(refB.contentHash);
  });

  it('content hash differs when secret refs differ', async () => {
    const client1 = makeClient(makeMemoryStorage());
    const client2 = makeClient(makeMemoryStorage());

    const refA = await registerEnv(client1, {
      name: 'prod',
      secrets: { GH_TOKEN: { ref: 'arn:one' } },
      stager: makeFakeStager() as unknown as InlineSecretStager,
    });
    const refB = await registerEnv(client2, {
      name: 'prod',
      secrets: { GH_TOKEN: { ref: 'arn:two' } },
      stager: makeFakeStager() as unknown as InlineSecretStager,
    });

    expect(refA.contentHash).not.toBe(refB.contentHash);
  });

  it('content hash depends on values', async () => {
    const client1 = makeClient(makeMemoryStorage());
    const client2 = makeClient(makeMemoryStorage());
    const stager = makeFakeStager();

    const refA = await registerEnv(client1, {
      name: 'prod',
      values: { LOG_LEVEL: 'info' },
      stager: stager as unknown as InlineSecretStager,
    });
    const refB = await registerEnv(client2, {
      name: 'prod',
      values: { LOG_LEVEL: 'debug' },
      stager: stager as unknown as InlineSecretStager,
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
      stager: makeFakeStager() as unknown as InlineSecretStager,
    });
    const blobCountAfterFirst = storage.blobs.size;
    const second = await registerEnv(client, {
      name: 'prod',
      values: { LOG_LEVEL: 'info' },
      secrets: { GH_TOKEN: { ref: 'arn:fixed' } },
      stager: makeFakeStager() as unknown as InlineSecretStager,
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
    // idempotency check. With a real AWS Secrets Manager backing, the second
    // CreateSecretCommand would either throw ResourceExistsException or
    // return a different ARN — either way breaking the idempotency contract.
    //
    // The fix is to compute the lookup contentHash using a deterministic
    // placeholder for inline secrets (the staged secret NAME, not the AWS
    // ARN). The second identical call must short-circuit on idempotency
    // BEFORE invoking the stager. The fake stager here returns a fresh
    // ARN per call (counter-suffixed), exactly the failure mode the fix
    // exists to defend against.
    const storage = makeMemoryStorage();
    const client = makeClient(storage);
    const stager = makeFakeStager();

    const first = await registerEnv(client, {
      name: 'prod',
      values: { LOG_LEVEL: 'info' },
      secrets: { GH_TOKEN: { inline: 'super-secret-value' } },
      stager: stager as unknown as InlineSecretStager,
    });
    const stageCallsAfterFirst = stager.calls.length;
    const blobCountAfterFirst = storage.blobs.size;

    const second = await registerEnv(client, {
      name: 'prod',
      values: { LOG_LEVEL: 'info' },
      secrets: { GH_TOKEN: { inline: 'super-secret-value' } },
      stager: stager as unknown as InlineSecretStager,
    });

    // Idempotency holds end-to-end.
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.registeredAt).toBe(first.registeredAt);
    expect(storage.blobs.size).toBe(blobCountAfterFirst);

    // The stager was NOT called the second time — this is the load-bearing
    // assertion. Re-staging on a second identical call would either crash
    // (ResourceExistsException) or produce a fresh ARN that breaks the
    // hash-equality contract.
    expect(stager.calls.length).toBe(stageCallsAfterFirst);
  });
});
