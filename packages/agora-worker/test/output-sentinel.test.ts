// Tests for escapeWorkspace (output-sentinel.ts).
//
// Uses an in-memory StorageProvider stub so no real storage or git infra is
// required. The patch-capture integration (actual git diffs) is exercised by
// patch-capture.test.ts; here we exercise the sentinel shape, artifact upload,
// and the two-write (patchRef + dispatch record) contract.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildDispatchRecordUri, type StorageProvider } from '@quarry-systems/agora-core';
import { captureBaseline, type WorkspaceBaseline } from '../src/patch-capture.js';
import { escapeWorkspace } from '../src/output-sentinel.js';

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

  it('writes .agora/output.json in-workspace', async () => {
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
      await readFile(join(dir, '.agora', 'output.json'), 'utf-8'),
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
