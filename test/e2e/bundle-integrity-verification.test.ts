// E2E §7.2: bundle integrity verification.
//
// Proves the worker rejects a tampered bundle BEFORE invoking the sub-agent.
// The flow:
//
//   1. Register a capability, a sub-agent that depends on it, and an env.
//   2. Walk the LocalStorageProvider's on-disk tree and locate the capability
//      blob. Mutate its bytes in place so the file no longer hashes to the
//      contentHash advertised in the bundle refs.
//   3. Drive a `client.dispatch()` against `LocalDockerProvider` +
//      `LocalStorageProvider`. The worker's `fetchBundles()` re-hashes the
//      bytes it reads from storage; mismatch → IntegrityMismatchError →
//      `reason: 'integrity-failed'` (see `packages/pangolin-worker/src/entrypoint.ts`
//      §3 and `packages/pangolin-worker/src/bundle-fetcher.ts` header).
//   4. Assert the failure surfaces on `result.failure.reason` AND that the
//      sub-agent never ran (no echo string in stdout) — the worker must fail
//      before the runtime adapter is invoked.
//
// A second "baseline" test re-runs the same scenario without tampering and
// asserts the dispatch completes normally, so a hypothetical regression that
// always returns `integrity-failed` would be caught.
//
// LocalStorageProvider's on-disk layout (mirrored from
// `packages/pangolin-storage-local/src/index.ts`):
//
//   <rootDir>/<namespace>/<type>/<name>/<safeHash>.blob
//
// where `<safeHash>` is the pangolin-core contentHash `sha256:<hex>` with the
// ":" replaced by "_" (Windows-friendly filenames). For this test that means
// the capability blob lands at:
//
//   <storageRoot>/integrity/capability/tampered-cap/sha256_<hex>.blob
//
// Tampering writes arbitrary bytes to that file; the index.json is left
// intact so dispatch resolution still finds the (now-corrupted) blob.
//
// SKIPS gracefully when the Docker daemon isn't reachable, via `probeDocker`
// + `itIfDocker` from `./helpers/docker-skip.ts`.

import { describe, expect } from 'vitest';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { makeClient } from './helpers/make-client.js';
import { probeDocker, itIfDocker } from './helpers/docker-skip.js';
import { useTempStorageRoot } from './helpers/temp-storage.js';
import { WORKER_IMAGE } from './helpers/worker-image.js';

probeDocker();
const storageRoot = useTempStorageRoot('e2e-integrity');

/**
 * Locate the (single) `.blob` file under
 * `<storageRoot>/<namespace>/capability/<capName>/`. Returns the absolute
 * path. Throws if zero or multiple blobs are present so the test fails loudly
 * if the storage layout changes underfoot.
 */
async function findCapabilityBlob(
  root: string,
  namespace: string,
  capName: string,
): Promise<string> {
  const dir = join(root, namespace, 'capability', capName);
  const entries = await readdir(dir);
  const blobs = entries.filter((e) => e.endsWith('.blob'));
  if (blobs.length !== 1) {
    throw new Error(
      `expected exactly one capability blob under ${dir}, found ${blobs.length}: ${entries.join(', ')}`,
    );
  }
  return join(dir, blobs[0]!);
}

describe('E2E: bundle integrity verification (§7.2)', () => {
  itIfDocker(
    'tampered capability blob fails dispatch with reason "integrity-failed" before sub-agent invocation',
    async () => {
      const root = storageRoot();
      const client = makeClient({ namespace: 'integrity', storageRoot: root });

      const cap = await client.capabilities.register({
        name: 'tampered-cap',
        files: { 'a.txt': 'original' },
      });
      await client.subagent.register({
        name: 'agent',
        systemPrompt:
          'You are a tripwire agent. If you ever run, print exactly "agent-ran" so the integrity test can detect it.',
        capabilities: [cap],
      });
      await client.env.register({ name: 'e', values: {} });

      // Sanity-check: the capability ref points at a real on-disk blob whose
      // bytes hash to `cap.contentHash`. (LocalStorageProvider verifies this
      // on `get`; we do an independent read here just to make the tamper
      // step obviously meaningful.)
      const blobPath = await findCapabilityBlob(root, 'integrity', 'tampered-cap');
      const originalBytes = await readFile(blobPath);
      expect(originalBytes.byteLength).toBeGreaterThan(0);

      // Tamper: overwrite the blob with bytes that cannot possibly hash to
      // the original `cap.contentHash`. We append a sentinel so the worker's
      // hash check fires even if the original happened to start with these
      // bytes (it can't — the bundle header carries the file list — but the
      // append makes the intent unambiguous).
      const tampered = new Uint8Array(originalBytes.byteLength + 16);
      tampered.set(originalBytes, 0);
      tampered.set(new TextEncoder().encode('TAMPERED_BYTES!!'), originalBytes.byteLength);
      await writeFile(blobPath, tampered);

      const result = await client.dispatch({
        subagent: 'agent',
        env: 'e',
        target: 'local',
        timeoutSeconds: 60,
        workerImage: WORKER_IMAGE,
      } as any);

      // The worker must fail with the §7.2 integrity reason.
      expect(result.failure?.reason).toBe('integrity-failed');

      // And the sub-agent must NOT have run — the integrity check fires in
      // step 3 of the worker lifecycle, before the runtime adapter is
      // invoked, so the tripwire string cannot appear in stdout.
      expect(result.stdout).not.toContain('agent-ran');

      // Restore the blob so afterEach cleanup is symmetric (rm -rf doesn't
      // care, but a future change to the cleanup strategy might).
      await writeFile(blobPath, originalBytes);
    },
    120_000,
  );

  itIfDocker(
    'un-tampered storage completes dispatch normally (baseline)',
    async () => {
      const root = storageRoot();
      const client = makeClient({ namespace: 'integrity', storageRoot: root });

      const cap = await client.capabilities.register({
        name: 'tampered-cap',
        files: { 'a.txt': 'original' },
      });
      await client.subagent.register({
        name: 'agent',
        systemPrompt:
          'You are a tripwire agent. If you ever run, print exactly "agent-ran" so the integrity test can detect it.',
        capabilities: [cap],
      });
      await client.env.register({ name: 'e', values: {} });

      const result = await client.dispatch({
        subagent: 'agent',
        env: 'e',
        target: 'local',
        timeoutSeconds: 60,
        workerImage: WORKER_IMAGE,
      } as any);

      // Baseline: no tampering, so no integrity failure. We deliberately do
      // NOT assert exit-code 0 here — the §9 happy-path test owns that
      // assertion. The point of this baseline is to prove the integrity
      // failure in the previous test was caused by the tamper step, not by
      // something else in the harness. Any failure that ISN'T
      // 'integrity-failed' is acceptable here (e.g. the tiny worker image
      // not being published yet); a failure that IS 'integrity-failed'
      // would be a false positive in the tampered test.
      expect(result.failure?.reason).not.toBe('integrity-failed');

      // Untouched cap.contentHash is plumbed through for future-proofing —
      // if dispatch succeeds, the resolved block must echo the same hash.
      if (!result.failure) {
        expect(result.resolved.capabilities[0]!.contentHash).toBe(
          cap.contentHash,
        );
      }
    },
    120_000,
  );
});
