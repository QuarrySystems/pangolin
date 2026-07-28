// Proves the migrated sentinel-read path in src/index.ts: readSentinelBlocks
// (wired around @quarry-systems/pangolin-product's readOutputSentinel) reads
// blocks[] evidence back from a sentinel written at the same
// pangolin://<namespace>/dispatches/<dispatchId>/output.json convention the
// InprocWorkerExecutor test fixture (and, in production, the worker) writes
// to. This is the example's only way to verify the read path without running
// the full offline pipeline end to end.

import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStorageProvider } from '@quarry-systems/pangolin-storage-local';
import { readSentinelBlocks } from '../src/index.js';

const NAMESPACE = 'data-mapreduce-demo';

it('reads blocks[] from a sentinel written at the dispatch-record URI convention this example relies on', async () => {
  const storageDir = await mkdtemp(join(tmpdir(), 'data-mapreduce-sentinel-test-'));
  try {
    const storage = new LocalStorageProvider({ rootDir: storageDir });
    const dispatchId = 'run-map-a.csv-1';
    const sentinelUri = `pangolin://${NAMESPACE}/dispatches/${dispatchId}/output.json`;
    await storage.put(
      sentinelUri,
      new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 1,
          blocks: [
            { kind: 'script', ordinal: 0, status: 'ok', durationMs: 5 },
            { kind: 'capture', ordinal: 1, status: 'ok', durationMs: 1 },
          ],
        }),
      ),
    );

    const blocks = await readSentinelBlocks(storage, NAMESPACE, dispatchId);

    expect(blocks).toHaveLength(2);
    expect(blocks?.[0]).toMatchObject({ kind: 'script', ordinal: 0, status: 'ok' });
    expect(blocks?.[1]).toMatchObject({ kind: 'capture', ordinal: 1, status: 'ok' });
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

it('returns undefined when no sentinel was written for the dispatch', async () => {
  const storageDir = await mkdtemp(join(tmpdir(), 'data-mapreduce-sentinel-test-'));
  try {
    const storage = new LocalStorageProvider({ rootDir: storageDir });
    const blocks = await readSentinelBlocks(storage, NAMESPACE, 'nonexistent-dispatch');
    expect(blocks).toBeUndefined();
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});
