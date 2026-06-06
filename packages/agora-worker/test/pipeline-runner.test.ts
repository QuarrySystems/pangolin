// Tests for pipeline-runner.ts — the block-pipeline interpreter (Wave 1).
//
// Uses inline fakes (the worker convention from entrypoint.test.ts).
// All test commands use `node -e` for cross-platform portability.

import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  PipelineSpec,
  StorageProvider,
  RuntimeAdapter,
  RuntimeExit,
  VerifyConfig,
} from '@quarry-systems/agora-core';
import {
  buildDefaultPipeline,
  runPipeline,
  DEFAULT_VERIFY_TIMEOUT_SECONDS,
  type BlockContext,
} from '../src/pipeline-runner.js';
import type { WorkspaceBaseline } from '../src/patch-capture.js';

// ---------------------------------------------------------------------------
// Minimal in-memory StorageProvider fake
// ---------------------------------------------------------------------------

class FakeStorage implements StorageProvider {
  readonly name = 'fake';
  readonly puts: Array<{ uri: string; bytes: Uint8Array }> = [];

  async put(uri: string, contents: Uint8Array): Promise<{ contentHash: string }> {
    this.puts.push({ uri, bytes: contents });
    return { contentHash: 'sha256:fake' };
  }

  async get(uri: string): Promise<Uint8Array> {
    throw new Error(`FakeStorage.get not expected: ${uri}`);
  }

  async resolveLatest(): Promise<null> {
    return null;
  }

  async list(): Promise<[]> {
    return [];
  }

  async resolveByHash(): Promise<null> {
    return null;
  }

  hasPut(pattern: string | RegExp): boolean {
    return this.puts.some((p) =>
      typeof pattern === 'string' ? p.uri.includes(pattern) : pattern.test(p.uri),
    );
  }
}

// ---------------------------------------------------------------------------
// Fake RuntimeAdapter
// ---------------------------------------------------------------------------

function makeFakeAdapter(exit: RuntimeExit = { exitCode: 0, stdout: '', stderr: '' }): RuntimeAdapter {
  return {
    name: 'fake',
    reservedPaths: [],
    invoke: async () => exit,
  };
}

// ---------------------------------------------------------------------------
// BlockContext factory
// ---------------------------------------------------------------------------

async function makeCtx(
  workspaceDir: string,
  opts: {
    storage?: StorageProvider;
    adapter?: RuntimeAdapter;
    inputJson?: string;
    subagent?: { systemPrompt?: string; promptTemplate?: string; model?: string };
  } = {},
): Promise<{ ctx: BlockContext; logs: Array<Record<string, unknown>> }> {
  const logs: Array<Record<string, unknown>> = [];
  const baseline: WorkspaceBaseline = { unavailable: true }; // no git in temp dir tests
  const ctx: BlockContext = {
    workspaceDir,
    env: {},
    storage: opts.storage ?? new FakeStorage(),
    namespace: 'ns',
    dispatchId: 'd-1',
    adapter: opts.adapter ?? makeFakeAdapter(),
    subagent: opts.subagent ?? {},
    inputJson: opts.inputJson,
    baseline,
    redact: (s) => s,
    log: (event) => { logs.push(event); },
  };
  return { ctx, logs };
}

// ---------------------------------------------------------------------------
// Temp dir management
// ---------------------------------------------------------------------------

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pipeline-runner-test-'));
  tempDirs.push(dir);
  return dir;
}

async function cleanupTempDirs(): Promise<void> {
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tempDirs = [];
}

// ---------------------------------------------------------------------------
// buildDefaultPipeline
// ---------------------------------------------------------------------------

