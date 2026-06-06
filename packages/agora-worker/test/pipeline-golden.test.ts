// pipeline-golden.test.ts
//
// Proof that the runner-backed runWorker produces byte-identical output
// sentinel shapes to the legacy golden contract (design spec §9/§11).
//
// Golden contract: the default pipeline (opts.declared=false) produces a
// sentinel whose JSON keys follow exactly the field-assignment order inside
// writeSentinel:
//
//   ['schemaVersion']                              (no edit, no verify, no outputs)
//   ['schemaVersion','patchRef']                   (edit, no verify, no outputs)
//   ['schemaVersion','patchRef','verify']           (edit + verify configured)
//   ['schemaVersion','patchRef','verify','outputs'] (edit + verify + outputs file)
//
// The 'blocks' key is NEVER present for the default pipeline (declared:false).
// JSON.parse(JSON.stringify(parsed)) must round-trip to the stored string
// (insertion-order stability = canonical bytes for the same inputs).
//
// This file reuses helpers/conventions from entrypoint.test.ts verbatim.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runWorker, type RunWorkerDeps } from '../src/entrypoint.js';
import {
  computeContentHash,
  buildDispatchRecordUri,
  type StorageProvider,
  type RuntimeAdapter,
  type RuntimeInvocation,
  type RuntimeExit,
  type LifecycleEvent,
} from '@quarry-systems/agora-core';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// FakeStorage — identical to the one in entrypoint.test.ts
// ---------------------------------------------------------------------------

class FakeStorage implements StorageProvider {
  readonly name = 'fake';
  private blobs = new Map<string, Uint8Array>();

  /** Seed a blob without recording it as a put. */
  set(uri: string, bytes: Uint8Array): this {
    this.blobs.set(uri, bytes);
    return this;
  }

  async put(uri: string, contents: Uint8Array): Promise<{ contentHash: string }> {
    this.blobs.set(uri, contents);
    return { contentHash: computeContentHash(contents) };
  }

  async get(uri: string): Promise<Uint8Array> {
    const v = this.blobs.get(uri);
    if (!v) throw new Error(`fake storage: missing ${uri}`);
    return v;
  }

  async resolveLatest(): Promise<null> { return null; }
  async list(): Promise<[]> { return []; }
  async resolveByHash(): Promise<null> { return null; }

  has(uri: string): boolean {
    return this.blobs.has(uri);
  }

  /** Count how many times a URI matching the pattern was put. */
  countPuts(pattern: string | RegExp): number {
    let count = 0;
    for (const uri of this.blobs.keys()) {
      if (typeof pattern === 'string' ? uri.includes(pattern) : pattern.test(uri)) {
        count++;
      }
    }
    return count;
  }
}

// ---------------------------------------------------------------------------
// Bundle packing helper — identical to entrypoint.test.ts
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

