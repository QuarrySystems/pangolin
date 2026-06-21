// data-mapreduce — offline data-domain demo.
//
// Proves the map-reduce pattern works for a second domain (data) with zero
// engine changes. The pipeline executes real script blocks via the
// InprocWorkerExecutor test fixture — no Docker, no API key.
//
// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
// WARNING: InprocWorkerExecutor BYPASSES CONTAINER ISOLATION.
// It runs worker pipelines IN-PROCESS (no sandbox, no network firewall,
// no filesystem isolation). This executor is a test/demo bridge ONLY —
// it MUST NEVER be used in production. See:
//   packages/pangolin-orchestrator/test/fixtures/inproc-worker-executor.ts
// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
//
// Flow:
//   seed          — writes a small CSV to outputs/data.csv (two groups: a, b)
//   split         — reads inputs/input (seed's CSV), splits by group column,
//                   writes one file per group to outputs/ (a.csv, b.csv)
//                   [mapReduce config → pattern spawns map-a.csv + map-b.csv + reduce]
//   map-a.csv     — sums values in group a (10+20=30), writes outputs/result
//   map-b.csv     — sums values in group b (30+40=70), writes outputs/result
//   reduce        — reads inputs/part-a.csv + inputs/part-b.csv, totals (100),
//                   writes outputs/result
//
// Expected numeric result: 100
//
// Run: pnpm --filter data-mapreduce-example start

import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PangolinOrchestrator,
  ManualTrigger,
  SqliteRunStateStore,
  AuditLog,
  NoneSigner,
  LocalAnchor,
  mapReduce,
  assembleBundle,
  verifyBundle,
} from '@quarry-systems/pangolin-orchestrator';
import type { Run, ItemState } from '@quarry-systems/pangolin-orchestrator';
import {
  PangolinClient,
  registerSubagent,
  registerPipeline,
} from '@quarry-systems/pangolin-client';
import type { PipelineRef } from '@quarry-systems/pangolin-client';
import { LocalStorageProvider } from '@quarry-systems/pangolin-storage-local';

// Import the InprocWorkerExecutor from the orchestrator test fixture.
// tsx compiles workspace TS directly, resolving workspace:* packages in-source.
// WARNING: bypasses container isolation — demo/test bridge only, never production.
import { InprocWorkerExecutor } from '../../../packages/pangolin-orchestrator/test/fixtures/inproc-worker-executor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAN_PATH = join(__dirname, '../plan.json');
const NAMESPACE = 'data-mapreduce-demo';

// ---------------------------------------------------------------------------
// Local URI helpers — avoids importing @quarry-systems/pangolin-core directly
// (it's not in this example's dependencies; only its peer-packages are).
// ---------------------------------------------------------------------------

/** Builds a pinned pangolin:// URI: pangolin://<ns>/<type>/<name>/<contentHash> */
function buildPinnedUri(
  namespace: string,
  type: string,
  name: string,
  contentHash: string,
): string {
  return `pangolin://${namespace}/${type}/${name}/${contentHash}`;
}

/** Builds a dispatch-record URI: pangolin://<ns>/dispatches/<dispatchId>/<suffix> */
function buildDispatchUri(namespace: string, dispatchId: string, suffix: string): string {
  return `pangolin://${namespace}/dispatches/${dispatchId}/${suffix}`;
}

// ---------------------------------------------------------------------------
// Minimal local PipelineSpec type (structurally compatible with pangolin-core's).
// Avoids importing @quarry-systems/pangolin-core directly.
// ---------------------------------------------------------------------------

interface LocalBlockSpec {
  kind: 'script' | 'capture' | 'agent';
  command?: string;
  timeoutSeconds?: number;
  what?: 'patch' | 'outputs';
}

interface LocalPipelineSpec {
  schemaVersion: 1;
  id: string;
  blocks: LocalBlockSpec[];
}

// ---------------------------------------------------------------------------
// Pipeline specs (script-only — no agent blocks, no Docker)
// ---------------------------------------------------------------------------

