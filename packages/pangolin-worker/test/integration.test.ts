// Integration suite for the worker's 14-step lifecycle (spec §6.2, §9
// "RuntimeAdapter seam smoke test").
//
// These tests run `runWorker` end-to-end against a real
// `LocalStorageProvider` and an on-disk mock runtime adapter that **never**
// imports `@quarry-systems/pangolin-runtime-claude-code`. That property is the
// load-bearing claim: if the lifecycle completes with a mock adapter
// supplied via the standard `<adaptersRoot>/<name>/index.js` discovery
// path, the worker is genuinely runtime-agnostic.
//
// Coverage (from the DAG-plan task body):
//   1. happy path (fetch → overlay → invoke → finished, exit 0)
//   2. integrity failure (capability hash wrong)
//   3. setup-script timeout (worker-failed, exit 1) — POSIX-only
//   4. needs_input round-trip (valid sentinel → dispatch.needs_input, 0)
//   5. malformed sentinel → worker-failed
//   6. oversized partial_state → worker-failed
//
// Each test gets a fresh adaptersRoot, storageRoot, and workspaceDir under
// the OS tmpdir; afterEach tears them down so there is zero shared state.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `runWorker` comes from the public barrel (`../src/index.js`) — this
// exercises the same export surface external callers see. The repo
// convention is to import the source-tree barrel rather than the
// `@quarry-systems/pangolin-worker` package alias because pnpm + vitest does
// not resolve a package's self-reference.
import { runWorker } from '../src/index.js';
// `RunWorkerDeps` is the injection seam declared on the entrypoint module —
// it intentionally lives outside the public barrel (production callers don't
// need it) but tests do. Importing from the source path is the documented
// route per the task acceptance criteria.
import type { RunWorkerDeps } from '../src/entrypoint.js';
import { LocalStorageProvider } from '@quarry-systems/pangolin-storage-local';
import {
  computeContentHash,
  type LifecycleEvent,
} from '@quarry-systems/pangolin-core';

// Skip the bash-spawning case on Windows runners (Node's child_process can't
// spawn POSIX shells). Mirrors the gate in `test/setup-script.test.ts`.
const itPosix = process.platform === 'win32' ? it.skip : it;

// ---------------------------------------------------------------------------
// Helpers — bundle packing + URI assembly
// ---------------------------------------------------------------------------

/**
 * Mirror of `pangolin-client.serializeCapabilityBundle`: header line of
 * `{"name", "entries":[{"path","size"}]}` (entries sorted by path), then
 * concatenated payload bytes. The worker's `unpackBundle` is the inverse.
 */