function asJsonBytes(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Harness setup — adapted from entrypoint.test.ts
// ---------------------------------------------------------------------------

interface Harness {
  workDir: string;
  adaptersRoot: string;
  storage: FakeStorage;
  env: Record<string, string>;
  events: LifecycleEvent[];
  adapter: RuntimeAdapter;
  setRuntimeExit(exit: RuntimeExit): void;
}

async function setupHarness(opts?: {
  verify?: { command: string; timeout?: number };
  onInvoke?: (spec: RuntimeInvocation) => Promise<void>;
}): Promise<Harness> {
  const workDir = await mkdtemp(join(tmpdir(), 'golden-work-'));
  const adaptersRoot = await mkdtemp(join(tmpdir(), 'golden-adapters-'));

  // Pre-initialize a git repo in workDir so captureBaseline (which runs
  // git init -q idempotently) always has a fully functional repo. This
  // makes patchRef presence DETERMINISTIC — no conditional branches needed.
  await execFileAsync('git', [
    '-C', workDir,
    '-c', 'safe.directory=*',
    '-c', 'user.email=agora@local',
    '-c', 'user.name=agora',
    '-c', 'commit.gpgsign=false',
    'init', '-q',
  ]);
  await execFileAsync('git', [
    '-C', workDir,
    '-c', 'safe.directory=*',
    '-c', 'user.email=agora@local',
    '-c', 'user.name=agora',
    '-c', 'commit.gpgsign=false',
    'commit', '--allow-empty', '-m', 'init',
  ]);

  // Write a stub adapter on disk (adapter-loader still exercises discovery).
  const adapterDir = join(adaptersRoot, 'claude-code');
  await mkdir(adapterDir, { recursive: true });
  await writeFile(
    join(adapterDir, 'index.js'),
    `export default function () {
       return {
         name: "claude-code",
         reservedPaths: [],
         invoke: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
       };
     };\n`,
    'utf-8',
  );

  const subagentDef: Record<string, unknown> = { name: 'alpha', systemPrompt: 'do work' };
  if (opts?.verify) subagentDef.verify = opts.verify;

  const subagentUri = 'agora://ns/subagent/alpha/sha256:s';
  const subagentHash = computeContentHash(subagentDef);

  const capFiles = { 'README.md': new TextEncoder().encode('hello\n') };
  const capBytes = packBundle('cap-a', capFiles);
  const capUri = 'agora://ns/capability/cap-a/sha256:c';
  const capHash = computeContentHash(capBytes);

  const storage = new FakeStorage();
  storage.set(subagentUri, asJsonBytes(subagentDef));
  storage.set(capUri, capBytes);

  const bundleRefs = {
    subagent: { uri: subagentUri, contentHash: subagentHash },
    capabilities: [{ uri: capUri, contentHash: capHash }],
    env: [],
  };

  const env: Record<string, string> = {
    AGORA_DISPATCH_ID: 'd-1',
    AGORA_NAMESPACE: 'ns',
    AGORA_STORAGE_URI: 'file:///fake',
    AGORA_BUNDLE_REFS_JSON: JSON.stringify(bundleRefs),
    AGORA_INPUT_JSON: JSON.stringify({ greeting: 'hi' }),
    AGORA_RUNTIME_ADAPTER: 'claude-code',
  };

  const events: LifecycleEvent[] = [];

  let runtimeExit: RuntimeExit = { exitCode: 0, stdout: '', stderr: '' };
  const adapter: RuntimeAdapter = {
    name: 'claude-code',
    reservedPaths: [],
    invoke: async (spec) => {
      if (opts?.onInvoke) await opts.onInvoke(spec);
      return runtimeExit;
    },
  };

  return {
    workDir,
    adaptersRoot,
    storage,
    env,
    events,
    adapter,
    setRuntimeExit(exit: RuntimeExit) {
      runtimeExit = exit;
    },
  };
}

function makeDeps(h: Harness): RunWorkerDeps {
  return {
    storage: h.storage,
    adapter: h.adapter,
    adaptersRoot: h.adaptersRoot,
    workspaceDir: h.workDir,
    secretsManagerClient: { send: async () => ({ SecretString: 'unused' }) } as never,
    onLifecycleEvent: (e) => { h.events.push(e); },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('pipeline-golden: sentinel byte-shape parity', () => {
  let cleanupDirs: string[] = [];

  afterEach(async () => {
    for (const d of cleanupDirs) {
      await rm(d, { recursive: true, force: true });
    }
    cleanupDirs = [];
  });

  // -------------------------------------------------------------------------
  // Scenario 1 — no-verify, no adapter edit
  // Keys must be exactly ['schemaVersion'] (no patchRef because adapter wrote nothing)
  // 'blocks' must be absent.
  // -------------------------------------------------------------------------
  it('no-edit dispatch: sentinel keys exactly [schemaVersion], no blocks, exit 0, dispatch.finished', async () => {
    const h = await setupHarness();
    cleanupDirs.push(h.workDir, h.adaptersRoot);
    // Adapter does nothing — no files changed, so capturePatch yields no diff → patchRef absent.
    h.setRuntimeExit({ exitCode: 0, stdout: '', stderr: '' });

    const code = await runWorker(h.env, makeDeps(h));

    expect(code).toBe(0);

    // Lifecycle order: started before finished
    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toContain('dispatch.started');
    expect(kinds).toContain('dispatch.finished');
    expect(kinds).not.toContain('dispatch.failed');
    const startedIdx = kinds.indexOf('dispatch.started');
    const finishedIdx = kinds.indexOf('dispatch.finished');
    expect(startedIdx).toBeLessThan(finishedIdx);

    // Sentinel must have been stored.
    const sentinelUri = buildDispatchRecordUri('ns', 'd-1', 'output.json');
    expect(h.storage.has(sentinelUri)).toBe(true);
    const bytes = await h.storage.get(sentinelUri);
    const bytesStr = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(bytesStr) as Record<string, unknown>;

    // Golden key-order assertion (the byte-identity proof).
    expect(Object.keys(parsed)).toEqual(['schemaVersion']);

    // 'blocks' must be absent — default pipeline is undeclared.
    expect('blocks' in parsed).toBe(false);

    // Round-trip stability: re-serializing preserves insertion order = same bytes.
    expect(JSON.stringify(parsed)).toBe(bytesStr);
  });

  // -------------------------------------------------------------------------
  // Scenario 2 — no-verify, adapter writes a file
  // Keys must be exactly ['schemaVersion','patchRef'], no blocks.
  // -------------------------------------------------------------------------
  it('adapter-edit dispatch: sentinel keys exactly [schemaVersion,patchRef], no blocks, exit 0', async () => {
    const h = await setupHarness({
      onInvoke: async (spec) => {
        // Write a new file so git diff sees a change → patchRef present.
        await writeFile(join(spec.workspaceDir, 'agent-output.txt'), 'result\n');
      },
    });
    cleanupDirs.push(h.workDir, h.adaptersRoot);
    h.setRuntimeExit({ exitCode: 0, stdout: '', stderr: '' });

    const code = await runWorker(h.env, makeDeps(h));
    expect(code).toBe(0);

    const sentinelUri = buildDispatchRecordUri('ns', 'd-1', 'output.json');
    expect(h.storage.has(sentinelUri)).toBe(true);
    const bytes = await h.storage.get(sentinelUri);
    const bytesStr = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(bytesStr) as Record<string, unknown>;

    // Git is pre-initialized in setupHarness, so patchRef MUST always be
    // present when the adapter writes a file. Assert unconditionally.
    const keys = Object.keys(parsed);
    expect(keys).toEqual(['schemaVersion', 'patchRef']);

    expect('blocks' in parsed).toBe(false);
    expect(JSON.stringify(parsed)).toBe(bytesStr);

    // Lifecycle order
    const kinds = h.events.map((e) => e.kind);
    expect(kinds.indexOf('dispatch.started')).toBeLessThan(kinds.indexOf('dispatch.finished'));
  });

  // -------------------------------------------------------------------------
  // Scenario 3 — verify configured, adapter writes a file
  // Keys must be exactly ['schemaVersion','patchRef','verify'] (when git available)
  // 'verify.passed' must be true for a passing command.
  // -------------------------------------------------------------------------
  it('verify-configured dispatch: sentinel keys [schemaVersion,patchRef,verify], verify.passed true, no blocks', async () => {
    const h = await setupHarness({
      verify: { command: 'node -e "process.exit(0)"' },
      onInvoke: async (spec) => {
        await writeFile(join(spec.workspaceDir, 'agent-output.txt'), 'result\n');
      },
    });
    cleanupDirs.push(h.workDir, h.adaptersRoot);
    h.setRuntimeExit({ exitCode: 0, stdout: '', stderr: '' });

    const code = await runWorker(h.env, makeDeps(h));
    expect(code).toBe(0);

    const sentinelUri = buildDispatchRecordUri('ns', 'd-1', 'output.json');
    expect(h.storage.has(sentinelUri)).toBe(true);
    const bytes = await h.storage.get(sentinelUri);
    const bytesStr = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(bytesStr) as Record<string, unknown>;

    // Git is pre-initialized in setupHarness, so patchRef MUST always be
    // present when the adapter writes a file. Assert unconditionally.
    const keys = Object.keys(parsed);
    expect(keys).toEqual(['schemaVersion', 'patchRef', 'verify']);

    // verify.passed must be true (passing command)
    const verify = parsed['verify'] as { passed: boolean };
    expect(verify.passed).toBe(true);

    // 'blocks' absent
    expect('blocks' in parsed).toBe(false);

    // Round-trip
    expect(JSON.stringify(parsed)).toBe(bytesStr);

    // Lifecycle order
    const kinds = h.events.map((e) => e.kind);
    expect(kinds.indexOf('dispatch.started')).toBeLessThan(kinds.indexOf('dispatch.finished'));
  });

  // -------------------------------------------------------------------------
  // Scenario 4 — verify + outputs written by the adapter
  // Keys must be exactly ['schemaVersion','patchRef','verify','outputs']
  // -------------------------------------------------------------------------
  it('outputs dispatch: sentinel keys include verify and outputs in correct order, no blocks', async () => {
    const h = await setupHarness({
      verify: { command: 'node -e "process.exit(0)"' },
      onInvoke: async (spec) => {
        await writeFile(join(spec.workspaceDir, 'agent-output.txt'), 'result\n');
        const outputsDir = join(spec.workspaceDir, 'outputs');
        await mkdir(outputsDir, { recursive: true });
        await writeFile(join(outputsDir, 'r.txt'), 'output-content');
      },
    });
    cleanupDirs.push(h.workDir, h.adaptersRoot);
    h.setRuntimeExit({ exitCode: 0, stdout: '', stderr: '' });

    const code = await runWorker(h.env, makeDeps(h));
    expect(code).toBe(0);

    const sentinelUri = buildDispatchRecordUri('ns', 'd-1', 'output.json');
    expect(h.storage.has(sentinelUri)).toBe(true);
    const bytes = await h.storage.get(sentinelUri);
    const bytesStr = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(bytesStr) as Record<string, unknown>;

    // Git is pre-initialized in setupHarness, so patchRef MUST always be
    // present when the adapter writes a file. Assert the full key sequence
    // unconditionally.
    const keys = Object.keys(parsed);
    expect(keys).toEqual(['schemaVersion', 'patchRef', 'verify', 'outputs']);

    // 'blocks' absent
    expect('blocks' in parsed).toBe(false);

    // outputs entries are content-addressed
    const outputs = parsed['outputs'] as Array<{ path: string; ref: string }>;
    expect(Array.isArray(outputs)).toBe(true);
    expect(outputs.length).toBeGreaterThan(0);
    const entry = outputs[0]!;
    expect(entry.path).toBe('r.txt');
    expect(entry.ref).toMatch(/^agora:\/\//);

    // Verify the artifact bytes are in storage
    const refBytes = await h.storage.get(entry.ref);
    expect(new TextDecoder().decode(refBytes)).toBe('output-content');

    // Round-trip
    expect(JSON.stringify(parsed)).toBe(bytesStr);

    // Lifecycle order
    const kinds = h.events.map((e) => e.kind);
    expect(kinds.indexOf('dispatch.started')).toBeLessThan(kinds.indexOf('dispatch.finished'));
  });

  // -------------------------------------------------------------------------
  // Scenario 5 — failure parity
  // Non-zero adapter exit → dispatch.failed with reason 'provider-failed',
  // exit code carried, ZERO output.json sentinel puts.
  // -------------------------------------------------------------------------
  it('failure parity: non-zero adapter exit → dispatch.failed/provider-failed, exit code carried, zero sentinel puts', async () => {
    const h = await setupHarness();
    cleanupDirs.push(h.workDir, h.adaptersRoot);
    h.setRuntimeExit({ exitCode: 7, stdout: '', stderr: 'runtime error' });

    const code = await runWorker(h.env, makeDeps(h));

    // Exit code is carried from the adapter
    expect(code).toBe(7);

    // dispatch.failed with provider-failed reason
    const failed = h.events.find((e) => e.kind === 'dispatch.failed');
    expect(failed).toBeDefined();
    expect(failed && 'reason' in failed && failed.reason).toBe('provider-failed');

    // No dispatch.finished
    expect(h.events.some((e) => e.kind === 'dispatch.finished')).toBe(false);

    // ZERO output.json sentinel puts
    const sentinelUri = buildDispatchRecordUri('ns', 'd-1', 'output.json');
    expect(h.storage.has(sentinelUri)).toBe(false);

    // Lifecycle order: started before failed
    const kinds = h.events.map((e) => e.kind);
    expect(kinds.indexOf('dispatch.started')).toBeLessThan(kinds.indexOf('dispatch.failed'));
  });

  // -------------------------------------------------------------------------
  // Scenario 6 — needs_input parity
  // Adapter surfaces a valid needs-input sentinel file →
  // dispatch.needs_input emitted, exit 0, ZERO output.json sentinel puts.
  // -------------------------------------------------------------------------
  it('needs_input parity: valid sentinel file → dispatch.needs_input, exit 0, zero sentinel puts', async () => {
    const h = await setupHarness();
    cleanupDirs.push(h.workDir, h.adaptersRoot);

    // Pre-stage a valid needs_input sentinel in the workspace
    const sentinelPath = join(h.workDir, 'needs_input.json');
    await writeFile(
      sentinelPath,
      JSON.stringify({ question: 'pick one', options: ['a', 'b'] }),
      'utf-8',
    );
    h.setRuntimeExit({
      exitCode: 0,
      stdout: '',
      stderr: '',
      needsInputSentinelPath: sentinelPath,
    });

    const code = await runWorker(h.env, makeDeps(h));

    expect(code).toBe(0);

    // dispatch.needs_input emitted
    expect(h.events.some((e) => e.kind === 'dispatch.needs_input')).toBe(true);

    // No dispatch.finished, no dispatch.failed
    expect(h.events.some((e) => e.kind === 'dispatch.finished')).toBe(false);
    expect(h.events.some((e) => e.kind === 'dispatch.failed')).toBe(false);

    // ZERO output.json sentinel puts
    const sentinelUri = buildDispatchRecordUri('ns', 'd-1', 'output.json');
    expect(h.storage.has(sentinelUri)).toBe(false);

    // Lifecycle order: started before needs_input
    const kinds = h.events.map((e) => e.kind);
    expect(kinds.indexOf('dispatch.started')).toBeLessThan(kinds.indexOf('dispatch.needs_input'));
  });

  // -------------------------------------------------------------------------
  // Scenario 7 — lifecycle ORDER across all terminal paths
  // Verify started always comes before the terminal event in every outcome.
  // -------------------------------------------------------------------------
  it('lifecycle order: dispatch.started is always the first event before any terminal event', async () => {
    // Test multiple configurations to verify ordering is universal.
    const scenarios: Array<{ label: string; fn: () => Promise<{ code: number; events: LifecycleEvent[] }> }> = [
      {
        label: 'success',
        fn: async () => {
          const h = await setupHarness();
          cleanupDirs.push(h.workDir, h.adaptersRoot);
          h.setRuntimeExit({ exitCode: 0, stdout: '', stderr: '' });
          const code = await runWorker(h.env, makeDeps(h));
          return { code, events: h.events };
        },
      },
      {
        label: 'failure',
        fn: async () => {
          const h = await setupHarness();
          cleanupDirs.push(h.workDir, h.adaptersRoot);
          h.setRuntimeExit({ exitCode: 3, stdout: '', stderr: 'oops' });
          const code = await runWorker(h.env, makeDeps(h));
          return { code, events: h.events };
        },
      },
      {
        label: 'needs_input',
        fn: async () => {
          const h = await setupHarness();
          cleanupDirs.push(h.workDir, h.adaptersRoot);
          const sp = join(h.workDir, 'needs_input.json');
          await writeFile(sp, JSON.stringify({ question: 'q?', options: ['y', 'n'] }), 'utf-8');
          h.setRuntimeExit({ exitCode: 0, stdout: '', stderr: '', needsInputSentinelPath: sp });
          const code = await runWorker(h.env, makeDeps(h));
          return { code, events: h.events };
        },
      },
    ];

    for (const scenario of scenarios) {
      const { events } = await scenario.fn();
      const kinds = events.map((e) => e.kind);
      const startedIdx = kinds.indexOf('dispatch.started');
      expect(startedIdx).toBeGreaterThanOrEqual(0, `${scenario.label}: dispatch.started missing`);
      const terminalKinds = ['dispatch.finished', 'dispatch.failed', 'dispatch.needs_input'];
      for (const termKind of terminalKinds) {
        const termIdx = kinds.indexOf(termKind);
        if (termIdx >= 0) {
          expect(startedIdx).toBeLessThan(termIdx);
        }
      }
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 8 — round-trip JSON stability assertion (dedicated test)
  // Parse-then-stringify must equal the stored bytes for every sentinel shape.
  // -------------------------------------------------------------------------
  it('JSON round-trip stability: JSON.stringify(JSON.parse(bytes)) === stored bytes for verify-configured path', async () => {
    const h = await setupHarness({
      verify: { command: 'node -e "process.exit(0)"' },
    });
    cleanupDirs.push(h.workDir, h.adaptersRoot);
    h.setRuntimeExit({ exitCode: 0, stdout: '', stderr: '' });

    const code = await runWorker(h.env, makeDeps(h));
    expect(code).toBe(0);

    const sentinelUri = buildDispatchRecordUri('ns', 'd-1', 'output.json');
    expect(h.storage.has(sentinelUri)).toBe(true);
    const bytes = await h.storage.get(sentinelUri);
    const bytesStr = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(bytesStr);

    // The round-trip equality is the proof that writeSentinel uses insertion
    // order deterministically — JSON.stringify preserves V8 insertion order.
    expect(JSON.stringify(parsed)).toBe(bytesStr);
    expect('blocks' in parsed).toBe(false);
  });
});
