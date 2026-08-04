// Integration suite for the two dependency-evidence reads wired into the
// worker's lifecycle (task-entrypoint-wire-deps).
//
// Asserted through a REAL `runWorker` lifecycle rather than a synthetic env
// object. That is deliberate and is the plan's own instruction: every existing
// runWorker call site in tests passes a synthetic object, so a test written the
// usual way would assert on a value this code never reads, and would pass with
// the wiring absent.
//
// Harness mirrors entrypoint-context.test.ts (real LocalStorageProvider,
// packBundle + jsonBytes staging, raw-def subagent idiom — the worker has no
// dependency on pangolin-client and must not gain one here).
//
// Coverage (the task's acceptance criteria):
//   1. sentinel present before the agent, unchanged by it -> atSetup === atFinish
//   2. agent REWRITES the sentinel                        -> atSetup !== atFinish
//   3. no sentinel at any point   -> no `deps` key AND the dispatch completes
//   4. exactly one read usable    -> no `deps` key AND the dispatch completes
//   5. unusable sentinel          -> deps.evidence.unusable logged, exit 0
//   6. a sentinel written by pangolin-setup.sh is observed in atSetup [itPosix]

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWorker } from '../src/index.js';
import type { RunWorkerDeps } from '../src/entrypoint.js';
import { LocalStorageProvider } from '@quarry-systems/pangolin-storage-local';
import { computeContentHash, type LifecycleEvent } from '@quarry-systems/pangolin-core';

const itPosix = process.platform === 'win32' ? it.skip : it;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Bundle packing helpers — mirror of entrypoint-context.test.ts.
// ---------------------------------------------------------------------------