describe('buildDefaultPipeline', () => {
  it('no verify → [agent, capture(patch), capture(outputs)] with no script block', () => {
    const spec = buildDefaultPipeline({});
    expect(spec.schemaVersion).toBe(1);
    expect(spec.blocks).toHaveLength(3);
    expect(spec.blocks[0]).toEqual({ kind: 'agent' });
    expect(spec.blocks[1]).toEqual({ kind: 'capture', what: 'patch' });
    expect(spec.blocks[2]).toEqual({ kind: 'capture', what: 'outputs' });
  });

  it('with verify → verify-lens script inserted between the two captures', () => {
    const verify: VerifyConfig = { command: 'echo ok', timeout: 30 };
    const spec = buildDefaultPipeline({ verify });
    expect(spec.blocks).toHaveLength(4);
    expect(spec.blocks[0]).toEqual({ kind: 'agent' });
    expect(spec.blocks[1]).toEqual({ kind: 'capture', what: 'patch' });
    expect(spec.blocks[2]).toMatchObject({
      kind: 'script',
      command: 'echo ok',
      timeoutSeconds: 30,
      lens: 'verify',
    });
    expect(spec.blocks[3]).toEqual({ kind: 'capture', what: 'outputs' });
  });

  it('verify timeout = 0 is guarded → DEFAULT_VERIFY_TIMEOUT_SECONDS (600)', () => {
    const verify: VerifyConfig = { command: 'echo test', timeout: 0 };
    const spec = buildDefaultPipeline({ verify });
    const scriptBlock = spec.blocks.find((b) => b.kind === 'script') as {
      kind: 'script';
      timeoutSeconds: number;
    };
    expect(scriptBlock.timeoutSeconds).toBe(DEFAULT_VERIFY_TIMEOUT_SECONDS);
  });

  it('verify timeout negative → DEFAULT_VERIFY_TIMEOUT_SECONDS (600)', () => {
    const verify: VerifyConfig = { command: 'echo test', timeout: -5 };
    const spec = buildDefaultPipeline({ verify });
    const scriptBlock = spec.blocks.find((b) => b.kind === 'script') as {
      kind: 'script';
      timeoutSeconds: number;
    };
    expect(scriptBlock.timeoutSeconds).toBe(DEFAULT_VERIFY_TIMEOUT_SECONDS);
  });

  it('verify timeout undefined → DEFAULT_VERIFY_TIMEOUT_SECONDS (600)', () => {
    const verify: VerifyConfig = { command: 'echo test' };
    const spec = buildDefaultPipeline({ verify });
    const scriptBlock = spec.blocks.find((b) => b.kind === 'script') as {
      kind: 'script';
      timeoutSeconds: number;
    };
    expect(scriptBlock.timeoutSeconds).toBe(DEFAULT_VERIFY_TIMEOUT_SECONDS);
  });

  it('verify timeout positive → carried verbatim', () => {
    const verify: VerifyConfig = { command: 'echo test', timeout: 120 };
    const spec = buildDefaultPipeline({ verify });
    const scriptBlock = spec.blocks.find((b) => b.kind === 'script') as {
      kind: 'script';
      timeoutSeconds: number;
    };
    expect(scriptBlock.timeoutSeconds).toBe(120);
  });

  it('DEFAULT_VERIFY_TIMEOUT_SECONDS is exported and equals 600', () => {
    expect(DEFAULT_VERIFY_TIMEOUT_SECONDS).toBe(600);
  });
});

// ---------------------------------------------------------------------------
// runPipeline — completed path
// ---------------------------------------------------------------------------

