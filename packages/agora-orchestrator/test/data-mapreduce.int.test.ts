// packages/agora-orchestrator/test/data-mapreduce.int.test.ts
//
// Fully real, fully offline end-to-end data map-reduce proof:
//   - Real AgoraOrchestrator + real mapReduce pattern
//   - InprocWorkerExecutor (fires REAL runWorker executions of REAL script pipelines)
//   - LocalStorageProvider (shared content-addressed store)
//   - Real CSV → outputs → content-addressed datasets → manifests
//   - Provenance closure verified via assembleBundle/verifyBundle
//   - Crash-replay: fresh orchestrator over same store, zero duplicate items
//   - Numerical correctness: exact sums {a:3, b:7, c:5}
//
// CSV data: category,value / a,1 / a,2 / b,3 / b,4 / c,5
// Split: 2 rows/chunk → 3 parts (part-0.csv, part-1.csv, part-2.csv)
// Sums: a→3 (1+2), b→7 (3+4), c→5

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalStorageProvider } from '@quarry-systems/agora-storage-local';
import { AgoraClient } from '@quarry-systems/agora-client';
import { registerSubagent } from '@quarry-systems/agora-client';
import { registerPipeline } from '@quarry-systems/agora-client';
import { buildAgoraUri } from '@quarry-systems/agora-core';
import type { PipelineSpec } from '@quarry-systems/agora-core';

import { SqliteRunStateStore } from '../src/runstate/sqlite.js';
import { assembleBundle } from '../src/audit/bundle.js';
import { verifyBundle } from '../src/audit/verify-bundle.js';
import { mapReduce } from '../src/patterns/map-reduce.js';
import { LocalAnchor } from '../src/audit/anchor.js';
import { InprocWorkerExecutor } from './fixtures/inproc-worker-executor.js';
import { makeOrch, driveUntilDone, driveUntil } from './fixtures/pattern-harness.js';
import type { Run } from '../src/contracts/types.js';

// ---------------------------------------------------------------------------
// Namespace + storage
// ---------------------------------------------------------------------------

const NAMESPACE = 'test-data-mapreduce';

// ---------------------------------------------------------------------------
// Pipeline definitions (node -e for cross-platform compatibility)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Node.js script helpers — cross-platform (Windows cmd.exe + POSIX sh)
//
// The bounded-command runner uses shell:true (cmd.exe on Windows, /bin/sh on
// POSIX). We pass the JavaScript source as a separate args element via a
// temporary file written by the script, to avoid shell quoting nightmares.
//
// Actually: runBoundedCommand uses shell:true when args is not provided (a
// single command string). On Windows, cmd.exe interprets double-quoted args.
// We wrap JS code in double-quotes; the JS code itself uses only single-
// quotes, so no inner escaping is needed.
// ---------------------------------------------------------------------------

/** Build a `node -e "<code>"` command string safe for shell:true on Windows. */
function nodeEval(code: string): string {
  // code must not contain double-quote characters
  return `node -e "${code}"`;
}

/** Seed: writes a fixed CSV to outputs/dataset.csv */
const SEED_PIPELINE: PipelineSpec = {
  schemaVersion: 1,
  id: 'data.seed',
  blocks: [
    {
      kind: 'script',
      command: nodeEval(
        "const fs=require('fs');" +
        "fs.mkdirSync('outputs',{recursive:true});" +
        "fs.writeFileSync('outputs/dataset.csv','category,value\\na,1\\na,2\\nb,3\\nb,4\\nc,5');",
      ),
      timeoutSeconds: 30,
    },
    { kind: 'capture', what: 'outputs' },
  ],
};

/** Split: reads inputs/dataset, splits 2 rows/chunk → outputs/part-N.csv files */
const SPLIT_PIPELINE: PipelineSpec = {
  schemaVersion: 1,
  id: 'data.split',
  blocks: [
    {
      kind: 'script',
      command: nodeEval(
        "const fs=require('fs');" +
        "const data=fs.readFileSync('inputs/dataset','utf8');" +
        "const lines=data.trim().split('\\n').filter(l=>l.trim());" +
        "const header=lines[0];" +
        "const rows=lines.slice(1);" +
        "const chunkSize=2;" +
        "fs.mkdirSync('outputs',{recursive:true});" +
        "let i=0,part=0;" +
        "while(i<rows.length){const slice=rows.slice(i,i+chunkSize);fs.writeFileSync('outputs/part-'+part+'.csv',header+'\\n'+slice.join('\\n'));i+=chunkSize;part++;}",
      ),
      timeoutSeconds: 30,
    },
    { kind: 'capture', what: 'outputs' },
  ],
};

