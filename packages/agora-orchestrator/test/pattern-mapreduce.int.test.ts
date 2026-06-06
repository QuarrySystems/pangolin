// packages/agora-orchestrator/test/pattern-mapreduce.int.test.ts
//
// End-to-end offline proof of dynamic-spawn provability (design spec §9):
// a fake splitter "produces" N=3 outputs (unknown at submit time), the map-reduce
// pattern spawns 3 maps + a reduce, and the sealed run passes provenance closure.
//
// Mirrors test/handoff-dag.int.test.ts for the assembleBundle/verifyBundle wiring.

import { describe, it, expect } from 'vitest';
import { SqliteRunStateStore } from '../src/runstate/sqlite.js';
import { assembleBundle } from '../src/audit/bundle.js';
import { verifyBundle } from '../src/audit/verify-bundle.js';
import { mapReduce } from '../src/patterns/map-reduce.js';
import {
  idKeyedExecutor,
  makeOrch,
  driveUntilDone,
  driveUntil,
  storageFromBlobs,
} from './fixtures/pattern-harness.js';
import type { Run } from '../src/contracts/types.js';

// ---------------------------------------------------------------------------
// Content-addressed fake URIs (sha256-shaped, distinct per artifact)
// ---------------------------------------------------------------------------

const REF_A = 'agora://ns/artifact/a/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REF_B = 'agora://ns/artifact/b/sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const REF_C = 'agora://ns/artifact/c/sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const REF_MAP_A = 'agora://ns/artifact/map-a/sha256:1111111111111111111111111111111111111111111111111111111111111111';
const REF_MAP_B = 'agora://ns/artifact/map-b/sha256:2222222222222222222222222222222222222222222222222222222222222222';
const REF_MAP_C = 'agora://ns/artifact/map-c/sha256:3333333333333333333333333333333333333333333333333333333333333333';

// ---------------------------------------------------------------------------
// Behavior map factory
//
// Item names after de-namespace (as passed by idKeyedExecutor to the behavior fn):
//   'split'       → done + outputRefs { 'a.json': REF_A, 'b.json': REF_B, 'c.json': REF_C }
//   'map-a.json'  → done + outputRefs { result: REF_MAP_A }
//   'map-b.json'  → done + outputRefs { result: REF_MAP_B }
//   'map-c.json'  → done + outputRefs { result: REF_MAP_C }
//   'reduce'      → done
// ---------------------------------------------------------------------------

function happyBehavior(itemId: string) {
  if (itemId === 'split') {
    return {
      status: 'done' as const,
      outputRefs: { 'a.json': REF_A, 'b.json': REF_B, 'c.json': REF_C },
    };
  }
  if (itemId === 'map-a.json') {
    return { status: 'done' as const, outputRefs: { result: REF_MAP_A } };
  }
  if (itemId === 'map-b.json') {
    return { status: 'done' as const, outputRefs: { result: REF_MAP_B } };
  }
  if (itemId === 'map-c.json') {
    return { status: 'done' as const, outputRefs: { result: REF_MAP_C } };
  }
  // reduce and anything else
  return { status: 'done' as const };
}

// ---------------------------------------------------------------------------
// The run submitted to the orchestrator — ONLY the splitter item
// The maps and reduce are spawned dynamically by the mapReduce pattern.
// ---------------------------------------------------------------------------

const SPLITTER_RUN_BASE: Omit<Run, 'id'> = {
  queue: 'default',
  items: [
    {
      id: 'split',
      executor: 'dispatch',
      inputs: {
        mapReduce: {
          map: { executor: 'dispatch', inputs: {} },
          reduce: { executor: 'dispatch', inputs: {} },
        },
      },
      depends_on: [],
      resourceLocks: [],
    },
  ],
};

// ---------------------------------------------------------------------------
// Scenario 1 — Happy path
// ---------------------------------------------------------------------------

