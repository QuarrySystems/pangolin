// Integration tests for `@quarry-systems/pangolin-client` against the real
// `LocalStorageProvider` (always) and the real `LocalDockerProvider` (when
// Docker is reachable).
//
// Split:
//   - Register-side cases use the real `LocalStorageProvider` backed by an
//     `mkdtemp` directory torn down per test. They run unconditionally on
//     every host because nothing here touches Docker or AWS.
//   - The dispatch round-trip case uses the real `LocalDockerProvider`
//     against a digest-pinned busybox image. It is gated on `docker.ping()`
//     succeeding in `beforeAll`; on hosts without a daemon the case becomes
//     `it.skip` so the suite still runs green.
//
// ── Contract drift FIXED (was tracked by `it.fails`) ──────────────────────
//
// This integration suite is the first place that puts `registerCapability`,
// `registerSubagent`, and `registerEnv` against a REAL `StorageProvider`
// (the unit suites use an in-memory stub whose `put()` trusts the URI's hash
// segment without recomputing). Originally there was a real contract drift
// between the client's hash-of-canonical-object computation and the
// storage provider's hash-of-bytes verification:
//
//   - `registerCapability` built `contentHash = computeContentHash({kind,
//     name, files: {path: <sha256:hex>}})` but `storage.put` was called with
//     `serializeCapabilityBundle(name, filesBytes)` — a JSON header followed
//     by concatenated file bytes. The two hashes never agreed, so
//     `LocalStorageProvider.put` threw `IntegrityMismatchError`.
//
//   - `registerSubagent` built `contentHash = computeContentHash(def)`
//     (canonical, sorted-key JSON) but wrote `JSON.stringify(def)`
//     (insertion-key order).
//
//   - `registerEnv` had the same shape as subagent: `computeContentHash(def)`
//     on one side, `JSON.stringify(def)` on the other.
//
// Fix: register helpers now write CANONICAL-JSON bytes for subagent/env
// (so the byte-hash equals the canonical-object hash) and use the BYTE
// hash of `serializeCapabilityBundle(...)` for capabilities (matching
// what the worker's bundle-fetcher verifies). All three integration
// cases below run unconditionally now.
//
// ── Dispatch-record prefix FIXED ──────────────────────────────────────────
//
// A separate blocker also tracked by `it.fails` was that `client.dispatch`
// unconditionally calls `writeDispatchRecord`, which writes under the
// reserved `pangolin://<ns>/dispatches/...` prefix. The storage providers
// validated URIs through `parsePangolinUri`, which rejects `type === 'dispatches'`
// as a client-side write-safety guard, so dispatch-record writes threw at
// the storage layer. Fix: pangolin-core now exposes a permissive
// `parseStorageUri` that accepts both normal types AND `dispatches`. The
// storage providers branch on the URI kind: dispatch records are NOT
// content-addressed, so they bypass the `_index.json` registry and write
// the bytes directly to the URI-derived path. The general `parsePangolinUri`
// safety property is preserved — only `parseStorageUri` (used by storage
// providers, never by user code) accepts dispatches.
//
// ── Bundle-integrity-tampering case ───────────────────────────────────────
//
// Excluded by design (the task body grants explicit permission). The only
// way to stage a hash-mismatched blob is to bypass `StorageProvider` and
// write directly to the on-disk layout — fragile coupling for an
// integration test. `pangolin-storage-local/test/integration.test.ts` covers
// integrity at the right abstraction level.

import Docker from 'dockerode';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
} from 'vitest';

import { PangolinClient } from '../src/client.js';
import {
  StdoutResultSink,
  NoopCredentialProvider,
} from '../src/bundled-impls.js';
// Importing the barrel for its side-effect: it installs the namespaced
// sub-API getters (`client.capabilities`, `client.subagent`, `client.env`,
// `client.dispatch`) onto `PangolinClient.prototype`. Without this import the
// integration test would exercise the bare class without the namespaced
// surface — which is precisely the API consumers see.
import '../src/index.js';

import { LocalStorageProvider } from '@quarry-systems/pangolin-storage-local';
import { LocalDockerProvider } from '@quarry-systems/pangolin-providers-local-docker';
import {
  CredentialsInEnvError,
  type ComputeProvider,
  type ProviderContext,
  type TaskExit,
  type TaskHandle,
  type TaskSpec,
} from '@quarry-systems/pangolin-core';

// ── Docker gating ──────────────────────────────────────────────────────────
//
// `dockerAvailable` flips true in `beforeAll` if `docker.ping()` succeeds.
// `itIf(cond)` returns either `it` (run) or `it.skip` (skip-gracefully).
let dockerAvailable = false;
const docker = new Docker();
const itIf = (cond: boolean): typeof it => (cond ? it : it.skip);