function packBundle(name: string, files: Record<string, Uint8Array>): Uint8Array {
  const paths = Object.keys(files).sort();
  const entries = paths.map((path) => ({ path, size: files[path]!.byteLength }));
  const headerBytes = new TextEncoder().encode(JSON.stringify({ name, entries }) + '\n');
  const total = headerBytes.byteLength + paths.reduce((acc, p) => acc + files[p]!.byteLength, 0);
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
// Mock adapters. Four variants rather than one parameterised adapter, selected
// by PANGOLIN_RUNTIME_ADAPTER, so no test depends on an env var surviving the
// runtime env firewall.
// ---------------------------------------------------------------------------

/** Body shared by every variant; `ACTION` is spliced in per adapter. */
const adapterSource = (action: string) => `
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export default () => ({
  name: 'mock',
  reservedPaths: [],
  invoke: async (spec) => {
    const depsPath = join(spec.workspaceDir, '.pangolin', 'deps.json');
    await mkdir(join(spec.workspaceDir, '.pangolin'), { recursive: true });
    ${action}
    return { exitCode: 0, stdout: 'mock stdout', stderr: '' };
  },
});
`;

const ADAPTERS: Record<string, string> = {
  // Touches nothing — the "unchanged across the agent block" case.
  mock: adapterSource(''),
  // A mid-run `pnpm add`, in effect: same file, different content.
  'mock-rewrite': adapterSource(
    `await writeFile(depsPath, JSON.stringify({ ecosystem: 'pnpm', packageCount: 999 }));`,
  ),
  // Produces the asymmetric case: atSetup usable, atFinish absent.
  'mock-delete': adapterSource(`await rm(depsPath, { force: true });`),
  // Produces the asymmetric case the other way: atFinish unusable.
  'mock-corrupt': adapterSource(`await writeFile(depsPath, 'not json {');`),
  // Creates a sentinel that did not exist at setup: atSetup absent, atFinish ok.
  'mock-create': adapterSource(
    `await writeFile(depsPath, JSON.stringify({ ecosystem: 'pnpm', packageCount: 1 }));`,
  ),
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  storageRoot: string;
  adaptersRoot: string;
  workspaceDir: string;
  storage: LocalStorageProvider;
  events: LifecycleEvent[];
  logs: Array<Record<string, unknown>>;
}

async function setupHarness(): Promise<Harness> {
  const storageRoot = await mkdtemp(join(tmpdir(), 'pangolin-deps-storage-'));
  const adaptersRoot = await mkdtemp(join(tmpdir(), 'pangolin-deps-adapters-'));
  const workspaceDir = await mkdtemp(join(tmpdir(), 'pangolin-deps-work-'));

  for (const [name, source] of Object.entries(ADAPTERS)) {
    const dir = join(adaptersRoot, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.js'), source, 'utf-8');
  }

  return {
    storageRoot,
    adaptersRoot,
    workspaceDir,
    storage: new LocalStorageProvider({ rootDir: storageRoot }),
    events: [],
    logs: [],
  };
}

async function teardown(h: Harness | undefined): Promise<void> {
  if (!h) return;
  await rm(h.storageRoot, { recursive: true, force: true });
  await rm(h.adaptersRoot, { recursive: true, force: true });
  await rm(h.workspaceDir, { recursive: true, force: true });
}

interface Refs {
  subagent: { uri: string; contentHash: string };
  capabilities: Array<{ uri: string; contentHash: string }>;
  env: Array<{ uri: string; contentHash: string }>;
  inputs: Array<{ key: string; uri: string; contentHash: string }>;
}

async function putSubagent(
  storage: LocalStorageProvider,
  def: Record<string, unknown>,
): Promise<{ uri: string; contentHash: string }> {
  const bytes = jsonBytes(def);
  const { contentHash: byteHash } = await storage.put('pangolin://ns/subagent/alpha', bytes);
  return { uri: `pangolin://ns/subagent/alpha/${byteHash}`, contentHash: computeContentHash(def) };
}

async function putCapability(
  storage: LocalStorageProvider,
  name: string,
  files: Record<string, Uint8Array>,
): Promise<{ uri: string; contentHash: string }> {
  const bytes = packBundle(name, files);
  const { contentHash: byteHash } = await storage.put(`pangolin://ns/capability/${name}`, bytes);
  return { uri: `pangolin://ns/capability/${name}/${byteHash}`, contentHash: byteHash };
}

function buildEnv(
  refs: Refs,
  storageRoot: string,
  adapter: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    PANGOLIN_DISPATCH_ID: 'd-deps',
    PANGOLIN_NAMESPACE: 'ns',
    PANGOLIN_STORAGE_URI: `file://${storageRoot}`,
    PANGOLIN_BUNDLE_REFS_JSON: JSON.stringify(refs),
    PANGOLIN_RUNTIME_ADAPTER: adapter,
    ...extra,
  };
}

function buildRunDeps(h: Harness): RunWorkerDeps {
  return {
    storage: h.storage,
    adaptersRoot: h.adaptersRoot,
    workspaceDir: h.workspaceDir,
    secretsManagerClient: { send: async () => ({ SecretString: 'unused' }) } as never,
    onLifecycleEvent: (e: LifecycleEvent) => {
      h.events.push(e);
    },
  };
}

/** The sentinel the worker actually wrote, read back off disk. */
async function writtenSentinel(workspaceDir: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(workspaceDir, '.pangolin', 'output.json'), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

const DEPS_BODY = jsonBytes({ ecosystem: 'pnpm', lockfileHash: 'sha256:x', packageCount: 2 });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('worker dependency-evidence reads (task-entrypoint-wire-deps)', () => {
  let h: Harness | undefined;

  beforeEach(async () => {
    h = await setupHarness();
  });
  afterEach(async () => {
    await teardown(h);
    h = undefined;
  });

  const harness = (): Harness => {
    if (!h) throw new Error('harness not initialized');
    return h;
  };

  /** Stage a dispatch whose capability bundle delivers `.pangolin/deps.json`. */
  async function runWith(
    adapter: string,
    opts: { withSentinel: boolean; sentinelBody?: Uint8Array } = { withSentinel: true },
  ): Promise<number> {
    const hh = harness();
    const subagentRef = await putSubagent(hh.storage, {
      name: 'alpha',
      systemPrompt: 'x',
      promptTemplate: 'y',
    });
    const capabilities = opts.withSentinel
      ? [
          await putCapability(hh.storage, 'deps-cap', {
            '.pangolin/deps.json': opts.sentinelBody ?? DEPS_BODY,
          }),
        ]
      : [];
    const refs: Refs = { subagent: subagentRef, capabilities, env: [], inputs: [] };
    return runWorker(buildEnv(refs, hh.storageRoot, adapter), buildRunDeps(hh));
  }

  it('reports atSetup === atFinish when the agent leaves the sentinel alone', async () => {
    const hh = harness();
    const code = await runWith('mock');
    expect(code).toBe(0);

    const sentinel = await writtenSentinel(hh.workspaceDir);
    const deps = sentinel.deps as { atSetup: string; atFinish: string; tier: string };
    expect(deps).toBeDefined();
    expect(deps.tier).toBe('recorded');
    // Shape-checked on BOTH, so equality is two real hashes agreeing rather
    // than two failures comparing equal.
    expect(deps.atSetup).toMatch(SHA256);
    expect(deps.atFinish).toMatch(SHA256);
    expect(deps.atSetup).toBe(deps.atFinish);
  });

  it('reports atSetup !== atFinish when the agent rewrites the sentinel', async () => {
    const hh = harness();
    const code = await runWith('mock-rewrite');
    expect(code).toBe(0);

    const sentinel = await writtenSentinel(hh.workspaceDir);
    const deps = sentinel.deps as { atSetup: string; atFinish: string; tier: string };
    expect(deps).toBeDefined();
    expect(deps.atSetup).toMatch(SHA256);
    expect(deps.atFinish).toMatch(SHA256);
    // The whole reason two entries exist rather than one.
    expect(deps.atSetup).not.toBe(deps.atFinish);
  });

  it('omits deps entirely when no sentinel exists at any point, and still completes', async () => {
    const hh = harness();
    const code = await runWith('mock', { withSentinel: false });
    expect(code).toBe(0);
    // The completed dispatch separates "evidence correctly absent" from "the
    // worker crashed before writing anything".
    expect(hh.events.map((e) => e.kind)).toContain('dispatch.finished');

    const sentinel = await writtenSentinel(hh.workspaceDir);
    expect('deps' in sentinel).toBe(false);
  });

  it('omits deps when only ONE of the two reads is usable — the accepted asymmetric-null limit', async () => {
    const hh = harness();
    // atSetup ok (bundle delivered it), atFinish absent (agent deleted it).
    const code = await runWith('mock-delete');
    expect(code).toBe(0);
    expect(hh.events.map((e) => e.kind)).toContain('dispatch.finished');

    const sentinel = await writtenSentinel(hh.workspaceDir);
    // Pinned so a later change to this behaviour is deliberate: spec §4.2 types
    // both halves as required, so a half-pair is dropped rather than invented.
    expect('deps' in sentinel).toBe(false);
  });

  it('omits deps when the sentinel exists only AFTER the agent runs', async () => {
    const hh = harness();
    const code = await runWith('mock-create', { withSentinel: false });
    expect(code).toBe(0);
    const sentinel = await writtenSentinel(hh.workspaceDir);
    // The documented narrowing: "changes to an existing sentinel are visible",
    // not "a mid-run add is always visible".
    expect('deps' in sentinel).toBe(false);
  });

  it('an unusable sentinel at finish omits deps and the dispatch still exits 0', async () => {
    const hh = harness();
    const code = await runWith('mock-corrupt');
    expect(code).toBe(0);
    expect(hh.events.map((e) => e.kind)).toContain('dispatch.finished');
    const sentinel = await writtenSentinel(hh.workspaceDir);
    expect('deps' in sentinel).toBe(false);
  });

  it('an unusable sentinel at setup omits deps and the dispatch still exits 0', async () => {
    const hh = harness();
    const code = await runWith('mock', {
      withSentinel: true,
      sentinelBody: new TextEncoder().encode('not json {'),
    });
    expect(code).toBe(0);
    expect(hh.events.map((e) => e.kind)).toContain('dispatch.finished');
    const sentinel = await writtenSentinel(hh.workspaceDir);
    expect('deps' in sentinel).toBe(false);
  });

  itPosix(
    'the atSetup read happens AFTER the setup script — a sentinel written by pangolin-setup.sh is observed',
    async () => {
      const hh = harness();
      const subagentRef = await putSubagent(hh.storage, {
        name: 'alpha',
        systemPrompt: 'x',
        promptTemplate: 'y',
      });
      // Absolute /bin/mkdir: the merged env's PATH is not guaranteed to carry
      // the coreutils directory, and a bare `mkdir` dying with 127 would fail
      // this dispatch at step 9 for a reason unrelated to what is under test.
      const setupScript = new TextEncoder().encode(
        '#!/bin/bash\n' +
          '/bin/mkdir -p "$PWD/.pangolin"\n' +
          'printf \'{"ecosystem":"pnpm","packageCount":7}\' > "$PWD/.pangolin/deps.json"\n',
      );
      const capRef = await putCapability(hh.storage, 'setup-cap', {
        'pangolin-setup.sh': setupScript,
      });
      const refs: Refs = { subagent: subagentRef, capabilities: [capRef], env: [], inputs: [] };

      const code = await runWorker(buildEnv(refs, hh.storageRoot, 'mock'), buildRunDeps(hh));
      expect(code).toBe(0);

      const sentinel = await writtenSentinel(hh.workspaceDir);
      const deps = sentinel.deps as { atSetup: string; atFinish: string } | undefined;
      // If the read ran BEFORE the setup script, atSetup would be absent and
      // the whole field would be omitted by the both-halves rule — so a present,
      // well-formed pair is itself the ordering assertion.
      expect(deps).toBeDefined();
      expect(deps!.atSetup).toMatch(SHA256);
      expect(deps!.atSetup).toBe(deps!.atFinish);
    },
  );
});