function packBundle(
  name: string,
  files: Record<string, Uint8Array>,
): Uint8Array {
  const paths = Object.keys(files).sort();
  const entries = paths.map((path) => ({ path, size: files[path]!.byteLength }));
  const headerBytes = new TextEncoder().encode(
    JSON.stringify({ name, entries }) + '\n',
  );
  const total =
    headerBytes.byteLength +
    paths.reduce((acc, p) => acc + files[p]!.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  out.set(headerBytes, 0);
  offset += headerBytes.byteLength;
  for (const p of paths) {
    out.set(files[p]!, offset);
    offset += files[p]!.byteLength;
  }
  return out;
}

function jsonBytes(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Mock adapter — written to <adaptersRoot>/mock/index.js as ESM.
// Behavior switches on the `MOCK_ADAPTER_SCENARIO` env var the worker
// passes through `ctx.env` (carried over from the test env into the merged
// env handed to the adapter). The file imports NOTHING from
// `@quarry-systems/pangolin-runtime-claude-code` — that is the seam contract.
// ---------------------------------------------------------------------------

const MOCK_ADAPTER_SOURCE = `
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export default () => ({
  name: 'mock',
  reservedPaths: [],
  invoke: async (spec, ctx) => {
    const scenario = ctx.env.MOCK_ADAPTER_SCENARIO ?? 'finished';
    if (scenario === 'finished') {
      return { exitCode: 0, stdout: 'mock stdout', stderr: '' };
    }
    if (scenario === 'needs-input-valid') {
      const dir = join(spec.workspaceDir, '.pangolin');
      await mkdir(dir, { recursive: true });
      const sentinelPath = join(dir, 'needs_input.json');
      await writeFile(
        sentinelPath,
        JSON.stringify({
          question: 'pick a color',
          options: ['red', 'blue'],
        }),
        'utf-8',
      );
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        needsInputSentinelPath: sentinelPath,
      };
    }
    if (scenario === 'needs-input-malformed') {
      const dir = join(spec.workspaceDir, '.pangolin');
      await mkdir(dir, { recursive: true });
      const sentinelPath = join(dir, 'needs_input.json');
      await writeFile(sentinelPath, '{ not valid json', 'utf-8');
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        needsInputSentinelPath: sentinelPath,
      };
    }
    if (scenario === 'needs-input-oversized') {
      const dir = join(spec.workspaceDir, '.pangolin');
      await mkdir(dir, { recursive: true });
      const sentinelPath = join(dir, 'needs_input.json');
      // partial_state > 1 MiB (canonical-JSON serialized) is the
      // oversized condition per ADR-0009. A 2 MiB string easily clears
      // the bar after JSON.stringify adds its quote characters.
      const big = 'x'.repeat(2 * 1024 * 1024);
      await writeFile(
        sentinelPath,
        JSON.stringify({
          question: 'too big',
          partial_state: { blob: big },
        }),
        'utf-8',
      );
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        needsInputSentinelPath: sentinelPath,
      };
    }
    throw new Error('unknown MOCK_ADAPTER_SCENARIO: ' + scenario);
  },
});
`;

// ---------------------------------------------------------------------------
// Per-test harness — set up storageRoot, adaptersRoot, workspace, bundles.
// ---------------------------------------------------------------------------

interface StagedRefs {
  subagent: { uri: string; contentHash: string };
  capabilities: Array<{ uri: string; contentHash: string }>;
  env: Array<{ uri: string; contentHash: string }>;
}

interface Harness {
  storageRoot: string;
  adaptersRoot: string;
  workspaceDir: string;
  storage: LocalStorageProvider;
  refs: StagedRefs;
  events: LifecycleEvent[];
}

async function stageDefaultBundles(
  storage: LocalStorageProvider,
): Promise<StagedRefs> {
  // Subagent definition — minimal viable JSON the worker can hash + parse.
  //
  // Subagent bundles carry two different hashes:
  //
  //   - The **byte hash** of the on-disk JSON encoding (whatever
  //     `JSON.stringify` produced). That hash is what the LocalStorageProvider
  //     uses to address the blob — i.e. the contentHash segment of the URI.
  //   - The **canonical-JSON hash** of the parsed object (keys sorted, etc.).
  //     That hash is what `verifyContentHash` recomputes inside the worker's
  //     bundle-fetcher, so it is the value that goes into the bundleRef's
  //     `contentHash` field.
  //
  // The two will differ whenever `JSON.stringify`'s key order does not match
  // alphabetical, which is the common case. Conflating them was the source
  // of the original red-state hash mismatch.
  const subagentDef = {
    name: 'alpha',
    systemPrompt: 'do the thing',
    promptTemplate: 'say hi to {{name}}',
    model: 'mock-model-1',
  };
  const subagentBytes = jsonBytes(subagentDef);
  const { contentHash: subagentByteHash } = await storage.put(
    'pangolin://ns/subagent/alpha',
    subagentBytes,
  );
  const subagentCanonicalHash = computeContentHash(subagentDef);
  const subagentUri = `pangolin://ns/subagent/alpha/${subagentByteHash}`;

  // Capability bundle with one file. The worker overlays this into the
  // workspace; the happy-path test reads it back to prove the overlay step
  // actually ran.
  //
  // Capability bundles, by contrast, are hashed by **raw bytes** in the
  // worker's bundle-fetcher (the bundle is opaque to canonicalization), so
  // the URI's byte-hash and the bundleRef's `contentHash` are the same value.
  const capFiles = {
    'README.md': new TextEncoder().encode('integration-test-marker\n'),
  };
  const capBytes = packBundle('cap-a', capFiles);
  const { contentHash: capByteHash } = await storage.put(
    'pangolin://ns/capability/cap-a',
    capBytes,
  );
  const capUri = `pangolin://ns/capability/cap-a/${capByteHash}`;

  return {
    subagent: { uri: subagentUri, contentHash: subagentCanonicalHash },
    capabilities: [{ uri: capUri, contentHash: capByteHash }],
    env: [],
  };
}

async function setupHarness(): Promise<Harness> {
  const storageRoot = await mkdtemp(join(tmpdir(), 'pangolin-int-storage-'));
  const adaptersRoot = await mkdtemp(join(tmpdir(), 'pangolin-int-adapters-'));
  const workspaceDir = await mkdtemp(join(tmpdir(), 'pangolin-int-work-'));

  // Install the mock adapter under <adaptersRoot>/mock/index.js. The
  // adapter-loader's `pathToFileURL().href` import requires ESM.
  const adapterDir = join(adaptersRoot, 'mock');
  await mkdir(adapterDir, { recursive: true });
  await writeFile(join(adapterDir, 'index.js'), MOCK_ADAPTER_SOURCE, 'utf-8');

  const storage = new LocalStorageProvider({ rootDir: storageRoot });
  const refs = await stageDefaultBundles(storage);

  return {
    storageRoot,
    adaptersRoot,
    workspaceDir,
    storage,
    refs,
    events: [],
  };
}

async function teardown(h: Harness | undefined): Promise<void> {
  if (!h) return; // setupHarness threw; nothing to clean up.
  await rm(h.storageRoot, { recursive: true, force: true });
  await rm(h.adaptersRoot, { recursive: true, force: true });
  await rm(h.workspaceDir, { recursive: true, force: true });
}

/**
 * Build the env vars the worker reads, plus optional per-scenario overrides
 * (e.g. `MOCK_ADAPTER_SCENARIO`). `PANGOLIN_STORAGE_URI` is set to a `file://`
 * URI pointing at the storageRoot so the deps-less code path in
 * `constructStorageProvider` would also work; we still inject `storage:`
 * below to bypass the import cycle and keep tests hermetic.
 */
function buildEnv(
  h: Harness,
  refsOverride?: StagedRefs,
  extra: Record<string, string> = {},
): Record<string, string> {
  const refs = refsOverride ?? h.refs;
  return {
    PANGOLIN_DISPATCH_ID: 'd-integration',
    PANGOLIN_NAMESPACE: 'ns',
    PANGOLIN_STORAGE_URI: `file://${h.storageRoot}`,
    PANGOLIN_BUNDLE_REFS_JSON: JSON.stringify(refs),
    PANGOLIN_INPUT_JSON: JSON.stringify({ name: 'world' }),
    PANGOLIN_RUNTIME_ADAPTER: 'mock',
    ...extra,
  };
}

function buildDeps(h: Harness, extra: Partial<RunWorkerDeps> = {}): RunWorkerDeps {
  return {
    storage: h.storage,
    adaptersRoot: h.adaptersRoot,
    workspaceDir: h.workspaceDir,
    secretsManagerClient: {
      // Unused in these tests (no PANGOLIN_CALLBACK_URL configured), but the
      // entrypoint constructs one unconditionally so providing a stub
      // shields tests from real AWS SDK boot cost.
      send: async () => ({ SecretString: 'unused' }),
    } as never,
    onLifecycleEvent: (e: LifecycleEvent) => {
      h.events.push(e);
    },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('worker lifecycle (RuntimeAdapter seam smoke test)', () => {
  let h: Harness | undefined;

  beforeEach(async () => {
    h = await setupHarness();
  });

  afterEach(async () => {
    await teardown(h);
    h = undefined;
  });

  // Narrowed accessor — every test runs after beforeEach so `h` is defined.
  // This wrapper turns the `Harness | undefined` field into `Harness` for
  // the test bodies and surfaces a clear error if setup ever fails silently.
  const harness = (): Harness => {
    if (!h) throw new Error('integration harness not initialized');
    return h;
  };

  it('runs the full lifecycle with a mock adapter and exits 0', async () => {
    const h = harness();
    const env = buildEnv(h, undefined, { MOCK_ADAPTER_SCENARIO: 'finished' });

    const code = await runWorker(env, buildDeps(h));

    expect(code).toBe(0);

    // Overlay step actually ran — the capability bundle's README.md is on
    // disk in the workspace.
    const overlaid = await readFile(join(h.workspaceDir, 'README.md'), 'utf-8');
    expect(overlaid).toBe('integration-test-marker\n');

    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toContain('dispatch.started');
    expect(kinds).toContain('dispatch.finished');
    expect(kinds).not.toContain('dispatch.failed');
    expect(kinds).not.toContain('dispatch.needs_input');
  });

  it('fails with reason: integrity-failed when a capability bundle hash does not match', async () => {
    const h = harness();
    // Mutate just the capability hash so the bytes-on-disk no longer match
    // the advertised digest. Subagent hash is left correct so this proves
    // the capability arm of the integrity check, not the subagent arm.
    const tamperedRefs: StagedRefs = {
      ...h.refs,
      capabilities: [
        {
          uri: h.refs.capabilities[0]!.uri,
          contentHash:
            'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        },
      ],
    };
    const env = buildEnv(h, tamperedRefs, {
      MOCK_ADAPTER_SCENARIO: 'finished',
    });

    const code = await runWorker(env, buildDeps(h));

    expect(code).not.toBe(0);
    const failed = h.events.find((e) => e.kind === 'dispatch.failed');
    expect(failed).toBeDefined();
    expect(failed && 'reason' in failed && failed.reason).toBe(
      'integrity-failed',
    );
    // dispatch.started fires before integrity check? No — per §6.2 the
    // bundle fetch + verify is step 3, started is step 5. So we expect
    // NO started event on this path.
    const kinds = h.events.map((e) => e.kind);
    expect(kinds).not.toContain('dispatch.started');
    expect(kinds).not.toContain('dispatch.finished');
  });

  itPosix(
    'fails with reason: worker-failed when pangolin-setup.sh exceeds the configured timeout',
    async () => {
      const h = harness();
      // Stage a capability bundle that overlays an pangolin-setup.sh that
      // sleeps longer than the configured timeout. With timeoutSeconds=1
      // and a 5-second sleep, the worker SIGKILLs the child and emits
      // `dispatch.failed` with reason 'worker-failed'.
      const sleepScript = new TextEncoder().encode(
        '#!/bin/bash\nsleep 5\n',
      );
      const slowCapFiles = {
        'pangolin-setup.sh': sleepScript,
        // Include README too so the bundle has the same file shape as
        // happy-path; not strictly required.
        'README.md': new TextEncoder().encode('slow\n'),
      };
      const slowCapBytes = packBundle('slow-cap', slowCapFiles);
      const { contentHash: slowCapHash } = await h.storage.put(
        'pangolin://ns/capability/slow-cap',
        slowCapBytes,
      );
      const slowCapUri = `pangolin://ns/capability/slow-cap/${slowCapHash}`;

      const slowRefs: StagedRefs = {
        ...h.refs,
        capabilities: [{ uri: slowCapUri, contentHash: slowCapHash }],
      };
      const env = buildEnv(h, slowRefs, {
        MOCK_ADAPTER_SCENARIO: 'finished',
        PANGOLIN_SETUP_TIMEOUT_SECONDS: '1',
      });

      const code = await runWorker(env, buildDeps(h));

      expect(code).not.toBe(0);
      const failed = h.events.find((e) => e.kind === 'dispatch.failed');
      expect(failed).toBeDefined();
      expect(failed && 'reason' in failed && failed.reason).toBe(
        'worker-failed',
      );
    },
    15_000, // generous test timeout: 1s setup-timeout + 5s sleep + overhead
  );

  it('produces dispatch.needs_input when the mock adapter reports a valid sentinel', async () => {
    const h = harness();
    const env = buildEnv(h, undefined, {
      MOCK_ADAPTER_SCENARIO: 'needs-input-valid',
    });

    const code = await runWorker(env, buildDeps(h));

    expect(code).toBe(0);
    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toContain('dispatch.started');
    expect(kinds).toContain('dispatch.needs_input');
    expect(kinds).not.toContain('dispatch.finished');
    expect(kinds).not.toContain('dispatch.failed');
  });

  it('fails with worker-failed when the sentinel is malformed JSON', async () => {
    const h = harness();
    const env = buildEnv(h, undefined, {
      MOCK_ADAPTER_SCENARIO: 'needs-input-malformed',
    });

    const code = await runWorker(env, buildDeps(h));

    expect(code).not.toBe(0);
    const failed = h.events.find((e) => e.kind === 'dispatch.failed');
    expect(failed).toBeDefined();
    expect(failed && 'reason' in failed && failed.reason).toBe(
      'worker-failed',
    );
  });

  it('fails with worker-failed when partial_state exceeds 1 MiB', async () => {
    const h = harness();
    const env = buildEnv(h, undefined, {
      MOCK_ADAPTER_SCENARIO: 'needs-input-oversized',
    });

    const code = await runWorker(env, buildDeps(h));

    expect(code).not.toBe(0);
    const failed = h.events.find((e) => e.kind === 'dispatch.failed');
    expect(failed).toBeDefined();
    expect(failed && 'reason' in failed && failed.reason).toBe(
      'worker-failed',
    );
    // The needs_input event must NOT have been emitted — oversized is a
    // failure outcome, not a deferred-input outcome.
    const kinds = h.events.map((e) => e.kind);
    expect(kinds).not.toContain('dispatch.needs_input');
  });
});