/** Transform (map): reads inputs/part, group-sums → outputs/result.json */
const TRANSFORM_PIPELINE: PipelineSpec = {
  schemaVersion: 1,
  id: 'data.transform',
  blocks: [
    {
      kind: 'script',
      command: nodeEval(
        "const fs=require('fs');" +
        "const data=fs.readFileSync('inputs/part','utf8');" +
        "const lines=data.trim().split('\\n').filter(l=>l.trim());" +
        "const rows=lines.slice(1);" +
        "const sums={};" +
        "for(const row of rows){const p=row.split(',');const cat=p[0];const val=Number(p[1]);sums[cat]=(sums[cat]||0)+val;}" +
        "fs.mkdirSync('outputs',{recursive:true});" +
        "fs.writeFileSync('outputs/result.json',JSON.stringify(sums));",
      ),
      timeoutSeconds: 30,
    },
    { kind: 'capture', what: 'outputs' },
  ],
};

/** Aggregate (reduce): reads all files in inputs/, merges partial sums → outputs/total.json */
const AGGREGATE_PIPELINE: PipelineSpec = {
  schemaVersion: 1,
  id: 'data.aggregate',
  blocks: [
    {
      kind: 'script',
      command: nodeEval(
        "const fs=require('fs');" +
        "const dir='inputs';" +
        "const total={};" +
        "if(fs.existsSync(dir)){const files=fs.readdirSync(dir).filter(f=>{try{return!fs.statSync(dir+'/'+f).isDirectory();}catch(e){return false;}});for(const f of files){const obj=JSON.parse(fs.readFileSync(dir+'/'+f,'utf8'));for(const k of Object.keys(obj)){total[k]=(total[k]||0)+Number(obj[k]);}}}" +
        "fs.mkdirSync('outputs',{recursive:true});" +
        "fs.writeFileSync('outputs/total.json',JSON.stringify(total));",
      ),
      timeoutSeconds: 30,
    },
    { kind: 'capture', what: 'outputs' },
  ],
};

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

interface TestFixtures {
  storageDir: string;
  storage: LocalStorageProvider;
  store: SqliteRunStateStore;
  executor: InprocWorkerExecutor;
  subagentUri: string;
  seedRef: string;
  splitRef: string;
  transformRef: string;
  aggregateRef: string;
}

/** Build a minimal AgoraClient for registration (no compute or targets needed). */
function makeClient(storage: LocalStorageProvider): AgoraClient {
  return new AgoraClient({
    namespace: NAMESPACE,
    compute: {},
    credentials: {},
    storage,
    targets: {},
  });
}

/** Register all pipelines + shared subagent; return pinned URIs. */
async function setupFixtures(storageDir: string): Promise<TestFixtures> {
  const storage = new LocalStorageProvider({ rootDir: storageDir });
  const store = new SqliteRunStateStore();
  const client = makeClient(storage);

  // Shared subagent (required by InprocWorkerExecutor for every item)
  const subagentHandle = await registerSubagent(client, {
    name: 'data-agent',
    promptTemplate: 'unused',
  });
  const subagentUri = buildAgoraUri({
    namespace: NAMESPACE,
    type: 'subagent',
    name: subagentHandle.name,
    contentHash: subagentHandle.contentHash,
  });

  // Register all four pipelines
  const seedPipelineRef = await registerPipeline(client, SEED_PIPELINE);
  const splitPipelineRef = await registerPipeline(client, SPLIT_PIPELINE);
  const transformPipelineRef = await registerPipeline(client, TRANSFORM_PIPELINE);
  const aggregatePipelineRef = await registerPipeline(client, AGGREGATE_PIPELINE);

  const seedRef = buildAgoraUri({
    namespace: NAMESPACE,
    type: 'pipeline',
    name: SEED_PIPELINE.id,
    contentHash: seedPipelineRef.contentHash,
  });
  const splitRef = buildAgoraUri({
    namespace: NAMESPACE,
    type: 'pipeline',
    name: SPLIT_PIPELINE.id,
    contentHash: splitPipelineRef.contentHash,
  });
  const transformRef = buildAgoraUri({
    namespace: NAMESPACE,
    type: 'pipeline',
    name: TRANSFORM_PIPELINE.id,
    contentHash: transformPipelineRef.contentHash,
  });
  const aggregateRef = buildAgoraUri({
    namespace: NAMESPACE,
    type: 'pipeline',
    name: AGGREGATE_PIPELINE.id,
    contentHash: aggregatePipelineRef.contentHash,
  });

  const executor = new InprocWorkerExecutor({ storage, namespace: NAMESPACE });

  return {
    storageDir,
    storage,
    store,
    executor,
    subagentUri,
    seedRef,
    splitRef,
    transformRef,
    aggregateRef,
  };
}