// Current `library/busybox:latest` linux/amd64 manifest digest (matches the
// digest pinned in `pangolin-providers-local-docker/test/integration.test.ts`
// as of 2026-05-21). If Docker Hub repushes and this goes stale, update
// both call sites in lockstep.
const BUSYBOX_PINNED =
  'busybox@sha256:b8d1827e38a1d49cd17217efd7b07d689e4ea1744e39c7dcbb95533d175bea65';

/** Drain `docker.pull`'s stream to completion. */
async function pullImage(ref: string): Promise<void> {
  const stream = (await docker.pull(ref)) as NodeJS.ReadableStream;
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/** Best-effort cleanup so stopped containers do not accumulate across runs. */
async function tryRemove(id: string): Promise<void> {
  try {
    await docker.getContainer(id).remove({ force: true });
  } catch {
    // already gone
  }
}

beforeAll(async () => {
  try {
    await docker.ping();
    dockerAvailable = true;
  } catch {
    dockerAvailable = false;
    return;
  }
  // Warm the busybox image once so individual dispatch cases do not each
  // pay the pull cost. Pull is idempotent.
  await pullImage(BUSYBOX_PINNED);
}, /* 5-minute pull budget on cold CI caches */ 5 * 60 * 1000);

// ── Per-test temp-dir lifecycle ────────────────────────────────────────────
let storageRoot: string;

beforeEach(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'pangolin-client-int-'));
});

afterEach(async () => {
  await rm(storageRoot, { recursive: true, force: true });
});

// ── Client factory ─────────────────────────────────────────────────────────
//
// Two variants:
//   - `makeClient()` wires the real `LocalDockerProvider`. The busybox
//     digest above is real, so we exercise the production §7.4 path — no
//     `allowUnpinnedImage` escape hatch.
//   - `makeClientWithRecorder()` swaps the compute provider for an in-test
//     recorder that captures the `TaskSpec` instead of running it. Useful
//     for assertions about client-side orchestration (env merge, etc.)
//     that don't depend on a real daemon.
function makeClient(): PangolinClient {
  return new PangolinClient({
    namespace: 'tests',
    compute: {
      'local-docker': new LocalDockerProvider({ docker }),
    },
    credentials: { none: new NoopCredentialProvider() },
    storage: new LocalStorageProvider({ rootDir: storageRoot }),
    targets: { local: { compute: 'local-docker', credentials: 'none' } },
    resultSink: new StdoutResultSink(),
  });
}

interface RecordedRun {
  spec: TaskSpec;
  credentials: unknown;
}

function makeRecordingCompute(): { compute: ComputeProvider; runs: RecordedRun[] } {
  const runs: RecordedRun[] = [];
  let counter = 0;
  const compute: ComputeProvider = {
    name: 'recording-compute',
    async run(spec: TaskSpec, ctx: ProviderContext): Promise<TaskHandle> {
      counter += 1;
      runs.push({ spec, credentials: ctx.credentials });
      return { providerTaskId: `recorded-${counter}` };
    },
    async awaitExit(_handle: TaskHandle, _ctx: ProviderContext): Promise<TaskExit> {
      return {
        exitCode: 0,
        startedAt: new Date(0),
        finishedAt: new Date(1000),
        stdout: '',
        stderr: '',
      };
    },
  };
  return { compute, runs };
}

function makeClientWithRecorder(): {
  client: PangolinClient;
  runs: RecordedRun[];
} {
  const { compute, runs } = makeRecordingCompute();
  const client = new PangolinClient({
    namespace: 'tests',
    compute: { 'recording-compute': compute },
    credentials: { none: new NoopCredentialProvider() },
    storage: new LocalStorageProvider({ rootDir: storageRoot }),
    targets: { local: { compute: 'recording-compute', credentials: 'none' } },
    resultSink: new StdoutResultSink(),
  });
  return { client, runs };
}

// ──────────────────────────────────────────────────────────────────────────
// REGISTER-SIDE TESTS — run unconditionally against real LocalStorageProvider.
// ──────────────────────────────────────────────────────────────────────────

