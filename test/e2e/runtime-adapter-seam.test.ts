// E2E: RuntimeAdapter seam smoke test (spec §9).
//
// This test is the "load-bearing" proof that the worker is genuinely
// runtime-agnostic: it boots the full 14-step lifecycle through `runWorker`
// against a `MockRuntimeAdapter` that imports ONLY Node built-ins. If the
// lifecycle completes with exit code 0 — and the on-disk adapter source has
// zero Claude Code imports — the worker has no compile-time bind to any
// specific runtime.
//
// DAG 2's `task-worker-tests` already covered the seam property via direct
// `runWorker` injection of a pre-built adapter. This E2E exercises the same
// property via the full pipeline: a real `LocalStorageProvider`, the
// mock adapter loaded through the standard `<adaptersRoot>/<name>/index.js`
// discovery path, and a fixed `RuntimeExit` surfaced as `dispatch.finished`.
//
// No Docker, no AWS, no network. Just a tmp filesystem and a mock adapter.

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

// Relative imports to package sources — the root vitest runner has no
// workspace-package symlinks at `<repo>/node_modules`, so we go directly to
// the source-tree barrels. Vitest transparently transpiles the `.ts` files
// resolved by the `.js`-suffixed NodeNext import specifiers used inside the
// worker source tree.
import { runWorker } from '../../packages/agora-worker/src/index.js';
import type { RunWorkerDeps } from '../../packages/agora-worker/src/entrypoint.js';
import { LocalStorageProvider } from '../../packages/agora-storage-local/src/index.js';
import {
  computeContentHash,
  type LifecycleEvent,
} from '../../packages/agora-core/src/index.js';

// ---------------------------------------------------------------------------
// Helpers — bundle packing + URI assembly (mirror of agora-client's wire
// format; the worker's `unpackBundle` is the inverse).
// ---------------------------------------------------------------------------

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
// Mock adapter source. CRITICAL property of this test: the file must import
// ONLY Node built-ins. The acceptance criterion asserts this via grep on the
// written file's contents — if a future edit accidentally pulls in an
// `@quarry-systems/agora-runtime-claude-code` import, the test fails.
// ---------------------------------------------------------------------------

const MOCK_ADAPTER_SOURCE = `
export default () => ({
  name: 'mock',
  reservedPaths: [],
  invoke: async () => ({
    exitCode: 0,
    stdout: 'mock ran without Claude Code',
    stderr: '',
  }),
});
`;

let adaptersRoot: string;
let storageRoot: string;
let workspaceDir: string;
let storage: LocalStorageProvider;
let events: LifecycleEvent[];

beforeEach(async () => {
  adaptersRoot = await mkdtemp(join(tmpdir(), 'e2e-adapter-root-'));
  storageRoot = await mkdtemp(join(tmpdir(), 'e2e-adapter-storage-'));
  workspaceDir = await mkdtemp(join(tmpdir(), 'e2e-adapter-work-'));
  events = [];

  // Install the mock adapter at the canonical discovery path. The
  // adapter-loader's `pathToFileURL().href` import requires ESM.
  await mkdir(join(adaptersRoot, 'mock'), { recursive: true });
  await writeFile(
    join(adaptersRoot, 'mock', 'index.js'),
    MOCK_ADAPTER_SOURCE,
    'utf-8',
  );

  storage = new LocalStorageProvider({ rootDir: storageRoot });
});