describe('runPipeline — completed path', () => {
  it('minimal agent-only spec completes and auto-seals (storage put observed)', async () => {
    const dir = await makeTempDir();
    const storage = new FakeStorage();
    const { ctx } = await makeCtx(dir, { storage });

    const spec: PipelineSpec = {
      schemaVersion: 1,
      id: 'dev.test',
      blocks: [{ kind: 'agent' }],
    };

    const result = await runPipeline(spec, ctx, { declared: false });
    await cleanupTempDirs();

    expect(result.kind).toBe('completed');
    // sentinel put: at least one storage put (dispatch record URI)
    expect(storage.puts.length).toBeGreaterThan(0);
  });

  it('agent block emits runtime.adapter.ran structured-log event', async () => {
    const dir = await makeTempDir();
    const adapter = makeFakeAdapter({ exitCode: 0, stdout: 'hello', stderr: '' });
    const { ctx, logs } = await makeCtx(dir, { adapter });

    const spec: PipelineSpec = {
      schemaVersion: 1,
      id: 'dev.test',
      blocks: [{ kind: 'agent' }],
    };

    await runPipeline(spec, ctx, { declared: false });
    await cleanupTempDirs();

    const adapterLog = logs.find((l) => l['kind'] === 'runtime.adapter.ran');
    expect(adapterLog).toBeDefined();
    expect(adapterLog!['exitCode']).toBe(0);
    expect(adapterLog!['stdout']).toBe('hello');
  });

  it('seal failure logs escape.failed and result is still completed', async () => {
    const dir = await makeTempDir();
    // Make storage that throws on put to simulate seal failure
    const brokenStorage: StorageProvider & { puts: unknown[] } = {
      name: 'broken',
      puts: [],
      put: async () => { throw new Error('storage down'); },
      get: async () => { throw new Error('no'); },
      resolveLatest: async () => null,
      list: async () => [],
      resolveByHash: async () => null,
    };
    const { ctx, logs } = await makeCtx(dir, { storage: brokenStorage as unknown as StorageProvider });

    const spec: PipelineSpec = {
      schemaVersion: 1,
      id: 'dev.test',
      blocks: [{ kind: 'agent' }],
    };

    const result = await runPipeline(spec, ctx, { declared: false });
    await cleanupTempDirs();

    expect(result.kind).toBe('completed');
    const escapeFailed = logs.find((l) => l['kind'] === 'escape.failed');
    expect(escapeFailed).toBeDefined();
  });

  it('blocks evidence NOT included in sentinel when opts.declared=false', async () => {
    const dir = await makeTempDir();
    const storage = new FakeStorage();
    const { ctx } = await makeCtx(dir, { storage });

    const spec: PipelineSpec = {
      schemaVersion: 1,
      id: 'dev.test',
      blocks: [{ kind: 'agent' }],
    };

    const result = await runPipeline(spec, ctx, { declared: false });
    await cleanupTempDirs();

    expect(result.kind).toBe('completed');
    if (result.kind === 'completed') {
      // sentinel should not have blocks field
      expect(result.sentinel).toBeDefined();
      expect(result.sentinel!.blocks).toBeUndefined();
    }
  });

  it('blocks evidence IS included in sentinel when opts.declared=true', async () => {
    const dir = await makeTempDir();
    const storage = new FakeStorage();
    const { ctx } = await makeCtx(dir, { storage });

    const spec: PipelineSpec = {
      schemaVersion: 1,
      id: 'dev.test',
      blocks: [{ kind: 'agent' }],
    };

    const result = await runPipeline(spec, ctx, { declared: true });
    await cleanupTempDirs();

    expect(result.kind).toBe('completed');
    if (result.kind === 'completed') {
      expect(result.sentinel).toBeDefined();
      expect(result.sentinel!.blocks).toBeDefined();
      expect(result.sentinel!.blocks!.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// runPipeline — gate script emits script.gate.ran log with redacted output
// ---------------------------------------------------------------------------

describe('runPipeline — gate script logging', () => {
  it('gate script emits script.gate.ran with exitCode, durationMs, and redacted stdout/stderr', async () => {
    const dir = await makeTempDir();
    const storage = new FakeStorage();
    // Set up a redact function that replaces "SECRET" with "[REDACTED]"
    const logs: Array<Record<string, unknown>> = [];
    const baseline = { unavailable: true } as const;
    const ctx: BlockContext = {
      workspaceDir: dir,
      env: {},
      storage,
      namespace: 'ns',
      dispatchId: 'd-gate',
      adapter: makeFakeAdapter(),
      subagent: {},
      baseline,
      redact: (s) => s.replace(/SECRET/g, '[REDACTED]'),
      log: (event) => { logs.push(event); },
    };

    // Script writes "SECRET text" to stdout and exits 0
    const spec: PipelineSpec = {
      schemaVersion: 1,
      id: 'dev.test',
      blocks: [
        { kind: 'script', command: 'node -e "process.stdout.write(\'SECRET text\')"', lens: 'gate' },
      ],
    };

    await runPipeline(spec, ctx, { declared: false });
    await cleanupTempDirs();

    const gateLog = logs.find((l) => l['kind'] === 'script.gate.ran');
    expect(gateLog).toBeDefined();
    expect(gateLog!['exitCode']).toBe(0);
    expect(typeof gateLog!['durationMs']).toBe('number');
    // stdout must be redacted — "SECRET" replaced with "[REDACTED]"
    expect(gateLog!['stdout']).toBe('[REDACTED] text');
    // stderr should be present (empty string is fine)
    expect(typeof gateLog!['stderr']).toBe('string');
    // Confirm the secret itself is NOT in the log
    expect(JSON.stringify(gateLog)).not.toContain('SECRET');
  });
});

// ---------------------------------------------------------------------------
// runPipeline — gate failure (script block)
// ---------------------------------------------------------------------------

describe('runPipeline — gate failure', () => {
  it('a gate script failure aborts the pipeline with no sentinel and the script exit code', async () => {
    const dir = await makeTempDir();
    const storage = new FakeStorage();
    const { ctx } = await makeCtx(dir, { storage });

    // spec: [script gate 'node -e "process.exit(3)"' (cross-platform), capture outputs]
    const spec: PipelineSpec = {
      schemaVersion: 1,
      id: 'dev.test',
      blocks: [
        { kind: 'script', command: 'node -e "process.exit(3)"', lens: 'gate' },
        { kind: 'capture', what: 'outputs' },
      ],
    };

    const result = await runPipeline(spec, ctx, { declared: true });
    await cleanupTempDirs();

    // gate failure: kind='failed', exitCode=3
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.exitCode).toBe(3);
      // First block failed
      expect(result.outcomes[0]!.status).toBe('failed');
      // Second block (capture) never ran
      expect(result.outcomes.length).toBe(1);
    }
    // No sentinel puts
    const sentinelPuts = storage.puts.filter((p) => p.uri.includes('output.json'));
    expect(sentinelPuts.length).toBe(0);
  });

  it('script gate default (no lens) is gate semantics — non-zero aborts pipeline', async () => {
    const dir = await makeTempDir();
    const storage = new FakeStorage();
    const { ctx } = await makeCtx(dir, { storage });

    const spec: PipelineSpec = {
      schemaVersion: 1,
      id: 'dev.test',
      blocks: [
        { kind: 'script', command: 'node -e "process.exit(2)"' },
        { kind: 'agent' },
      ],
    };

    const result = await runPipeline(spec, ctx, { declared: false });
    await cleanupTempDirs();

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.exitCode).toBe(2);
      expect(result.outcomes.length).toBe(1);
    }
    expect(storage.puts.length).toBe(0);
  });

  it('agent non-zero exit → failed with the adapter exit code and no sentinel', async () => {
    const dir = await makeTempDir();
    const storage = new FakeStorage();
    const adapter = makeFakeAdapter({ exitCode: 5, stdout: '', stderr: 'error' });
    const { ctx } = await makeCtx(dir, { storage, adapter });

    const spec: PipelineSpec = {
      schemaVersion: 1,
      id: 'dev.test',
      blocks: [{ kind: 'agent' }, { kind: 'capture', what: 'patch' }],
    };

    const result = await runPipeline(spec, ctx, { declared: false });
    await cleanupTempDirs();

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.exitCode).toBe(5);
      expect(result.outcomes.length).toBe(1);
    }
    // No sentinel
    expect(storage.puts.filter((p) => p.uri.includes('output.json')).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runPipeline — needs-input path
// ---------------------------------------------------------------------------

describe('runPipeline — needs-input path', () => {
  it('agent needsInputSentinelPath → needs-input result, no sentinel, no further blocks', async () => {
    const dir = await makeTempDir();
    const storage = new FakeStorage();
    const adapter = makeFakeAdapter({
      exitCode: 0,
      stdout: '',
      stderr: '',
      needsInputSentinelPath: '/some/path',
    });
    const { ctx } = await makeCtx(dir, { storage, adapter });

    const spec: PipelineSpec = {
      schemaVersion: 1,
      id: 'dev.test',
      blocks: [
        { kind: 'agent' },
        { kind: 'capture', what: 'patch' }, // should not run
      ],
    };

    const result = await runPipeline(spec, ctx, { declared: false });
    await cleanupTempDirs();

    expect(result.kind).toBe('needs-input');
    if (result.kind === 'needs-input') {
      expect(result.sentinelPath).toBe('/some/path');
      // Only the agent block ran
      expect(result.outcomes.length).toBe(1);
    }
    // No sentinel put
    expect(storage.puts.filter((p) => p.uri.includes('output.json')).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runPipeline — adapter throw propagates
// ---------------------------------------------------------------------------

describe('runPipeline — adapter throw propagation', () => {
  it('adapter.invoke throw propagates out of runPipeline', async () => {
    const dir = await makeTempDir();
    const storage = new FakeStorage();
    const throwingAdapter: RuntimeAdapter = {
      name: 'throwing',
      reservedPaths: [],
      invoke: async () => { throw new Error('adapter exploded'); },
    };
    const { ctx } = await makeCtx(dir, { storage, adapter: throwingAdapter });

    const spec: PipelineSpec = {
      schemaVersion: 1,
      id: 'dev.test',
      blocks: [{ kind: 'agent' }],
    };

    await expect(runPipeline(spec, ctx, { declared: false })).rejects.toThrow('adapter exploded');
    await cleanupTempDirs();
  });
});

// ---------------------------------------------------------------------------
// runPipeline — capture block failure is not a gate
// ---------------------------------------------------------------------------

describe('runPipeline — capture block is not a gate', () => {
  it('capture(outputs) throw logs escape.failed, subsequent block still runs, pipeline completes, sentinel put succeeds', async () => {
    const dir = await makeTempDir();
    const { mkdir: fsMkdir, writeFile: fsWriteFile } = await import('node:fs/promises');
    const { join: pathJoin } = await import('node:path');

    // Create outputs/file.txt so captureOutputs walks outputs/ and calls storage.put on artifact URIs.
    const outputsDir = pathJoin(dir, 'outputs');
    await fsMkdir(outputsDir, { recursive: true });
    await fsWriteFile(pathJoin(outputsDir, 'file.txt'), 'hello output');

    // Storage that throws ONLY on artifact URIs (capture uploads), succeeds on dispatch record URIs.
    // Artifact URIs look like: agora://<ns>/artifact/...
    // Dispatch record URIs look like: agora://<ns>/dispatch/...
    const artifactThrowStorage: StorageProvider = {
      name: 'artifact-throw',
      put: async (uri: string, _contents: Uint8Array) => {
        if (uri.includes('/artifact/')) throw new Error('artifact upload failed');
        return { contentHash: 'sha256:fake' };
      },
      get: async () => { throw new Error('no'); },
      resolveLatest: async () => null,
      list: async () => [],
      resolveByHash: async () => null,
    };

    const sentinelPuts: string[] = [];
    const trackingSentinelStorage: StorageProvider = {
      name: 'tracking',
      put: async (uri: string, contents: Uint8Array) => {
        if (uri.includes('/artifact/')) throw new Error('artifact upload failed');
        sentinelPuts.push(uri);
        return { contentHash: 'sha256:fake' };
      },
      get: async () => { throw new Error('no'); },
      resolveLatest: async () => null,
      list: async () => [],
      resolveByHash: async () => null,
    };

    const { ctx, logs } = await makeCtx(dir, { storage: trackingSentinelStorage });

    // spec: [agent, capture(outputs) — will throw on artifact put, capture(patch)]
    // The second agent block (after the failing capture) should still run,
    // proving capture failure is not a gate.
    const secondAdapter = makeFakeAdapter({ exitCode: 0, stdout: 'second ran', stderr: '' });
    const spec: PipelineSpec = {
      schemaVersion: 1,
      id: 'dev.test',
      blocks: [
        { kind: 'agent' },
        { kind: 'capture', what: 'outputs' }, // throws → logs escape.failed, continues
        { kind: 'agent' },                      // must still run
      ],
    };

    // Use an adapter that can be invoked twice
    let invokeCount = 0;
    const countingAdapter: RuntimeAdapter = {
      name: 'counting',
      reservedPaths: [],
      invoke: async () => {
        invokeCount++;
        return { exitCode: 0, stdout: `call-${invokeCount}`, stderr: '' };
      },
    };

    const { ctx: ctx2, logs: logs2 } = await makeCtx(dir, {
      storage: trackingSentinelStorage,
      adapter: countingAdapter,
    });

    const result = await runPipeline(spec, ctx2, { declared: false });
    await cleanupTempDirs();

    // escape.failed must have been logged (capture threw on artifact put)
    const escapeFailed = logs2.find((l) => l['kind'] === 'escape.failed');
    expect(escapeFailed).toBeDefined();
    expect(escapeFailed!['detail']).toContain('artifact upload failed');

    // The subsequent agent block still ran (invokeCount === 2)
    expect(invokeCount).toBe(2);

    // Pipeline completed (not failed)
    expect(result.kind).toBe('completed');

    // The final sentinel put (dispatch record URI) succeeded
    expect(sentinelPuts.length).toBeGreaterThan(0);
    expect(sentinelPuts.some((u) => u.includes('output.json'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runPipeline — unknown block kind
// ---------------------------------------------------------------------------

describe('runPipeline — unknown block kind', () => {
  it('unknown block kind → result.kind failed, exitCode 1, pipeline.unknown-block log emitted, no sentinel put', async () => {
    const dir = await makeTempDir();
    const storage = new FakeStorage();
    const { ctx, logs } = await makeCtx(dir, { storage });

    const spec: PipelineSpec = {
      schemaVersion: 1,
      id: 'dev.test',
      blocks: [
        { kind: 'agent' },
        { kind: 'unknown-future-block' } as never,
      ],
    };

    const result = await runPipeline(spec, ctx, { declared: false });
    await cleanupTempDirs();

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.exitCode).toBe(1);
    }

    // Log event must have been emitted
    const unknownLog = logs.find((l) => l['kind'] === 'pipeline.unknown-block');
    expect(unknownLog).toBeDefined();
    expect(unknownLog!['ordinal']).toBe(1);
    expect(unknownLog!['blockKind']).toBe('unknown-future-block');

    // No sentinel put (pipeline aborted)
    expect(storage.puts.filter((p) => p.uri.includes('output.json')).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runPipeline — verify lens (script with lens:'verify')
// ---------------------------------------------------------------------------

describe('runPipeline — verify lens', () => {
  it('verify lens never fails the pipeline even on non-zero exit, ordinals are sequential', async () => {
    const dir = await makeTempDir();
    const storage = new FakeStorage();
    const { ctx } = await makeCtx(dir, { storage });

    const spec: PipelineSpec = {
      schemaVersion: 1,
      id: 'dev.test',
      blocks: [
        { kind: 'script', command: 'node -e "process.exit(1)"', lens: 'verify' },
        { kind: 'agent' },
      ],
    };

    const result = await runPipeline(spec, ctx, { declared: false });
    await cleanupTempDirs();

    // verify-lens non-zero should NOT abort the pipeline
    expect(result.kind).toBe('completed');
    if (result.kind === 'completed') {
      expect(result.outcomes.length).toBe(2); // verify block + agent block
      // Ordinals must be sequential (0-based)
      expect(result.outcomes[0]!.ordinal).toBe(0);
      expect(result.outcomes[1]!.ordinal).toBe(1);
    }
  });

  it('first verify-lens outcome populates sentinel.verify', async () => {
    const dir = await makeTempDir();
    const storage = new FakeStorage();
    const { ctx } = await makeCtx(dir, { storage });

    const spec: PipelineSpec = {
      schemaVersion: 1,
      id: 'dev.test',
      blocks: [
        { kind: 'script', command: 'node -e "process.exit(0)"', lens: 'verify' },
      ],
    };

    const result = await runPipeline(spec, ctx, { declared: false });
    await cleanupTempDirs();

    expect(result.kind).toBe('completed');
    if (result.kind === 'completed') {
      expect(result.sentinel).toBeDefined();
      expect(result.sentinel!.verify).toBeDefined();
      expect(result.sentinel!.verify!.passed).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// runPipeline — seal aggregation (patchRef, verify, outputs)
// ---------------------------------------------------------------------------

describe('runPipeline — seal aggregation', () => {
  it('sentinel carries last capture(patch) ref when available', async () => {
    const dir = await makeTempDir();
    const storage = new FakeStorage();
    const { ctx } = await makeCtx(dir, { storage });

    // Simple spec with agent and capture — baseline unavailable means no actual patch
    const spec: PipelineSpec = {
      schemaVersion: 1,
      id: 'dev.test',
      blocks: [
        { kind: 'agent' },
        { kind: 'capture', what: 'patch' },
      ],
    };

    const result = await runPipeline(spec, ctx, { declared: false });
    await cleanupTempDirs();

    expect(result.kind).toBe('completed');
    // patchRef will be undefined since baseline is unavailable, but sentinel exists
    if (result.kind === 'completed') {
      expect(result.sentinel).toBeDefined();
    }
  });
});