describe('pangolin-client integration — register side (no Docker required)', () => {
  it('rejects credential-shaped values in env-bundle `values` at register time', async () => {
    const client = makeClient();

    // AKIA... is the canonical AWS access-key prefix the credential-pattern
    // scanner flags. The error's `field` is asserted to match the documented
    // `env-bundle:<name>:<key>` shape so callers can route the error.
    //
    // This test passes UNCONDITIONALLY because the credential-pattern check
    // happens client-side BEFORE any storage interaction — it short-circuits
    // before the canonical-vs-bytes-hash drift can bite.
    await expect(
      client.env.register({
        name: 'leaky',
        values: { AWS_KEY: 'AKIAIOSFODNN7EXAMPLE' },
      }),
    ).rejects.toBeInstanceOf(CredentialsInEnvError);

    // Re-throw to inspect the field; `rejects.toBeInstanceOf` doesn't give
    // us a handle on the error object.
    let caught: CredentialsInEnvError | null = null;
    try {
      await client.env.register({
        name: 'leaky',
        values: { AWS_KEY: 'AKIAIOSFODNN7EXAMPLE' },
      });
    } catch (err) {
      caught = err as CredentialsInEnvError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.field).toBe('env-bundle:leaky:AWS_KEY');
  });

  // ── DRIFT FIX: canonical-JSON-bytes match for subagent/env, byte-hash
  // for capability. The three integration cases below previously carried
  // `it.fails` markers documenting the contract drift; the fix in this
  // commit lets them pass.
  it(
    'idempotent re-register of a capability returns the existing ref (same hash + registeredAt)',
    async () => {
      const client = makeClient();
      const ref1 = await client.capabilities.register({
        name: 'cap-idempotent',
        files: { 'README.md': 'hello world' },
      });
      const ref2 = await client.capabilities.register({
        name: 'cap-idempotent',
        files: { 'README.md': 'hello world' },
      });

      expect(ref2.contentHash).toBe(ref1.contentHash);
      // The load-bearing claim: idempotent re-register reuses `registeredAt`.
      // A new timestamp here would mean a duplicate storage write happened.
      expect(ref2.registeredAt).toBe(ref1.registeredAt);

      // And the registry has exactly one version entry — not two — for
      // this name. Use `client.storage.list(baseUri)` directly: the
      // catalog-level `client.capabilities.list()` is deferred (the
      // StorageProvider contract lacks a `listNames(prefix)` extension);
      // the storage-level per-name list is enough to assert idempotency.
      const versions = await client.storage.list(
        `pangolin://tests/capability/cap-idempotent`,
      );
      expect(versions).toHaveLength(1);
    },
  );

  it(
    'subagent.assign produces a NEW pinned version (different contentHash, registeredAt advances)',
    async () => {
      const client = makeClient();

      // Register two distinct capabilities so the assigned set actually differs.
      const capA = await client.capabilities.register({
        name: 'cap-A',
        files: { 'a.txt': 'A' },
      });
      const capB = await client.capabilities.register({
        name: 'cap-B',
        files: { 'b.txt': 'B' },
      });

      // Initial registration: subagent bound to cap-A only.
      const handle = await client.subagent.register({
        name: 'sub-evolve',
        systemPrompt: 'do work',
        capabilities: [capA],
      });
      const originalHash = handle.contentHash;
      const originalAt = handle.registeredAt;

      // Re-assign to {capA, capB}. This MUST produce a new content hash.
      const evolved = await client.subagent.assign(handle, [capA, capB]);
      expect(evolved.name).toBe('sub-evolve');
      expect(evolved.contentHash).not.toBe(originalHash);
      expect(evolved.registeredAt >= originalAt).toBe(true);

      // Both versions are addressable simultaneously: the storage layer
      // lists entries for both content hashes under the same logical name.
      const versions = await client.storage.list(
        `pangolin://tests/subagent/sub-evolve`,
      );
      const hashes = versions.map((v) => v.contentHash).sort();
      expect(hashes).toContain(originalHash);
      expect(hashes).toContain(evolved.contentHash);
      expect(hashes.length).toBeGreaterThanOrEqual(2);
    },
  );

  // The canonical-vs-bytes hash drift in `registerEnv` and
  // `registerSubagent` is fixed, so this test reaches the
  // `client.dispatch(...)` step. Dispatch unconditionally calls
  // `writeDispatchRecord`, which writes to a URI under the reserved
  // `dispatches/` prefix. The storage provider now uses the permissive
  // `parseStorageUri` (from pangolin-core) instead of `parsePangolinUri`, so
  // dispatch-record writes are accepted and this case runs unconditionally.
  it(
    'multiple env bundles merge later-wins on env-bundle secret-key collisions',
    async () => {
      // The client-side merge happens in `flattenEnvBundleSecrets` (dispatch.ts).
      // Bundles are folded left-to-right with later overriding earlier on a
      // key collision. This case asserts that contract end-to-end through the
      // real env-register + dispatch path, capturing the TaskSpec via a
      // recording compute so we can read the merged map directly.
      const { client, runs } = makeClientWithRecorder();

      // Register a baseline subagent (no capabilities) so dispatch resolves.
      await client.subagent.register({
        name: 'sub-merge',
        systemPrompt: 'noop',
      });

      // Two env bundles. Both define DB_PASS; only the later one wins. The
      // earlier one also contributes a unique LOG_REGION key, which must
      // survive the merge unchanged.
      //
      // Use ref-form secrets (`{ ref: '...' }`) — pre-registered opaque refs
      // that pass through unchanged without staging. No SecretStore or AWS
      // Secrets Manager calls are made for ref-form entries (§7.1).
      await client.env.register({
        name: 'env-base',
        secrets: {
          DB_PASS: { ref: 'arn:base:dbpass' },
          LOG_REGION: { ref: 'arn:base:region' },
        },
      });
      await client.env.register({
        name: 'env-override',
        secrets: {
          DB_PASS: { ref: 'arn:override:dbpass' },
        },
      });

      await client.dispatch({
        subagent: 'sub-merge',
        env: ['env-base', 'env-override'],
        target: 'local',
        workerImage: 'pangolin/worker:test',
      });

      expect(runs).toHaveLength(1);
      const spec = runs[0].spec;
      // Later bundle wins for the colliding key.
      expect(spec.secretRefs.DB_PASS).toBe('arn:override:dbpass');
      // Earlier bundle's unique key survives.
      expect(spec.secretRefs.LOG_REGION).toBe('arn:base:region');
    },
  );
});

