// Integration suite for the context-requirements gate wired into the worker's
// 14-step lifecycle (task-entrypoint-check-wire).
//
// Mirrors `integration.test.ts`: real `LocalStorageProvider`, the `itPosix`
// gate, `packBundle` + `jsonBytes` staging. The subagent def is staged with
// the raw-def idiom (storage.put + hand-built refs) rather than through
// `pangolin-client` — the worker has no dependency on that package and must
// not gain one here.
//
// Coverage (from the DAG-plan task's acceptance criteria):
//   1. exec unmet -> dispatch.failed (reason on the lifecycle event, detail
//      naming the bin on stdout), adapter never invoked            [POSIX-agnostic]
//   2. same subagent succeeds once pangolin-setup.sh installs the binary into
//      $HOME and an env bundle puts it on PATH -> dispatch.finished, adapter
//      invoked exactly once                                        [itPosix]
//   3. paths requirement met by a file delivered in a capability bundle
//   4. paths requirement met by a file materialized at inputs/<key>
//   5. git needs:'worktree' ordering pin — fails against a workspace with no
//      .git, because the check runs BEFORE captureBaseline's `git init`
//   6. git needs:'history' met when the capability bundle carries a .git with
//      a real commit
//   7. no contextRequires at all -> completes exactly as today

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWorker } from '../src/index.js';
import type { RunWorkerDeps } from '../src/entrypoint.js';
import { LocalStorageProvider } from '@quarry-systems/pangolin-storage-local';
import { computeContentHash, type LifecycleEvent } from '@quarry-systems/pangolin-core';

// Node's child_process can't spawn POSIX shells on Windows — same gate as
// `test/setup-script.test.ts:30`. Only the test that runs pangolin-setup.sh
// needs this; the git-backed tests spawn `git` directly, which works on both.
const itPosix = process.platform === 'win32' ? it.skip : it;

// ---------------------------------------------------------------------------
// Bundle packing helpers — mirror of integration.test.ts.
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
// Mock adapter — written to <adaptersRoot>/mock/index.js as ESM.
//
// Records an invocation by dropping a uniquely-named, empty marker file under
// `<workspaceDir>/.pangolin/invocations/` rather than embedding a newline
// inside a nested string literal (this constant is code-as-text, so `\n`
// written directly here would be escape-processed by the OUTER template
// literal at TS-parse time, not preserved as literal backslash-n text for the
// generated module). Counting directory entries sidesteps that entirely.
// ---------------------------------------------------------------------------

const MOCK_ADAPTER_SOURCE = `
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export default () => ({
  name: 'mock',
  reservedPaths: [],
  invoke: async (spec) => {
    const dir = join(spec.workspaceDir, '.pangolin', 'invocations');
    await mkdir(dir, { recursive: true });
    const marker = String(Date.now()) + '-' + Math.random();
    await writeFile(join(dir, marker), 'invoked');
    return { exitCode: 0, stdout: 'mock stdout', stderr: '' };
  },
});
`;

async function invocationCount(workspaceDir: string): Promise<number> {
  try {
    const entries = await readdir(join(workspaceDir, '.pangolin', 'invocations'));
    return entries.length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// git helper — real `git` spawned test-side to stage a committed repo whose
// `.git/` tree is packed into a capability bundle. Not itPosix-gated: git
// itself runs fine on Windows (context-check.test.ts's `execGit` does the
// same, ungated); only /bin/bash spawning needs the gate.
// ---------------------------------------------------------------------------

function execGitTest(dir: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [
      '-C',
      dir,
      '-c',
      'safe.directory=*',
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=test',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ]);
    const err: Buffer[] = [];
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`git ${args.join(' ')} exited ${code}: ${Buffer.concat(err)}`)),
    );
  });
}

/** Recursively collect every regular file under `baseDir` into a
 *  `<prefix>/<relPath>` -> bytes map, for packing a real `.git` tree into a
 *  capability bundle. Symlinks are skipped (none in a plain init+commit). */
