// registerEnv against a REAL StorageProvider (serve-stack KNOWN-ISSUES 20).
//
// Deliberately NOT using the in-memory stub from env-register.test.ts. That stub
// reads the content hash out of the URI instead of computing it from the bytes
// (`env-register.test.ts` `put`: `parts[parts.length - 1]`), so it accepts a
// pinned URI whose hash does not describe its own contents. Every test built on
// it is blind to this entire class of defect — the instrument was lying, which
// is why an unconditionally-broken API path shipped.
//
// `LocalStorageProvider` performs the same byte re-hash the worker does
// (`bundle-fetcher.ts:113` hashes the fetched BYTES), so this file exercises the
// invariant both ends actually enforce.
//
// Lane: this is a normal unit test, run by `pnpm -r test`. The defect survived
// because its only executing check lived in the Docker-gated E2E suite, which CI
// does not run — a fix verified only there would be unverified in practice.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PangolinClient } from '../src/index.js';
import { registerEnv } from '../src/env-register.js';
import { LocalStorageProvider } from '@quarry-systems/pangolin-storage-local';
import { computeContentHash } from '@quarry-systems/pangolin-core';
import type { SecretStore } from '@quarry-systems/pangolin-core';

/**
 * Mimics the shape that breaks hash equality: `LocalSecretStore.stage` returns
 * `local-secret://<randomUUID>`, and `AwsSecretStore` a random-suffixed ARN.
 * The randomness is the point — a name-derived ref would hide the defect.
 */
function makeCountingStore(): SecretStore & { stageCalls: string[] } {
  const stageCalls: string[] = [];
  return {
    name: 'counting',
    stageCalls,
    async stage({ name }: { name: string }) {
      stageCalls.push(name);
      return { ref: `local-secret://${randomUUID()}` };
    },
    async resolve() {
      return 'unused';
    },
  } as unknown as SecretStore & { stageCalls: string[] };
}

describe('registerEnv integrity against a real StorageProvider', () => {
  let root: string;
  let storage: LocalStorageProvider;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'env-reg-'));
    storage = new LocalStorageProvider({ rootDir: root });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function makeClient(store: SecretStore): PangolinClient {
    return new PangolinClient({
      namespace: 'ns',
      compute: {},
      credentials: {},
      storage,
      targets: {},
      secretStores: { default: store },
    });
  }

  it('registers a bundle carrying an inline secret without throwing IntegrityMismatchError', async () => {
    const store = makeCountingStore();
    const res = await registerEnv(makeClient(store), {
      name: 'prod',
      values: { REGION: 'us-west-2' },
      secrets: { GH_TOKEN: { inline: 'super-secret-value' } },
      secretStore: 'default',
    });
    expect(res.name).toBe('prod');
    expect(res.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Control: the staging actually happened, so this is a real inline path and
    // not a bundle that quietly took the no-secrets branch.
    expect(store.stageCalls).toHaveLength(1);
  });

  it("the pinned URI's hash equals a re-hash of the stored bytes", async () => {
    const store = makeCountingStore();
    const res = await registerEnv(makeClient(store), {
      name: 'prod',
      secrets: { GH_TOKEN: { inline: 'super-secret-value' } },
      secretStore: 'default',
    });
    // Asserted directly rather than inferred from the absence of a throw: this
    // is the invariant putBlob enforces and the worker re-checks.
    const bytes = await storage.get(`pangolin://ns/env/prod/${res.contentHash}`);
    expect(computeContentHash(bytes)).toBe(res.contentHash);
  });

  it('the stored blob carries the real opaque ref, not the placeholder and not the secret value', async () => {
    const store = makeCountingStore();
    const res = await registerEnv(makeClient(store), {
      name: 'prod',
      secrets: { GH_TOKEN: { inline: 'super-secret-value' } },
      secretStore: 'default',
    });
    const body = new TextDecoder().decode(
      await storage.get(`pangolin://ns/env/prod/${res.contentHash}`),
    );
    // A presence beside the two absences, so the absences are not an empty read.
    expect(body).toContain('local-secret://');
    expect(body).not.toContain('super-secret-value');
    expect(body).not.toContain('pangolin/inline/env-prod/GH_TOKEN');
  });

  it('registering the same bundle twice stages exactly once and reuses registeredAt', async () => {
    const store = makeCountingStore();
    const client = makeClient(store);
    const opts = {
      name: 'prod',
      values: { REGION: 'us-west-2' },
      secrets: { GH_TOKEN: { inline: 'super-secret-value' } },
      secretStore: 'default',
    };
    const first = await registerEnv(client, { ...opts });
    const second = await registerEnv(client, { ...opts });

    // The single stage call is the control proving the early return fired,
    // rather than the test never reaching the idempotent path.
    expect(store.stageCalls).toHaveLength(1);
    expect(second.registeredAt).toBe(first.registeredAt);
  });

  it('registering a bundle whose values changed stages again and yields a different pinned URI', async () => {
    const store = makeCountingStore();
    const client = makeClient(store);
    const first = await registerEnv(client, {
      name: 'prod',
      values: { REGION: 'us-west-2' },
      secrets: { GH_TOKEN: { inline: 'v1' } },
      secretStore: 'default',
    });
    const second = await registerEnv(client, {
      name: 'prod',
      values: { REGION: 'eu-west-1' },
      secrets: { GH_TOKEN: { inline: 'v1' } },
      secretStore: 'default',
    });
    expect(store.stageCalls).toHaveLength(2);
    expect(second.contentHash).not.toBe(first.contentHash);
  });

  it('a bundle with no inline secrets still round-trips (regression guard on the unchanged path)', async () => {
    const store = makeCountingStore();
    const res = await registerEnv(makeClient(store), {
      name: 'plain',
      values: { REGION: 'us-west-2' },
    });
    const bytes = await storage.get(`pangolin://ns/env/plain/${res.contentHash}`);
    expect(computeContentHash(bytes)).toBe(res.contentHash);
    expect(store.stageCalls).toHaveLength(0);
  });
});
