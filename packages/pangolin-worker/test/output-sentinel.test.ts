// Tests for escapeWorkspace (output-sentinel.ts).
//
// Uses an in-memory StorageProvider stub so no real storage or git infra is
// required. The patch-capture integration (actual git diffs) is exercised by
// patch-capture.test.ts; here we exercise the sentinel shape, artifact upload,
// and the two-write (patchRef + dispatch record) contract.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildDispatchRecordUri, type StorageProvider } from '@quarry-systems/pangolin-core';
import { captureBaseline, type WorkspaceBaseline } from '../src/patch-capture.js';
import {
  escapeWorkspace,
  capturePatch,
  writeSentinel,
  captureOutputs,
  MAX_OUTPUT_FILE_BYTES,
  MAX_OUTPUT_ENTRIES,
  type BlockOutcome,
} from '../src/output-sentinel.js';
import type { RuntimeUsage } from '@quarry-systems/pangolin-core';

// ---------------------------------------------------------------------------
// Minimal in-memory StorageProvider stub
// ---------------------------------------------------------------------------

class MemoryStorage implements StorageProvider {
  readonly name = 'memory';
  private blobs = new Map<string, Uint8Array>();

  async put(uri: string, contents: Uint8Array): Promise<{ contentHash: string }> {
    this.blobs.set(uri, contents);
    // Return a deterministic fake hash (not used for correctness assertions in these tests)
    return { contentHash: 'sha256:fake' };
  }