async function collectFilesRecursive(
  baseDir: string,
  prefix: string,
): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  async function walk(dir: string, relPrefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        out[`${prefix}/${rel}`] = new Uint8Array(await readFile(full));
      }
    }
  }
  await walk(baseDir, '');
  return out;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  storageRoot: string;
  adaptersRoot: string;
  workspaceDir: string;
  storage: LocalStorageProvider;
  events: LifecycleEvent[];
}

async function setupHarness(): Promise<Harness> {
  const storageRoot = await mkdtemp(join(tmpdir(), 'pangolin-ctx-storage-'));
  const adaptersRoot = await mkdtemp(join(tmpdir(), 'pangolin-ctx-adapters-'));
  const workspaceDir = await mkdtemp(join(tmpdir(), 'pangolin-ctx-work-'));

  const adapterDir = join(adaptersRoot, 'mock');
  await mkdir(adapterDir, { recursive: true });
  await writeFile(join(adapterDir, 'index.js'), MOCK_ADAPTER_SOURCE, 'utf-8');

  const storage = new LocalStorageProvider({ rootDir: storageRoot });

  return { storageRoot, adaptersRoot, workspaceDir, storage, events: [] };
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
  return {
    uri: `pangolin://ns/subagent/alpha/${byteHash}`,
    contentHash: computeContentHash(def),
  };
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

async function putEnvBundle(
  storage: LocalStorageProvider,
  name: string,
  def: Record<string, unknown>,
): Promise<{ uri: string; contentHash: string }> {
  const bytes = jsonBytes(def);
  const { contentHash: byteHash } = await storage.put(`pangolin://ns/env/${name}`, bytes);
  return { uri: `pangolin://ns/env/${name}/${byteHash}`, contentHash: computeContentHash(def) };
}

async function putInput(
  storage: LocalStorageProvider,
  key: string,
  bytes: Uint8Array,
): Promise<{ key: string; uri: string; contentHash: string }> {
  const { contentHash: byteHash } = await storage.put(`pangolin://ns/input/${key}`, bytes);
  return { key, uri: `pangolin://ns/input/${key}/${byteHash}`, contentHash: byteHash };
}

function buildEnv(
  refs: Refs,
  storageRoot: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    PANGOLIN_DISPATCH_ID: 'd-ctx-check',
    PANGOLIN_NAMESPACE: 'ns',
    PANGOLIN_STORAGE_URI: `file://${storageRoot}`,
    PANGOLIN_BUNDLE_REFS_JSON: JSON.stringify(refs),
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

describe('worker context-requirements gate (task-entrypoint-check-wire)', () => {
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

  it('fails with reason worker-failed when {kind:exec,bin:pnpm} is unresolvable, detail on stdout names it, adapter never invoked', async () => {
    const h = harness();
    const emptyPathDir = await mkdtemp(join(tmpdir(), 'pangolin-ctx-emptypath-'));

    const subagentRef = await putSubagent(h.storage, {
      name: 'alpha',
      systemPrompt: 'x',
      promptTemplate: 'y',
      contextRequires: [{ kind: 'exec', bin: 'pnpm' }],
    });
    const refs: Refs = { subagent: subagentRef, capabilities: [], env: [], inputs: [] };
    const env = buildEnv(refs, h.storageRoot, { PATH: emptyPathDir });

    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
        return true;
      });

    let code: number;
    try {
      code = await runWorker(env, buildDeps(h));
    } finally {
      spy.mockRestore();
    }

    expect(code).not.toBe(0);

    // `reason` lives on the lifecycle event, `detail` deliberately does not
    // (entrypoint.ts:230-235) — asserted on two different surfaces.
    const failed = h.events.find((e) => e.kind === 'dispatch.failed');
    expect(failed).toBeDefined();
    expect(failed && 'reason' in failed && failed.reason).toBe('worker-failed');
    expect(failed).not.toHaveProperty('detail');

    const stdout = writes.join('');
    expect(stdout).toContain('pnpm');

    expect(await invocationCount(h.workspaceDir)).toBe(0);

    await rm(emptyPathDir, { recursive: true, force: true });
  });

  itPosix(
    'succeeds when pangolin-setup.sh installs pnpm into $HOME and an env bundle puts it on PATH, adapter invoked exactly once',
    async () => {
      const h = harness();
      const homeDir = await mkdtemp(join(tmpdir(), 'pangolin-ctx-home-'));

      const subagentRef = await putSubagent(h.storage, {
        name: 'alpha',
        systemPrompt: 'x',
        promptTemplate: 'y',
        contextRequires: [{ kind: 'exec', bin: 'pnpm' }],
      });

      const setupScript = new TextEncoder().encode(
        '#!/bin/bash\nmkdir -p "$HOME/bin"\nprintf \'#!/bin/bash\\necho stub\\n\' > "$HOME/bin/pnpm"\nchmod +x "$HOME/bin/pnpm"\n',
      );
      const capRef = await putCapability(h.storage, 'setup-cap', {
        'pangolin-setup.sh': setupScript,
      });

      const envBundleRef = await putEnvBundle(h.storage, 'path-env', {
        values: { PATH: join(homeDir, 'bin') },
      });

      const refs: Refs = {
        subagent: subagentRef,
        capabilities: [capRef],
        env: [envBundleRef],
        inputs: [],
      };
      // PATH set on the outer env deliberately points nowhere useful — the
      // positive control must come from the setup script + env bundle, not
      // from the worker's own inherited PATH already riding in mergedEnv.
      const env = buildEnv(refs, h.storageRoot, { HOME: homeDir, PATH: '/nonexistent' });

      const code = await runWorker(env, buildDeps(h));

      expect(code).toBe(0);
      const kinds = h.events.map((e) => e.kind);
      expect(kinds).toContain('dispatch.finished');
      expect(kinds).not.toContain('dispatch.failed');
      expect(await invocationCount(h.workspaceDir)).toBe(1);

      await rm(homeDir, { recursive: true, force: true });
    },
  );

  it('paths requirement is met by a file delivered in a capability bundle — binds to the real staged workspace', async () => {
    const h = harness();

    const subagentRef = await putSubagent(h.storage, {
      name: 'alpha',
      systemPrompt: 'x',
      promptTemplate: 'y',
      contextRequires: [{ kind: 'paths', glob: 'proof/marker.txt', minCount: 1 }],
    });
    const capRef = await putCapability(h.storage, 'proof-cap', {
      'proof/marker.txt': new TextEncoder().encode('capability-marker\n'),
    });
    const refs: Refs = { subagent: subagentRef, capabilities: [capRef], env: [], inputs: [] };
    const env = buildEnv(refs, h.storageRoot);

    const code = await runWorker(env, buildDeps(h));

    expect(code).toBe(0);
    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toContain('dispatch.finished');
    expect(kinds).not.toContain('dispatch.failed');

    // The file really landed in the mkdtemp'd workspaceDir, not somewhere else.
    const content = await readFile(join(h.workspaceDir, 'proof', 'marker.txt'), 'utf-8');
    expect(content).toBe('capability-marker\n');
  });

  it('paths requirement is met by a file materialized at inputs/<key> from an inputRef — binds to the real staged workspace', async () => {
    const h = harness();

    const subagentRef = await putSubagent(h.storage, {
      name: 'alpha',
      systemPrompt: 'x',
      promptTemplate: 'y',
      contextRequires: [{ kind: 'paths', glob: 'inputs/proof-input', minCount: 1 }],
    });
    const inputRef = await putInput(
      h.storage,
      'proof-input',
      new TextEncoder().encode('input-marker'),
    );
    const refs: Refs = {
      subagent: subagentRef,
      capabilities: [],
      env: [],
      inputs: [inputRef],
    };
    const env = buildEnv(refs, h.storageRoot);

    const code = await runWorker(env, buildDeps(h));

    expect(code).toBe(0);
    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toContain('dispatch.finished');
    expect(kinds).not.toContain('dispatch.failed');

    const content = await readFile(join(h.workspaceDir, 'inputs', 'proof-input'), 'utf-8');
    expect(content).toBe('input-marker');
  });

  it("ordering pin: {kind:git,needs:worktree} fails against a workspace with NO .git, because the check runs before captureBaseline's git init", async () => {
    const h = harness();

    const subagentRef = await putSubagent(h.storage, {
      name: 'alpha',
      systemPrompt: 'x',
      promptTemplate: 'y',
      contextRequires: [{ kind: 'git', needs: 'worktree' }],
    });
    // Deliberately no capability bundle at all — the workspace has no .git
    // of any kind (no bundle-carried one, and captureBaseline never gets a
    // chance to run its own `git init` before this check does).
    const refs: Refs = { subagent: subagentRef, capabilities: [], env: [], inputs: [] };
    const env = buildEnv(refs, h.storageRoot, { PATH: process.env.PATH ?? '' });

    const code = await runWorker(env, buildDeps(h));

    expect(code).not.toBe(0);
    const failed = h.events.find((e) => e.kind === 'dispatch.failed');
    expect(failed).toBeDefined();
    expect(failed && 'reason' in failed && failed.reason).toBe('worker-failed');
    // If the check had instead run AFTER captureBaseline's `git init`,
    // 'worktree' would read met:true and the adapter WOULD have been
    // invoked — this is the pin.
    expect(await invocationCount(h.workspaceDir)).toBe(0);
  });

  it("git needs:'history' is met when the capability bundle carries a .git with a real commit — in its own workspace, separate from the ordering-pin test", async () => {
    const h = harness();
    const srcRepo = await mkdtemp(join(tmpdir(), 'pangolin-ctx-srcrepo-'));
    await execGitTest(srcRepo, ['init', '-q']);
    await writeFile(join(srcRepo, 'a.txt'), 'x');
    await execGitTest(srcRepo, ['add', '-A']);
    await execGitTest(srcRepo, ['commit', '-q', '-m', 'first']);

    const gitFiles = await collectFilesRecursive(join(srcRepo, '.git'), '.git');

    const subagentRef = await putSubagent(h.storage, {
      name: 'alpha',
      systemPrompt: 'x',
      promptTemplate: 'y',
      contextRequires: [{ kind: 'git', needs: 'history' }],
    });
    const capRef = await putCapability(h.storage, 'git-cap', gitFiles);
    const refs: Refs = { subagent: subagentRef, capabilities: [capRef], env: [], inputs: [] };
    const env = buildEnv(refs, h.storageRoot, { PATH: process.env.PATH ?? '' });

    const code = await runWorker(env, buildDeps(h));

    expect(code).toBe(0);
    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toContain('dispatch.finished');
    expect(kinds).not.toContain('dispatch.failed');

    await rm(srcRepo, { recursive: true, force: true });
  });

  it('a subagent with no contextRequires completes exactly as today', async () => {
    const h = harness();

    const subagentRef = await putSubagent(h.storage, {
      name: 'alpha',
      systemPrompt: 'x',
      promptTemplate: 'y',
    });
    const capRef = await putCapability(h.storage, 'plain-cap', {
      'README.md': new TextEncoder().encode('plain\n'),
    });
    const refs: Refs = { subagent: subagentRef, capabilities: [capRef], env: [], inputs: [] };
    const env = buildEnv(refs, h.storageRoot);

    const code = await runWorker(env, buildDeps(h));

    expect(code).toBe(0);
    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toContain('dispatch.started');
    expect(kinds).toContain('dispatch.finished');
    expect(kinds).not.toContain('dispatch.failed');
    expect(await invocationCount(h.workspaceDir)).toBe(1);
  });
});