/** seed: writes the CSV to outputs/data.csv */
const seedPipelineSpec: LocalPipelineSpec = {
  schemaVersion: 1,
  id: 'data-mapreduce.seed',
  blocks: [
    {
      kind: 'script',
      command: [
        'node',
        '-e',
        `"const fs=require('fs');` +
          `fs.mkdirSync('outputs',{recursive:true});` +
          `fs.writeFileSync('outputs/data.csv','group,value\\na,10\\na,20\\nb,30\\nb,40\\n');"`,
      ].join(' '),
      timeoutSeconds: 30,
    },
    { kind: 'capture', what: 'outputs' },
  ],
};

/** split: reads inputs/input (the CSV), groups by first column, writes one file per group */
const splitPipelineSpec: LocalPipelineSpec = {
  schemaVersion: 1,
  id: 'data-mapreduce.split',
  blocks: [
    {
      kind: 'script',
      command: [
        'node',
        '-e',
        `"const fs=require('fs');` +
          `const csv=fs.readFileSync('inputs/input','utf8');` +
          `const lines=csv.trim().split('\\n').slice(1);` +
          `const groups={};` +
          `for(const l of lines){const[g,v]=l.split(',');groups[g]=groups[g]||[];groups[g].push(l);}` +
          `fs.mkdirSync('outputs',{recursive:true});` +
          `for(const[g,ls]of Object.entries(groups)){` +
          `fs.writeFileSync('outputs/'+g+'.csv','group,value\\n'+ls.join('\\n')+'\\n');` +
          `}"`,
      ].join(' '),
      timeoutSeconds: 30,
    },
    { kind: 'capture', what: 'outputs' },
  ],
};

/** transform: sums the value column of one group's CSV (received at inputs/input) */
const transformPipelineSpec: LocalPipelineSpec = {
  schemaVersion: 1,
  id: 'data-mapreduce.transform',
  blocks: [
    {
      kind: 'script',
      command: [
        'node',
        '-e',
        `"const fs=require('fs');` +
          `const csv=fs.readFileSync('inputs/input','utf8');` +
          `const lines=csv.trim().split('\\n').slice(1);` +
          `const sum=lines.reduce((s,l)=>s+Number(l.split(',')[1]),0);` +
          `fs.mkdirSync('outputs',{recursive:true});` +
          `fs.writeFileSync('outputs/result',String(sum));"`,
      ].join(' '),
      timeoutSeconds: 30,
    },
    { kind: 'capture', what: 'outputs' },
  ],
};

/** aggregate: reads all input files (part-<group>) and totals them */
const aggregatePipelineSpec: LocalPipelineSpec = {
  schemaVersion: 1,
  id: 'data-mapreduce.aggregate',
  blocks: [
    {
      kind: 'script',
      command: [
        'node',
        '-e',
        `"const fs=require('fs');` +
          `let total=0;` +
          `try{` +
          `const files=fs.readdirSync('inputs');` +
          `for(const f of files){total+=Number(fs.readFileSync('inputs/'+f,'utf8').trim());}` +
          `}catch(e){}` +
          `fs.mkdirSync('outputs',{recursive:true});` +
          `fs.writeFileSync('outputs/result',String(total));"`,
      ].join(' '),
      timeoutSeconds: 30,
    },
    { kind: 'capture', what: 'outputs' },
  ],
};

// ---------------------------------------------------------------------------
// Registration: build pinned URIs for all four pipelines + one shared subagent
// ---------------------------------------------------------------------------