  async get(uri: string): Promise<Uint8Array> {
    const v = this.blobs.get(uri);
    if (!v) throw new Error(`memory storage: missing ${uri}`);
    return v;
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

  /** Test helper: list all stored URIs */
  storedUris(): string[] {
    return [...this.blobs.keys()];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function initGitRepo(dir: string): Promise<void> {
  // patch-capture uses git internally; we set up a minimal repo so
  // captureBaseline succeeds.
  const { spawn } = await import('node:child_process');
  const run = (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn('git', [
        '-C', dir,
        '-c', 'safe.directory=*',
        '-c', 'user.email=test@local',
        '-c', 'user.name=test',
        '-c', 'commit.gpgsign=false',
        ...args,
      ]);
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} failed with ${code}`)),
      );
      child.on('error', reject);
    });

  await run(['init', '-q']);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('escapeWorkspace', () => {
  let dir: string;
  let storage: MemoryStorage;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'escape-test-'));
    storage = new MemoryStorage();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('uploads a content-addressed patch and a sentinel referencing it when files changed', async () => {
    // Arrange: init git, write a file, capture baseline, then change the file
    await initGitRepo(dir);
    await writeFile(join(dir, 'a.txt'), 'one', 'utf-8');
    const baseline: WorkspaceBaseline = await captureBaseline(dir);

    // Change the file after baseline (simulating adapter work)
    await writeFile(join(dir, 'a.txt'), 'two', 'utf-8');

    // Act
    const sentinel = await escapeWorkspace({
      workspaceDir: dir,
      storage,
      namespace: 'ns',
      dispatchId: 'd1',
      baseline,
    });

    // Assert: sentinel shape
    expect(sentinel.schemaVersion).toBe(1);
    expect(sentinel.patchRef).toBeDefined();
    expect(sentinel.patchRef).toMatch(/\/artifact\/d1\/sha256:[0-9a-f]{64}$/);

    // Assert: artifact is retrievable
    const artifactBytes = await storage.get(sentinel.patchRef!);
    expect(artifactBytes.length).toBeGreaterThan(0);

    // Assert: dispatch record sentinel was written
    const dispatchUri = buildDispatchRecordUri('ns', 'd1', 'output.json');
    const sentinelBytes = await storage.get(dispatchUri);
    const parsed = JSON.parse(new TextDecoder().decode(sentinelBytes));
    expect(parsed.patchRef).toBe(sentinel.patchRef);
    expect(parsed.schemaVersion).toBe(1);
  });

  it('omits patchRef when the run made no changes to the workspace', async () => {
    // Arrange: init git, write a file, capture baseline, do NOT change anything
    await initGitRepo(dir);
    await writeFile(join(dir, 'b.txt'), 'unchanged', 'utf-8');
    const baseline: WorkspaceBaseline = await captureBaseline(dir);

    // Act (no changes after baseline)
    const sentinel = await escapeWorkspace({
      workspaceDir: dir,
      storage,
      namespace: 'ns',
      dispatchId: 'd2',
      baseline,
    });

    // Assert: no patchRef, no artifact
    expect(sentinel.schemaVersion).toBe(1);
    expect(sentinel.patchRef).toBeUndefined();

    // Dispatch record sentinel is still written
    const dispatchUri = buildDispatchRecordUri('ns', 'd2', 'output.json');
    const sentinelBytes = await storage.get(dispatchUri);
    const parsed = JSON.parse(new TextDecoder().decode(sentinelBytes));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.patchRef).toBeUndefined();
  });

  it('writes .pangolin/output.json in-workspace', async () => {
    await initGitRepo(dir);
    const baseline: WorkspaceBaseline = await captureBaseline(dir);

    await escapeWorkspace({
      workspaceDir: dir,
      storage,
      namespace: 'ns',
      dispatchId: 'd3',
      baseline,
    });

    // Read the on-disk sentinel
    const { readFile } = await import('node:fs/promises');
    const onDisk = JSON.parse(
      await readFile(join(dir, '.pangolin', 'output.json'), 'utf-8'),
    );
    expect(onDisk.schemaVersion).toBe(1);
  });

  it('includes summary in the sentinel when provided', async () => {
    await initGitRepo(dir);
    const baseline: WorkspaceBaseline = await captureBaseline(dir);

    const sentinel = await escapeWorkspace({
      workspaceDir: dir,
      storage,
      namespace: 'ns',
      dispatchId: 'd4',
      baseline,
      summary: 'task finished successfully',
    });

    expect(sentinel.summary).toBe('task finished successfully');
    const dispatchUri = buildDispatchRecordUri('ns', 'd4', 'output.json');
    const parsed = JSON.parse(
      new TextDecoder().decode(await storage.get(dispatchUri)),
    );
    expect(parsed.summary).toBe('task finished successfully');
  });

  it('includes verify in the sentinel when provided', async () => {
    await initGitRepo(dir);
    const baseline: WorkspaceBaseline = await captureBaseline(dir);

    const sentinel = await escapeWorkspace({
      workspaceDir: dir,
      storage,
      namespace: 'ns',
      dispatchId: 'd6',
      baseline,
      verify: { passed: true, report: 'tsc --noEmit ok', durationMs: 42 },
    });

    expect(sentinel.verify).toEqual({
      passed: true,
      report: 'tsc --noEmit ok',
      durationMs: 42,
    });
    const dispatchUri = buildDispatchRecordUri('ns', 'd6', 'output.json');
    const parsed = JSON.parse(
      new TextDecoder().decode(await storage.get(dispatchUri)),
    );
    expect(parsed.verify.passed).toBe(true);
    expect(parsed.verify.report).toBe('tsc --noEmit ok');
  });

  it('omits verify from the sentinel when not provided (backward-compat)', async () => {
    await initGitRepo(dir);
    const baseline: WorkspaceBaseline = await captureBaseline(dir);

    const sentinel = await escapeWorkspace({
      workspaceDir: dir,
      storage,
      namespace: 'ns',
      dispatchId: 'd7',
      baseline,
    });

    expect(sentinel.verify).toBeUndefined();
    const dispatchUri = buildDispatchRecordUri('ns', 'd7', 'output.json');
    const parsed = JSON.parse(
      new TextDecoder().decode(await storage.get(dispatchUri)),
    );
    expect('verify' in parsed).toBe(false);
  });

  it('capturePatch snapshots at call time — later workspace writes (e.g. verify artifacts) are excluded', async () => {
    await initGitRepo(dir);
    await writeFile(join(dir, 'edit.txt'), 'base', 'utf-8');
    const baseline: WorkspaceBaseline = await captureBaseline(dir);

    // The agent's edit.
    await writeFile(join(dir, 'edit.txt'), 'agent-change', 'utf-8');

    // Capture the patch NOW (before verify would run).
    const patchRef = await capturePatch({
      workspaceDir: dir,
      storage,
      namespace: 'ns',
      dispatchId: 'd8',
      baseline,
    });
    expect(patchRef).toBeDefined();

    // Now simulate a verify step polluting the workspace AFTER capture.
    await writeFile(join(dir, 'node_modules_marker.txt'), 'x'.repeat(100), 'utf-8');

    // Write the sentinel with the already-captured patchRef.
    await writeSentinel({
      workspaceDir: dir,
      storage,
      namespace: 'ns',
      dispatchId: 'd8',
      patchRef,
    });

    const patch = new TextDecoder().decode(await storage.get(patchRef!));
    expect(patch).toContain('edit.txt');
    expect(patch).not.toContain('node_modules_marker.txt');
  });

  it('works with unavailable baseline (no git) — omits patch, still writes sentinel', async () => {
    // No git init — baseline will be unavailable
    const baseline: WorkspaceBaseline = { unavailable: true };

    const sentinel = await escapeWorkspace({
      workspaceDir: dir,
      storage,
      namespace: 'ns',
      dispatchId: 'd5',
      baseline,
    });

    expect(sentinel.schemaVersion).toBe(1);
    expect(sentinel.patchRef).toBeUndefined();

    const dispatchUri = buildDispatchRecordUri('ns', 'd5', 'output.json');
    const sentinelBytes = await storage.get(dispatchUri);
    expect(JSON.parse(new TextDecoder().decode(sentinelBytes)).schemaVersion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// captureOutputs / outputs field (Wave A §5)
// ---------------------------------------------------------------------------

describe('captureOutputs + writeSentinel outputs field', () => {
  let dir: string;
  let storage: MemoryStorage;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'outputs-test-'));
    storage = new MemoryStorage();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('captures outputs/ files as content-addressed refs sealed in the sentinel', async () => {
    await mkdir(join(dir, 'outputs', 'data'), { recursive: true });
    await writeFile(join(dir, 'outputs', 'report.txt'), 'hello');
    await writeFile(join(dir, 'outputs', 'data', 'x.bin'), Buffer.from([1, 2, 3]));
    const outputs = await captureOutputs({ workspaceDir: dir, storage, namespace: 'ns', dispatchId: 'd1' });
    expect(outputs!.map((o) => o.path)).toEqual(['data/x.bin', 'report.txt']); // sorted, posix-relative
    for (const o of outputs!) await expect(storage.get(o.ref)).resolves.toBeInstanceOf(Uint8Array);
    const sentinel = await writeSentinel({ workspaceDir: dir, storage, namespace: 'ns', dispatchId: 'd1', outputs });
    expect(sentinel.outputs).toEqual(outputs);
  });

  it('returns undefined (and an outputs-free sentinel) when outputs/ is absent', async () => {
    expect(await captureOutputs({ workspaceDir: dir, storage, namespace: 'ns', dispatchId: 'd2' })).toBeUndefined();
    const sentinel = await writeSentinel({ workspaceDir: dir, storage, namespace: 'ns', dispatchId: 'd2' });
    expect('outputs' in sentinel).toBe(false); // hash-stable additive field, like verify
  });

  it('returns undefined when outputs/ is empty', async () => {
    await mkdir(join(dir, 'outputs'), { recursive: true });
    const outputs = await captureOutputs({ workspaceDir: dir, storage, namespace: 'ns', dispatchId: 'd3' });
    expect(outputs).toBeUndefined();
  });

  it('skips files over MAX_OUTPUT_FILE_BYTES and does not include them in entries', async () => {
    await mkdir(join(dir, 'outputs'), { recursive: true });
    // Write an ordinary small file.
    await writeFile(join(dir, 'outputs', 'small.txt'), 'keep me');
    // Create a sparse "huge" file of size MAX_OUTPUT_FILE_BYTES + 1 without
    // allocating that much memory: truncate creates a sparse hole on most OSes.
    const { open } = await import('node:fs/promises');
    const fh = await open(join(dir, 'outputs', 'huge.bin'), 'w');
    await fh.truncate(MAX_OUTPUT_FILE_BYTES + 1);
    await fh.close();
    const outputs = await captureOutputs({ workspaceDir: dir, storage, namespace: 'ns', dispatchId: 'd4' });
    expect(outputs).toBeDefined();
    expect(outputs!.map((o) => o.path)).toEqual(['small.txt']);
    expect(outputs!.every((o) => o.path !== 'huge.bin')).toBe(true);
  });

  it('stops at MAX_OUTPUT_ENTRIES and returns only that many entries', async () => {
    await mkdir(join(dir, 'outputs'), { recursive: true });
    // Write MAX_OUTPUT_ENTRIES + 5 files
    for (let i = 0; i < MAX_OUTPUT_ENTRIES + 5; i++) {
      await writeFile(join(dir, 'outputs', `file-${String(i).padStart(4, '0')}.txt`), `data${i}`);
    }
    const outputs = await captureOutputs({ workspaceDir: dir, storage, namespace: 'ns', dispatchId: 'd5' });
    expect(outputs).toBeDefined();
    expect(outputs!.length).toBe(MAX_OUTPUT_ENTRIES);
  });

  it('round-trips file bytes: storage.get(ref) returns the exact file bytes', async () => {
    await mkdir(join(dir, 'outputs'), { recursive: true });
    const content = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02]);
    await writeFile(join(dir, 'outputs', 'binary.bin'), content);
    const outputs = await captureOutputs({ workspaceDir: dir, storage, namespace: 'ns', dispatchId: 'd6' });
    expect(outputs).toHaveLength(1);
    const stored = await storage.get(outputs![0].ref);
    expect(Buffer.from(stored)).toEqual(content);
  });

  it('cap counts only files — directory entries interleaved in recursive readdir do not consume cap slots', async () => {
    // Create MAX_OUTPUT_ENTRIES files spread across subdirectories so that the
    // raw readdir result contains directory entries interspersed with file
    // entries. Before the fix, the cap would fire before MAX_OUTPUT_ENTRIES
    // files were actually captured.
    const numFiles = MAX_OUTPUT_ENTRIES;
    // Put half the files in subdirectories (each subdir entry appears in the
    // raw readdir list alongside its files, inflating the raw count).
    const subDirCount = 8;
    for (let s = 0; s < subDirCount; s++) {
      await mkdir(join(dir, 'outputs', `sub${s}`), { recursive: true });
    }
    for (let i = 0; i < numFiles; i++) {
      const subDir = `sub${i % subDirCount}`;
      await writeFile(
        join(dir, 'outputs', subDir, `file-${String(i).padStart(4, '0')}.txt`),
        `data${i}`,
      );
    }
    const outputs = await captureOutputs({
      workspaceDir: dir,
      storage,
      namespace: 'ns',
      dispatchId: 'd7',
    });
    expect(outputs).toBeDefined();
    expect(outputs!.length).toBe(numFiles);
  });

  // Symlink guard — symlink creation on Windows requires elevated privileges or
  // developer mode. Match the itPosix pattern used elsewhere in this package.
  const itPosix = process.platform === 'win32' ? it.skip : it;

  itPosix('skips symlinks pointing outside outputs/ to prevent scope inflation', async () => {
    // Create a directory outside outputs/ with a file we must NOT capture.
    const outsideDir = join(dir, 'outside');
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, 'secret.txt'), 'do-not-capture');

    // Create outputs/ with a legitimate file and a symlink to the outside dir.
    await mkdir(join(dir, 'outputs'), { recursive: true });
    await writeFile(join(dir, 'outputs', 'legit.txt'), 'capture me');
    await symlink(outsideDir, join(dir, 'outputs', 'leaked-link'), 'dir');

    const outputs = await captureOutputs({
      workspaceDir: dir,
      storage,
      namespace: 'ns',
      dispatchId: 'd8',
    });
    expect(outputs).toBeDefined();
    const paths = outputs!.map((o) => o.path);
    expect(paths).toEqual(['legit.txt']); // only the legitimate file
    expect(paths.some((p) => p.includes('secret'))).toBe(false);
    expect(paths.some((p) => p.includes('leaked-link'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// blocks field (§5 pin 3)
// ---------------------------------------------------------------------------

describe('blocks field on OutputSentinel / writeSentinel', () => {
  let dir: string;
  let storage: MemoryStorage;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'blocks-test-'));
    storage = new MemoryStorage();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('a sentinel without blocks is byte-identical to the pre-blocks shape', async () => {
    // Write two sentinels with identical inputs — one via old opts surface (no
    // blocks key at all), one with blocks: undefined — assert the STORED BYTES
    // are identical (hash-stability contract).
    const optsBase = {
      workspaceDir: dir,
      storage,
      namespace: 'ns',
      dispatchId: 'b1',
      patchRef: 'pangolin://ns/artifact/b1/sha256:' + 'a'.repeat(64),
      summary: 'test',
    } as const;

    // First sentinel: classic opts, no blocks key.
    const s1 = await writeSentinel(optsBase);

    // Use a second temp dir so the .pangolin/output.json write doesn't collide.
    const dir2 = await mkdtemp(join(tmpdir(), 'blocks-test2-'));
    try {
      const storage2 = new MemoryStorage();
      const s2 = await writeSentinel({
        ...optsBase,
        workspaceDir: dir2,
        storage: storage2,
        dispatchId: 'b1',
        blocks: undefined,
      });

      // Compare raw stored bytes (not JSON.parse — the bytes must be identical).
      const { buildDispatchRecordUri } = await import('@quarry-systems/pangolin-core');
      const uri = buildDispatchRecordUri('ns', 'b1', 'output.json');
      const bytes1 = await storage.get(uri);
      const bytes2 = await storage2.get(uri);
      expect(bytes1).toEqual(bytes2);

      // Also confirm the parsed shapes match.
      expect(s1).toEqual(s2);
      expect('blocks' in s1).toBe(false);
      expect('blocks' in s2).toBe(false);
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  });

  it('blocks are serialized when provided', async () => {
    const block: BlockOutcome = {
      kind: 'script',
      ordinal: 0,
      status: 'ok',
      durationMs: 5,
    };

    const sentinel = await writeSentinel({
      workspaceDir: dir,
      storage,
      namespace: 'ns',
      dispatchId: 'b2',
      blocks: [block],
    });

    // In-memory return value
    expect(sentinel.blocks).toEqual([block]);

    // Stored bytes round-trip
    const { buildDispatchRecordUri } = await import('@quarry-systems/pangolin-core');
    const uri = buildDispatchRecordUri('ns', 'b2', 'output.json');
    const parsed = JSON.parse(new TextDecoder().decode(await storage.get(uri)));
    expect(parsed.blocks).toEqual([block]);
  });
});

// ---------------------------------------------------------------------------
// usage field (wave: model-cost-evidence)
// ---------------------------------------------------------------------------

describe('usage field on OutputSentinel / writeSentinel', () => {
  let dir: string;
  let storage: MemoryStorage;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'usage-test-'));
    storage = new MemoryStorage();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('includes usage after outputs and before blocks in key order, and omits it entirely when absent', async () => {
    const usage: RuntimeUsage = { models: ['claude-opus-4-7'], costUsd: 0.05 };
    const outputs = [{ path: 'report.txt', ref: 'pangolin://ns/artifact/u1/sha256:' + 'b'.repeat(64) }];
    const blocks: BlockOutcome[] = [{ kind: 'script', ordinal: 0, status: 'ok', durationMs: 3 }];

    // With usage, outputs, and blocks: verify key ordering.
    const { buildDispatchRecordUri } = await import('@quarry-systems/pangolin-core');
    const withUsage = await writeSentinel({
      workspaceDir: dir,
      storage,
      namespace: 'ns',
      dispatchId: 'u1',
      outputs,
      usage,
      blocks,
    });
    const uri1 = buildDispatchRecordUri('ns', 'u1', 'output.json');
    const parsed1 = JSON.parse(new TextDecoder().decode(await storage.get(uri1)));
    const keys = Object.keys(parsed1);
    expect(keys.indexOf('usage')).toBeGreaterThan(keys.indexOf('outputs'));
    expect(keys.indexOf('usage')).toBeLessThan(keys.indexOf('blocks'));

    // In-memory return also carries usage.
    expect(withUsage.usage).toEqual(usage);

    // Without usage: the key must be absent entirely (hash-stable additive field).
    const dir2 = await mkdtemp(join(tmpdir(), 'usage-test2-'));
    try {
      const storage2 = new MemoryStorage();
      const withoutUsage = await writeSentinel({
        workspaceDir: dir2,
        storage: storage2,
        namespace: 'ns',
        dispatchId: 'u2',
      });
      expect(withoutUsage.usage).toBeUndefined();
      const uri2 = buildDispatchRecordUri('ns', 'u2', 'output.json');
      const parsed2 = JSON.parse(new TextDecoder().decode(await storage2.get(uri2)));
      expect(Object.keys(parsed2)).not.toContain('usage');
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  });

  it('usage round-trips stably (stored bytes match in-memory shape)', async () => {
    const usage: RuntimeUsage = { models: ['claude-haiku-3-5'], costUsd: 0.001, turns: 3, durationMs: 1200 };
    const sentinel = await writeSentinel({
      workspaceDir: dir,
      storage,
      namespace: 'ns',
      dispatchId: 'u3',
      usage,
    });
    expect(sentinel.usage).toEqual(usage);

    const { buildDispatchRecordUri } = await import('@quarry-systems/pangolin-core');
    const uri = buildDispatchRecordUri('ns', 'u3', 'output.json');
    const parsed = JSON.parse(new TextDecoder().decode(await storage.get(uri)));
    expect(parsed.usage).toEqual(usage);
  });

  it('a sentinel without usage is byte-identical to the pre-usage shape (golden discipline)', async () => {
    const optsBase = {
      workspaceDir: dir,
      storage,
      namespace: 'ns',
      dispatchId: 'u4',
      patchRef: 'pangolin://ns/artifact/u4/sha256:' + 'c'.repeat(64),
      summary: 'baseline',
    } as const;

    // Classic opts, no usage key.
    await writeSentinel(optsBase);

    const dir2 = await mkdtemp(join(tmpdir(), 'usage-test3-'));
    try {
      const storage2 = new MemoryStorage();
      await writeSentinel({
        ...optsBase,
        workspaceDir: dir2,
        storage: storage2,
        usage: undefined,
      });

      const { buildDispatchRecordUri } = await import('@quarry-systems/pangolin-core');
      const uri = buildDispatchRecordUri('ns', 'u4', 'output.json');
      const bytes1 = await storage.get(uri);
      const bytes2 = await storage2.get(uri);
      expect(bytes1).toEqual(bytes2);
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  });
});