// ──────────────────────────────────────────────────────────────────────────
// DISPATCH-SIDE TESTS — skipped on hosts without Docker.
// ──────────────────────────────────────────────────────────────────────────

describe('pangolin-client integration — dispatch round-trip (Docker-gated)', () => {
  // The dispatch round-trip is composed of THREE register calls
  // (capability + subagent + env) followed by `client.dispatch(...)`.
  // With the canonical-bytes / byte-hash fix in registerSubagent,
  // registerEnv, and registerCapability, the register stage no longer
  // throws on a real LocalStorageProvider. The DISPATCH step calls
  // `writeDispatchRecord`, which writes under the reserved `dispatches/`
  // prefix — now supported by `LocalStorageProvider` via the permissive
  // `parseStorageUri`. Runs end-to-end whenever Docker is reachable.
  itIf(dockerAvailable)(
    'register + dispatch round-trip: resolved block echoes exact content hashes',
    async () => {
      const client = makeClient();

      // Build a small bundle: one capability + one subagent that references
      // it + one env bundle with a single value.
      const capRef = await client.capabilities.register({
        name: 'cap-roundtrip',
        files: { 'note.txt': 'integration round trip' },
      });
      const subHandle = await client.subagent.register({
        name: 'sub-roundtrip',
        systemPrompt: 'noop subagent for round-trip test',
        capabilities: [capRef],
      });
      const envRef = await client.env.register({
        name: 'env-roundtrip',
        values: { LOG_LEVEL: 'info' },
      });

      // Dispatch through the real LocalDockerProvider against busybox. The
      // image's default command is `sh`, which without stdin exits 0
      // immediately — that's enough to drive the run() → awaitExit() →
      // sink → record path to completion.
      //
      // Note: LocalDockerProvider.allowUnpinnedImage defaults to false and
      // the busybox digest above is a real digest, so we exercise the §7.4
      // production path — no escape hatch used.
      const result = await client.dispatch({
        subagent: 'sub-roundtrip',
        env: 'env-roundtrip',
        target: 'local',
        workerImage: BUSYBOX_PINNED,
      });

      try {
        // The resolved block is the audit trail. Each ref MUST carry the
        // exact content hash we got back from the register calls — that is
        // the "exactly which bytes ran" contract from §4.3.
        expect(result.resolved.subagent.name).toBe('sub-roundtrip');
        expect(result.resolved.subagent.contentHash).toBe(subHandle.contentHash);

        expect(result.resolved.capabilities).toHaveLength(1);
        expect(result.resolved.capabilities[0].name).toBe('cap-roundtrip');
        expect(result.resolved.capabilities[0].contentHash).toBe(
          capRef.contentHash,
        );

        expect(result.resolved.env).toHaveLength(1);
        expect(result.resolved.env![0].name).toBe('env-roundtrip');
        expect(result.resolved.env![0].contentHash).toBe(envRef.contentHash);

        // The dispatch itself reached a terminal exit. We do not assert a
        // specific exitCode because busybox's default `sh` with no TTY can
        // exit 0 or non-zero across daemon versions; what matters is that
        // the lifecycle completed and the resolved block is intact.
        expect(typeof result.exitCode).toBe('number');
        expect(typeof result.dispatchId).toBe('string');
        expect(result.dispatchId).toMatch(/^[0-9a-f-]{36}$/);
      } finally {
        // Sweep any container the dispatch left behind. The provider does
        // not auto-remove on exit; integration tests are responsible for
        // their own cleanup so the daemon doesn't accumulate husks.
        try {
          const containers = await docker.listContainers({
            all: true,
            filters: { label: [`pangolin.dispatchId=${result.dispatchId}`] },
          });
          for (const c of containers) {
            await tryRemove(c.Id);
          }
        } catch {
          // best-effort
        }
      }
    },
    /* 2-minute budget — busybox should exit in seconds, generous slack for
       cold CI runs */ 2 * 60 * 1000,
  );
});