afterEach(async () => {
  await rm(adaptersRoot, { recursive: true, force: true });
  await rm(storageRoot, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

describe('E2E: RuntimeAdapter seam smoke test', () => {
  it('worker completes the full 14-step lifecycle against a mock adapter (no Claude Code involvement)', async () => {
    // Stage a subagent definition. The URI's content hash addresses the raw
    // bytes on disk; the bundleRef's `contentHash` is the canonical-JSON
    // hash of the parsed object (which the bundle-fetcher recomputes via
    // `verifyContentHash`). These differ whenever JSON.stringify's key order
    // does not match alphabetical, which is the common case.
    const subagentDef = {
      name: 'alpha',
      systemPrompt: 'do the thing',
      promptTemplate: 'say hi to {{name}}',
      model: 'mock-model-1',
    };
    const subagentBytes = jsonBytes(subagentDef);
    const { contentHash: subagentByteHash } = await storage.put(
      'agora://ns/subagent/alpha',
      subagentBytes,
    );
    const subagentCanonicalHash = computeContentHash(subagentDef);
    const subagentUri = `agora://ns/subagent/alpha/${subagentByteHash}`;

    // Capability bundle with a single marker file — the overlay step will
    // copy this into `workspaceDir` and we read it back below to prove the
    // overlay actually ran (one more witness for the full lifecycle).
    //
    // Capability bundles are hashed by raw bytes in the bundle-fetcher (the
    // bundle blob is opaque to canonicalization), so the URI's byte-hash
    // and the bundleRef's `contentHash` are the same value.
    const capFiles = {
      'README.md': new TextEncoder().encode('e2e-mock-adapter-marker\n'),
    };
    const capBytes = packBundle('cap-a', capFiles);
    const { contentHash: capByteHash } = await storage.put(
      'agora://ns/capability/cap-a',
      capBytes,
    );
    const capUri = `agora://ns/capability/cap-a/${capByteHash}`;

    // Env bundle exercises step 7 (resolve env-bundle secrets) and step 8
    // (merge env). No secretRefs => no Secrets Manager calls.
    const envDef = {
      name: 'env-a',
      values: { E2E_MOCK_MARKER: 'from-env-bundle' },
    };
    const envBytes = jsonBytes(envDef);
    const { contentHash: envByteHash } = await storage.put(
      'agora://ns/env/env-a',
      envBytes,
    );
    const envCanonicalHash = computeContentHash(envDef);
    const envUri = `agora://ns/env/env-a/${envByteHash}`;

    const bundleRefs = {
      subagent: { uri: subagentUri, contentHash: subagentCanonicalHash },
      capabilities: [{ uri: capUri, contentHash: capByteHash }],
      env: [{ uri: envUri, contentHash: envCanonicalHash }],
    };

    const env: Record<string, string> = {
      AGORA_DISPATCH_ID: 'd-e2e-adapter-seam',
      AGORA_NAMESPACE: 'ns',
      AGORA_STORAGE_URI: `file://${storageRoot}`,
      AGORA_BUNDLE_REFS_JSON: JSON.stringify(bundleRefs),
      AGORA_INPUT_JSON: JSON.stringify({ name: 'world' }),
      AGORA_RUNTIME_ADAPTER: 'mock',
    };

    const deps: RunWorkerDeps = {
      storage,
      adaptersRoot,
      workspaceDir,
      // No callback URL is set, so the SecretsManagerClient is never used;
      // we still stub it to shield the test from real AWS SDK boot cost.
      secretsManagerClient: {
        send: async () => ({ SecretString: 'unused' }),
      } as never,
      onLifecycleEvent: (e: LifecycleEvent) => {
        events.push(e);
      },
    };

    const code = await runWorker(env, deps);

    // The mock adapter returns `exitCode: 0`, so the worker fires
    // `dispatch.finished` and exits 0. Any failure path (integrity, fetch,
    // setup, sentinel) would have produced a non-zero exit.
    expect(code).toBe(0);

    // Overlay step (step 6) actually ran — the capability bundle's README.md
    // landed on disk in the workspace.
    const overlaid = await readFile(join(workspaceDir, 'README.md'), 'utf-8');
    expect(overlaid).toBe('e2e-mock-adapter-marker\n');

    // Full 14-step lifecycle witnessed by event ordering: started fires at
    // step 5, finished fires at step 14.
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('dispatch.started');
    expect(kinds).toContain('dispatch.finished');
    expect(kinds).not.toContain('dispatch.failed');
    expect(kinds).not.toContain('dispatch.needs_input');

    // Seam contract: the mock adapter source on disk imports ONLY Node
    // built-ins. If a future edit accidentally pulls in
    // `@quarry-systems/agora-runtime-claude-code` (or any non-Node import),
    // this test fails — proving the worker doesn't bind to Claude Code at
    // compile time.
    const adapterSource = await readFile(
      join(adaptersRoot, 'mock', 'index.js'),
      'utf-8',
    );
    // No package-style imports allowed: no `from '@scope/pkg'`, no
    // `from 'bare-pkg'`. Built-in `node:` specifiers are fine.
    const importLines = adapterSource
      .split(/\r?\n/)
      .filter((l) => /^\s*import\b/.test(l) || /\bfrom\s+['"]/.test(l));
    for (const line of importLines) {
      const match = line.match(/from\s+['"]([^'"]+)['"]/);
      if (!match) continue;
      const specifier = match[1]!;
      // Allowed: bare `node:*` built-ins or relative paths starting with `.`.
      const isNodeBuiltin = specifier.startsWith('node:');
      const isRelative = specifier.startsWith('.') || specifier.startsWith('/');
      expect(
        isNodeBuiltin || isRelative,
        `mock adapter must import only Node built-ins or relative paths, got: ${specifier}`,
      ).toBe(true);
      // Belt-and-suspenders: explicitly forbid the Claude Code adapter.
      expect(specifier).not.toContain('agora-runtime-claude-code');
    }
  }, 60_000);
});