/** Build the run with seed + split items.
 *
 * The split item carries the mapReduce config. Map items get:
 *   - inputs from cfg.map.inputs (subagent + pipeline)
 *   - needs { part: { from: 'split', select: { kind: 'output', path: <key> } } }
 *   → the worker sees inputs/part in the workspace
 *
 * The reduce item gets:
 *   - inputs from cfg.reduce.inputs (subagent + pipeline)
 *   - needs { 'part-<k>': { from: 'map-<k>', select: { kind: 'output', path: 'result' } } }
 *   → the worker sees inputs/part-<k> for each map output
 *   → the aggregate pipeline reads all files in inputs/ dir
 */
function buildRun(
  runId: string,
  fx: Pick<TestFixtures, 'subagentUri' | 'seedRef' | 'splitRef' | 'transformRef' | 'aggregateRef'>,
): Run {
  return {
    id: runId,
    queue: 'default',
    items: [
      // Seed: no dependencies, writes dataset.csv
      {
        id: 'seed',
        executor: 'inproc',
        inputs: {
          subagent: fx.subagentUri,
          pipeline: fx.seedRef,
        },
        depends_on: [],
        resourceLocks: [],
      },
      // Split: reads dataset from seed via needs, carries mapReduce config
      {
        id: 'split',
        executor: 'inproc',
        inputs: {
          subagent: fx.subagentUri,
          pipeline: fx.splitRef,
          mapReduce: {
            map: {
              executor: 'inproc',
              inputs: {
                subagent: fx.subagentUri,
                pipeline: fx.transformRef,
              },
              needsKey: 'part',
              outputPath: 'result.json',
            },
            reduce: {
              executor: 'inproc',
              inputs: {
                subagent: fx.subagentUri,
                pipeline: fx.aggregateRef,
              },
              keyPrefix: 'part',
            },
          },
        },
        depends_on: [],
        resourceLocks: [],
        needs: {
          dataset: {
            from: 'seed',
            select: { kind: 'output' as const, path: 'dataset.csv' },
          },
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Test suite lifecycle
// ---------------------------------------------------------------------------

let storageDir: string;

beforeEach(async () => {
  storageDir = await mkdtemp(join(tmpdir(), 'data-mr-storage-'));
});

afterEach(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Scenario 1 — Happy path: full run, all 6 items done, provenance closure
// ---------------------------------------------------------------------------

describe('data-mapreduce integration — happy path', () => {
  it('runs seed→split→map*3→reduce, all items done, provenance closure passes', async () => {
    const fx = await setupFixtures(storageDir);
    const { orch, anchor } = makeOrch(fx.store, fx.executor, {
      executors: { inproc: fx.executor },
      queues: { default: { concurrency: 5, pattern: mapReduce } },
    });

    const runId = orch.submitRun(buildRun('data-mr-happy', fx), 'human:test');
    await driveUntilDone(orch, 128, runId);

    // 1. Final graph: all 6 items done; N=3 map items derived from CSV
    const statuses = orch.getStatus(runId);
    const ids = statuses.map((s) => s.id).sort();
    expect(ids).toContain('seed');
    expect(ids).toContain('split');
    expect(ids).toContain('map-part-0.csv');
    expect(ids).toContain('map-part-1.csv');
    expect(ids).toContain('map-part-2.csv');
    expect(ids).toContain('reduce');
    expect(ids).toHaveLength(6);

    for (const s of statuses) {
      expect(s.status, `item '${s.id}' should be done`).toBe('done');
    }

    // 2. Audit: exactly two 'run.extended' entries (map batch + reduce), actor 'pattern:default'
    const exp = orch.getAuditExport(runId);
    expect(exp.root).toBeDefined();

    const extendedEntries = exp.entries.filter((e) => e.kind === 'run.extended');
    expect(extendedEntries).toHaveLength(2);
    for (const entry of extendedEntries) {
      expect(entry.actor).toBe('pattern:default');
      expect(entry.itemId).toBeDefined();
    }

    // 3. provenance closure: assembleBundle + verifyBundle
    // The InprocWorkerExecutor stores manifests in the shared LocalStorageProvider
    const storage = fx.storage;
    const bundle = await assembleBundle(exp, { anchor, storage });
    const report = await verifyBundle(bundle, { anchor });

    expect(report.intact).toBe(true);
    expect(report.checks.handoff.ok).toBe(true);
    expect(report.checks.handoff.detail).toContain('accounted for');

    // 4. Every spawned consumer (map-* and reduce) has a manifest sealing inputRefs AND pipelineRef
    const spawnedIds = ['map-part-0.csv', 'map-part-1.csv', 'map-part-2.csv', 'reduce'];
    for (const itemId of spawnedIds) {
      const manifest = bundle.manifests.find((m) => m.itemId === itemId);
      expect(manifest, `manifest for '${itemId}' should exist`).toBeDefined();
      // inputRefs sealed (needs were resolved)
      expect(manifest!.inputRefs, `'${itemId}' should have inputRefs`).toBeDefined();
      // pipelineRef sealed
      expect(manifest!.pipelineRef, `'${itemId}' should have pipelineRef`).toBeDefined();
    }

    fx.store.close();
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — Numerical correctness (separate it for clear failure isolation)
// ---------------------------------------------------------------------------

describe('data-mapreduce integration — numerical correctness', () => {
  it('total.json contains exact sums {a:3, b:7, c:5}', async () => {
    const fx = await setupFixtures(storageDir);
    const { orch } = makeOrch(fx.store, fx.executor, {
      executors: { inproc: fx.executor },
      queues: { default: { concurrency: 5, pattern: mapReduce } },
    });

    const runId = orch.submitRun(buildRun('data-mr-sums', fx), 'human:test');
    await driveUntilDone(orch, 128, runId);

    // Find reduce item's output for 'total.json'
    const statuses = orch.getStatus(runId);
    const reduceStatus = statuses.find((s) => s.id === 'reduce');
    expect(reduceStatus).toBeDefined();
    expect(reduceStatus!.status).toBe('done');

    // Export shows outputRefs on the reduce item
    const exp = orch.getAuditExport(runId);
    const reduceItem = exp.items.find((i) => i.id === 'reduce');
    expect(reduceItem).toBeDefined();
    expect(reduceItem!.outputRefs).toBeDefined();
    expect(reduceItem!.outputRefs!['total.json']).toBeDefined();

    // Fetch total.json bytes from storage
    const totalRef = reduceItem!.outputRefs!['total.json'];
    const totalBytes = await fx.storage.get(totalRef);
    const totalJson = JSON.parse(new TextDecoder().decode(totalBytes)) as Record<string, number>;

    // Exact numerical sums
    expect(totalJson).toEqual({ a: 3, b: 7, c: 5 });

    fx.store.close();
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — Crash-replay: fresh orchestrator, same store + executor, no duplication
// ---------------------------------------------------------------------------

describe('data-mapreduce integration — crash-replay', () => {
  it('second orchestrator over same store completes with zero duplicate items', async () => {
    const fx = await setupFixtures(storageDir);

    // First orchestrator: drives until map items are spawned (after split is done)
    const { orch: orch1 } = makeOrch(fx.store, fx.executor, {
      executors: { inproc: fx.executor },
      queues: { default: { concurrency: 5, pattern: mapReduce } },
    });

    const runId = orch1.submitRun(buildRun('data-mr-replay', fx), 'human:test');

    // Drive until the map items exist (split is done)
    await driveUntil(orch1, () => {
      const ids = orch1.getStatus(runId).map((s) => s.id);
      return ids.includes('map-part-0.csv') && ids.includes('reduce') === false;
    }, 64);

    // "Crash" — create fresh orchestrator over the SAME store and SAME executor instance
    // IMPORTANT: reuse the same InprocWorkerExecutor instance to preserve its attempt counter
    const { orch: orch2 } = makeOrch(fx.store, fx.executor, {
      executors: { inproc: fx.executor },
      queues: { default: { concurrency: 5, pattern: mapReduce } },
    });

    // Recover stranded items (those left 'running' by the crashed orch1)
    orch2.recoverStranded();

    // Drive to full completion
    await driveUntilDone(orch2, 128, runId);

    // All 6 items terminal, no duplicates
    const statuses = orch2.getStatus(runId);
    const ids = statuses.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect(ids.sort()).toEqual([
      'map-part-0.csv',
      'map-part-1.csv',
      'map-part-2.csv',
      'reduce',
      'seed',
      'split',
    ]);
    expect(statuses.every((s) => ['done', 'failed'].includes(s.status))).toBe(true);

    fx.store.close();
  });
});