async function registerAll(client: PangolinClient): Promise<{
  subagentUri: string;
  seedPipelineUri: string;
  splitPipelineUri: string;
  transformPipelineUri: string;
  aggregatePipelineUri: string;
}> {
  // One shared subagent stub (never invoked — pipelines are script-only)
  const subagentHandle = await registerSubagent(client, {
    name: 'data-stub',
    promptTemplate: 'unused',
  });
  const subagentUri = buildPinnedUri(
    NAMESPACE,
    'subagent',
    subagentHandle.name,
    subagentHandle.contentHash,
  );

  const reg = async (spec: LocalPipelineSpec): Promise<string> => {
    // Cast to the type registerPipeline expects — structurally compatible.
    const ref: PipelineRef = await registerPipeline(
      client,
      spec as Parameters<typeof registerPipeline>[1],
    );
    return buildPinnedUri(NAMESPACE, 'pipeline', spec.id, ref.contentHash);
  };

  const [seedPipelineUri, splitPipelineUri, transformPipelineUri, aggregatePipelineUri] =
    await Promise.all([
      reg(seedPipelineSpec),
      reg(splitPipelineSpec),
      reg(transformPipelineSpec),
      reg(aggregatePipelineSpec),
    ]);

  return {
    subagentUri,
    seedPipelineUri,
    splitPipelineUri,
    transformPipelineUri,
    aggregatePipelineUri,
  };
}

// ---------------------------------------------------------------------------
// Deep-replace all "<filled-at-runtime>" strings in a parsed object
// ---------------------------------------------------------------------------