describe('pattern-mapreduce integration — happy path', () => {
  it('spawns maps + reduce, seals run, and verifyBundle reports intact with handoff.ok === true', async () => {
    const blobs = new Map<string, Uint8Array>();
    const store = new SqliteRunStateStore();

    const executor = idKeyedExecutor(blobs, happyBehavior);
    const { orch, anchor } = makeOrch(store, executor, {
      queues: { default: { concurrency: 5, pattern: mapReduce } },
    });

    const runId = orch.submitRun({ ...SPLITTER_RUN_BASE, id: 'mr-happy' }, 'human:test');
    await driveUntilDone(orch, 64, runId);

    // 1a. All expected items are done
    const statuses = orch.getStatus(runId);
    const ids = statuses.map((s) => s.id).sort();
    expect(ids).toEqual(['map-a.json', 'map-b.json', 'map-c.json', 'reduce', 'split']);
    for (const s of statuses) {
      expect(s.status).toBe('done');
    }

    // 1b. Run sealed (root present)
    const exp = orch.getAuditExport(runId);
    expect(exp.root).toBeDefined();

    // 1c. Exactly two 'run.extended' entries (map-batch + reduce), each with
    //     actor 'pattern:default' and a causeItemId (stored as entry.itemId)
    const extendedEntries = exp.entries.filter((e) => e.kind === 'run.extended');
    expect(extendedEntries).toHaveLength(2);
    for (const entry of extendedEntries) {
      expect(entry.actor).toBe('pattern:default');
      // causeItemId is stored in the entry.itemId field by extendRun
      expect(entry.itemId).toBeDefined();
    }

    // 1d. assembleBundle → verifyBundle passes provenance closure
    const storage = storageFromBlobs(blobs);
    const bundle = await assembleBundle(exp, { anchor, storage });
    const report = await verifyBundle(bundle, { anchor });

    expect(report.intact).toBe(true);
    expect(report.checks.handoff.ok).toBe(true);
    // There should be >0 handoff edges (maps seal inputRefs, reduce seals inputRefs)
    expect(report.checks.handoff.detail).toContain('accounted for');

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — Failed map: reduce must not spawn
// ---------------------------------------------------------------------------

describe('pattern-mapreduce integration — failed map', () => {
  it('when map-b.json fails terminally, reduce never spawns and run settles with failure recorded', async () => {
    const blobs = new Map<string, Uint8Array>();
    const store = new SqliteRunStateStore();

    // map-b.json always fails; use maxAttempts=1 to settle immediately
    const failingBehavior = (itemId: string) => {
      if (itemId === 'split') {
        return {
          status: 'done' as const,
          outputRefs: { 'a.json': REF_A, 'b.json': REF_B, 'c.json': REF_C },
        };
      }
      if (itemId === 'map-b.json') return { status: 'failed' as const };
      if (itemId === 'map-a.json') {
        return { status: 'done' as const, outputRefs: { result: REF_MAP_A } };
      }
      if (itemId === 'map-c.json') {
        return { status: 'done' as const, outputRefs: { result: REF_MAP_C } };
      }
      return { status: 'done' as const };
    };

    const executor = idKeyedExecutor(blobs, failingBehavior);
    const { orch } = makeOrch(store, executor, {
      queues: { default: { concurrency: 5, pattern: mapReduce } },
      maxAttempts: 1,
    });

    const runId = orch.submitRun({ ...SPLITTER_RUN_BASE, id: 'mr-failmap' }, 'human:test');
    await driveUntilDone(orch, 64, runId);

    const statuses = orch.getStatus(runId);
    const ids = statuses.map((s) => s.id).sort();

    // Reduce must NOT be present
    expect(ids).not.toContain('reduce');

    // map-b.json must have failed
    const mapB = statuses.find((s) => s.id === 'map-b.json');
    expect(mapB?.status).toBe('failed');

    // Run sealed (root present — failure is still a terminal sealed run)
    const exp = orch.getAuditExport(runId);
    expect(exp.root).toBeDefined();

    // At least one 'run.extended' entry for the map-batch spawn
    const extendedEntries = exp.entries.filter((e) => e.kind === 'run.extended');
    expect(extendedEntries.length).toBeGreaterThanOrEqual(1);

    store.close();
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — Crash-replay: second orchestrator over same store completes
//              the run without duplicating items
// ---------------------------------------------------------------------------

describe('pattern-mapreduce integration — crash-replay', () => {
  it('second orchestrator over same store completes the run with no duplicate items', async () => {
    const blobs = new Map<string, Uint8Array>();
    const store = new SqliteRunStateStore();

    const executor = idKeyedExecutor(blobs, happyBehavior);
    const { orch: orch1 } = makeOrch(store, executor, {
      queues: { default: { concurrency: 5, pattern: mapReduce } },
    });

    const runId = orch1.submitRun({ ...SPLITTER_RUN_BASE, id: 'mr-replay' }, 'human:test');

    // Drive until the maps exist in the store (splitter done + map items spawned)
    await driveUntil(orch1, () => {
      const ids = orch1.getStatus(runId).map((s) => s.id);
      return ids.includes('map-a.json') && ids.includes('map-b.json') && ids.includes('map-c.json');
    }, 32);

    // "Crash" — create a second orchestrator over the same store (same executor is fine)
    const { orch: orch2 } = makeOrch(store, executor, {
      queues: { default: { concurrency: 5, pattern: mapReduce } },
    });

    // Drive to completion with the second orchestrator
    await driveUntilDone(orch2, 64, runId);

    // All items terminal and no duplicates
    const statuses = orch2.getStatus(runId);
    const ids = statuses.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect(ids.sort()).toEqual(['map-a.json', 'map-b.json', 'map-c.json', 'reduce', 'split']);
    expect(statuses.every((s) => s.status === 'done')).toBe(true);

    store.close();
  });
});
