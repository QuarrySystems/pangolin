// Unit coverage for the `readUsage` helper migrated onto
// `@quarry-systems/pangolin-product`'s `readOutputSentinel` (spec §4 row 4).
// Deep sentinel-parsing mechanics (hostile-input matrix, schema versioning)
// are owned and tested in packages/pangolin-product — NOT re-tested here.
// This file proves only that the wiring src/index.ts relies on — dispatchId
// extraction from a manifestRef, and best-effort collapse of every failure
// mode to `undefined` (which the driver renders as "(not captured)") —
// behaves correctly against a real LocalStorageProvider.
//
// `src/index.ts` runs `main()` unconditionally when it is the process
// entrypoint (the DAG-run driver, gated behind an import.meta.url guard) and
// reads Claude credentials at module scope. PANGOLIN_FAKE=1 is set BEFORE the
// module is first imported so the credential gate is skipped and `main()`
// (which needs Docker / the fake runtime) never runs as a side effect of
// importing the module for its `readUsage` export.

process.env.PANGOLIN_FAKE = '1';

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStorageProvider } from '@quarry-systems/pangolin-storage-local';
import { buildPangolinUri, buildDispatchRecordUri } from '@quarry-systems/pangolin-core';
import type { StorageProvider, RuntimeUsage } from '@quarry-systems/pangolin-core';

const NAMESPACE = 'dogfood-gated-usage-read-test';

let readUsage: (
  deps: { storage: StorageProvider; namespace: string },
  manifestRef: string | undefined,
) => Promise<RuntimeUsage | undefined>;

beforeAll(async () => {
  const mod = await import('../src/index.js');
  readUsage = mod.readUsage;
});

/** manifestRef shape mirrors DispatchExecutor.fire — see dispatch.ts:151. */
function manifestRefFor(dispatchId: string): string {
  return buildPangolinUri({
    namespace: NAMESPACE,
    type: 'manifest',
    name: dispatchId,
    contentHash: 'sha256:deadbeef',
  });
}

async function withStorage(fn: (storage: StorageProvider) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pangolin-dogfood-usage-read-'));
  try {
    await fn(new LocalStorageProvider({ rootDir: root }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('dogfood-gated readUsage (readOutputSentinel migration)', () => {
  it('exports a callable readUsage function', () => {
    expect(typeof readUsage).toBe('function');
  });

  it('returns undefined when manifestRef is undefined (no dispatch to read)', async () => {
    await withStorage(async (storage) => {
      const usage = await readUsage({ storage, namespace: NAMESPACE }, undefined);
      expect(usage).toBeUndefined();
    });
  });

  it('returns undefined when no sentinel was ever written for the dispatch (best-effort, not captured)', async () => {
    await withStorage(async (storage) => {
      const usage = await readUsage(
        { storage, namespace: NAMESPACE },
        manifestRefFor('dispatch-absent'),
      );
      expect(usage).toBeUndefined();
    });
  });

  it('returns undefined when the sentinel exists but carries no usage block', async () => {
    await withStorage(async (storage) => {
      const dispatchId = 'dispatch-no-usage';
      await storage.put(
        buildDispatchRecordUri(NAMESPACE, dispatchId, 'output.json'),
        new TextEncoder().encode(JSON.stringify({ schemaVersion: 1 })),
      );
      const usage = await readUsage({ storage, namespace: NAMESPACE }, manifestRefFor(dispatchId));
      expect(usage).toBeUndefined();
    });
  });

  it('returns undefined when the sentinel is malformed JSON (best-effort, not captured)', async () => {
    await withStorage(async (storage) => {
      const dispatchId = 'dispatch-malformed';
      await storage.put(
        buildDispatchRecordUri(NAMESPACE, dispatchId, 'output.json'),
        new TextEncoder().encode('not-json'),
      );
      const usage = await readUsage({ storage, namespace: NAMESPACE }, manifestRefFor(dispatchId));
      expect(usage).toBeUndefined();
    });
  });

  it('returns the sealed usage block when the sentinel carries one', async () => {
    await withStorage(async (storage) => {
      const dispatchId = 'dispatch-with-usage';
      await storage.put(
        buildDispatchRecordUri(NAMESPACE, dispatchId, 'output.json'),
        new TextEncoder().encode(
          JSON.stringify({
            schemaVersion: 1,
            usage: { models: ['claude-opus'], costUsd: 0.42, turns: 3 },
          }),
        ),
      );
      const usage = await readUsage({ storage, namespace: NAMESPACE }, manifestRefFor(dispatchId));
      expect(usage).toEqual({ models: ['claude-opus'], costUsd: 0.42, turns: 3 });
    });
  });

  it('returns undefined (does not throw) when manifestRef is malformed', async () => {
    await withStorage(async (storage) => {
      const usage = await readUsage({ storage, namespace: NAMESPACE }, 'not-a-pangolin-uri');
      expect(usage).toBeUndefined();
    });
  });
});