function fillPlaceholders(
  value: unknown,
  replacer: (key: string, path: string[]) => string,
  path: string[] = [],
  parentKey = '',
): unknown {
  if (typeof value === 'string' && value === '<filled-at-runtime>') {
    return replacer(parentKey, path);
  }
  if (Array.isArray(value)) {
    return value.map((v: unknown, i: number) =>
      fillPlaceholders(v, replacer, [...path, String(i)], String(i)),
    );
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = fillPlaceholders(v, replacer, [...path, k], k);
    }
    return result;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Drive loop
// ---------------------------------------------------------------------------

async function driveUntilDone(
  orch: PangolinOrchestrator,
  runId: string,
  maxTicks = 100,
): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    await orch.tick('default');
    const statuses = orch.getStatus(runId).map((s) => s.status);
    if (
      statuses.length > 0 &&
      statuses.every((s) => ['done', 'failed', 'skipped', 'cancelled'].includes(s))
    ) {
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Allocate a temp directory for shared local storage (bundles + dispatch records).
  const storageDir = await mkdtemp(join(tmpdir(), 'data-mapreduce-storage-'));
  const store = new SqliteRunStateStore();

  try {
    // Build the shared LocalStorageProvider — used by both the client (registration)
    // and the InprocWorkerExecutor (bundle fetch + output writes).
    const storage = new LocalStorageProvider({ rootDir: storageDir });

    // Build the PangolinClient for registration (no network, no compute).
    const client = new PangolinClient({
      namespace: NAMESPACE,
      compute: {},
      credentials: {},
      storage,
      targets: {},
    });

    // Register all bundles and collect their pinned URIs.
    const refs = await registerAll(client);
    console.log('=== Registered bundles ===');
    console.log(`  subagent:   ${refs.subagentUri}`);
    console.log(`  seed:       ${refs.seedPipelineUri}`);
    console.log(`  split:      ${refs.splitPipelineUri}`);
    console.log(`  transform:  ${refs.transformPipelineUri}`);
    console.log(`  aggregate:  ${refs.aggregatePipelineUri}`);

    // Build the InprocWorkerExecutor backed by the shared storage.
    const executor = new InprocWorkerExecutor({ storage, namespace: NAMESPACE });

    // Wire up the orchestrator (mapReduce pattern — spawns maps + reduce dynamically).
    const anchor = new LocalAnchor(store);
    const auditLog = new AuditLog({ store, signer: NoneSigner, anchor });

    const orch = new PangolinOrchestrator({
      store,
      executors: { dispatch: executor },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 8, pattern: mapReduce } },
      auditLog,
    });

    // Load plan.json (has "<filled-at-runtime>" placeholders for pipeline/subagent refs).
    const raw = await readFile(PLAN_PATH, 'utf-8');
    const planTemplate = JSON.parse(raw) as Run;

    // Fill in the registered pinned URIs.
    //
    // Mapping rules (by key name + path context):
    //   "subagent"  → shared subagent URI (all items share the same stub)
    //   "pipeline"  → discriminated by path context:
    //     path contains 'mapReduce' and '.map.'    → transformPipelineUri
    //     path contains 'mapReduce' and '.reduce.' → aggregatePipelineUri
    //     item.id 'seed'                           → seedPipelineUri
    //     item.id 'split'                          → splitPipelineUri

    const filledItems = planTemplate.items.map((item) => {
      const itemId = item.id;
      return fillPlaceholders(item, (key, path) => {
        if (key === 'subagent') return refs.subagentUri;
        if (key === 'pipeline') {
          const pathStr = path.join('.');
          if (pathStr.includes('mapReduce') && pathStr.includes('.map.')) {
            return refs.transformPipelineUri;
          }
          if (pathStr.includes('mapReduce') && pathStr.includes('.reduce.')) {
            return refs.aggregatePipelineUri;
          }
          return itemId === 'seed' ? refs.seedPipelineUri : refs.splitPipelineUri;
        }
        return '<unresolved>';
      }) as typeof item;
    });

    const plan: Run = { ...planTemplate, items: filledItems };

    console.log('\n=== Submitting run ===');
    console.log(`  items: ${plan.items.map((i) => i.id).join(', ')}`);

    const runId = await orch.submitRun(plan, 'human:demo');

    // Drive until all items terminal.
    await driveUntilDone(orch, runId);

    // ---------------------------------------------------------------------------
    // (1) Grown graph — id + status (submitted 2, pattern grew dynamically)
    // ---------------------------------------------------------------------------
    const statuses = orch.getStatus(runId);
    console.log('\n=== Grown graph (2 submitted → seed+split+maps+reduce) ===');
    for (const s of statuses.sort((a, b) => a.id.localeCompare(b.id))) {
      console.log(`  ${s.id}: ${s.status}`);
    }
    console.log(`  Total items: ${statuses.length}`);

    // ---------------------------------------------------------------------------
    // (2) Aggregate numeric result — fetched from reduce's outputRef
    //
    // SqliteRunStateStore.getItems() returns the full ItemState including
    // outputRefs and dispatchHash — not exposed by getStatus().
    // ---------------------------------------------------------------------------
    const rawItems: ItemState[] = store.getItems(runId);

    // De-namespace: internal ids are '<runId>\x1f<itemId>' — strip the prefix.
    // The orchestrator uses ASCII unit-separator (\x1f) as the namespace delimiter.
    const NS_SEP = '\x1f';
    const deNs = (id: string): string => {
      const i = id.indexOf(NS_SEP);
      return i < 0 ? id : id.slice(i + 1);
    };
    const itemById = new Map(rawItems.map((i) => [deNs(i.id), i]));

    const reduceItem = itemById.get('reduce');
    let aggregateResult = '<not found>';
    if (reduceItem?.outputRefs?.['result']) {
      const resultRef = reduceItem.outputRefs['result'];
      try {
        const bytes = await storage.get(resultRef);
        aggregateResult = new TextDecoder().decode(bytes).trim();
      } catch (e) {
        aggregateResult = `<fetch error: ${(e as Error).message}>`;
      }
    }
    console.log('\n=== Aggregate numeric result (reduce outputRef) ===');
    console.log(`  reduce result: ${aggregateResult}`);

    // ---------------------------------------------------------------------------
    // (3) blocks[] evidence sample — sentinel of one map item (map-a.csv)
    //
    // The InprocWorkerExecutor stores the output sentinel (output.json) at:
    //   pangolin://<namespace>/dispatches/<dispatchId>/output.json
    // The dispatchId is embedded in dispatchHash as 'inproc-<dispatchId>'.
    // ---------------------------------------------------------------------------
    console.log('\n=== blocks[] evidence sample (sentinel of map-a.csv) ===');
    const mapAItem = itemById.get('map-a.csv');
    if (mapAItem?.dispatchHash) {
      const dispatchId = mapAItem.dispatchHash.replace(/^inproc-/, '');
      const sentinelUri = buildDispatchUri(NAMESPACE, dispatchId, 'output.json');
      try {
        const sentinelBytes = await storage.get(sentinelUri);
        const sentinel = JSON.parse(new TextDecoder().decode(sentinelBytes)) as {
          blocks?: Array<{ kind: string; ordinal: number; status: string }>;
        };
        if (sentinel.blocks && sentinel.blocks.length > 0) {
          console.log(`  sentinel.blocks (${sentinel.blocks.length} entries):`);
          for (const b of sentinel.blocks) {
            console.log(`    [${b.ordinal}] kind=${b.kind} status=${b.status}`);
          }
        } else {
          console.log(
            '  sentinel.blocks: (empty or missing — script pipelines write blocks only when declared)',
          );
        }
      } catch (e) {
        console.log(`  sentinel read error: ${(e as Error).message}`);
      }
    } else {
      console.log('  map-a.csv item not found or no dispatchHash');
    }

    // ---------------------------------------------------------------------------
    // (4) Sealed pipelineRefs per spawned item (from their manifest blobs)
    // ---------------------------------------------------------------------------
    console.log('\n=== Sealed pipelineRefs per item ===');
    for (const [id, item] of Array.from(itemById.entries()).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (item.manifestRef) {
        try {
          const manifestBytes = await storage.get(item.manifestRef);
          const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
            pipelineRef?: string;
          };
          const pRef = manifest.pipelineRef;
          if (pRef) {
            console.log(`  ${id}: pipelineRef=${pRef.slice(0, 80)}…`);
          } else {
            console.log(`  ${id}: (no pipelineRef in manifest)`);
          }
        } catch {
          console.log(`  ${id}: manifest fetch error`);
        }
      } else {
        console.log(`  ${id}: (no manifestRef)`);
      }
    }

    // ---------------------------------------------------------------------------
    // (5) verifyBundle report — provenance closure
    // ---------------------------------------------------------------------------
    console.log('\n=== verifyBundle report ===');
    const exp = orch.getAuditExport(runId);
    const storageAdapter = {
      async get(ref: string): Promise<Uint8Array> {
        return storage.get(ref);
      },
    };
    const bundle = await assembleBundle(exp, { anchor, storage: storageAdapter });
    const report = await verifyBundle(bundle, { anchor });

    console.log(`  intact:           ${report.intact}`);
    console.log(`  claim:            ${report.claim}`);
    console.log(`  guarantee:        ${report.guarantee}`);
    console.log(`  checks.chain:     ${JSON.stringify(report.checks.chain)}`);
    console.log(`  checks.root:      ${JSON.stringify(report.checks.root)}`);
    console.log(`  checks.handoff:   ${JSON.stringify(report.checks.handoff)}`);
    if (report.failure) console.log(`  failure:          ${report.failure}`);

    // ---------------------------------------------------------------------------
    // Exit logic: 0 iff intact && handoff ok && aggregate sum correct
    // ---------------------------------------------------------------------------
    const EXPECTED_SUM = 100;
    const sumOk = Number(aggregateResult) === EXPECTED_SUM;
    const handoffOk = report.intact && report.checks.handoff.ok === true;
    const reduceDone = itemById.get('reduce')?.status === 'done';

    if (!handoffOk || !sumOk || !reduceDone) {
      console.error('\n=== data-mapreduce FAILED ===');
      if (!reduceDone) console.error('  reduce item is not done');
      if (!sumOk)
        console.error(`  aggregate result ${aggregateResult} !== expected ${EXPECTED_SUM}`);
      if (!handoffOk) console.error('  bundle verification failed');
      process.exitCode = 1;
    } else {
      console.log(
        `\n=== data-mapreduce OK — graph grew at runtime (${statuses.length} items); ` +
          `aggregate sum=${aggregateResult}; provenance intact ===`,
      );
    }
  } finally {
    store.close();
    await rm(storageDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('data-mapreduce demo crashed:', err);
  process.exit(1);
});
