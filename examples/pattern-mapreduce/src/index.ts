// pattern-mapreduce — offline demo of N-unknown fan-out.
//
// Demonstrates the mapReduce pattern: plan.json submits ONLY the splitter;
// the orchestrator dynamically spawns 3 map items + a reduce item at runtime
// through the audited extendRun seam.
//
// No API keys, no Docker, no network. Fully offline — fake executor.

import { readFile } from 'node:fs/promises';
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
  buildManifest,
} from '@quarry-systems/pangolin-orchestrator';
import type { Executor, Run } from '@quarry-systems/pangolin-orchestrator';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAN_PATH = join(__dirname, '../plan.json');

// ---------------------------------------------------------------------------
// Content-addressed fake URIs (sha256-shaped, one per artifact)
// ---------------------------------------------------------------------------

const REF_A = 'pangolin://ns/artifact/a/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REF_B = 'pangolin://ns/artifact/b/sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const REF_C = 'pangolin://ns/artifact/c/sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const REF_MAP_A = 'pangolin://ns/artifact/map-a/sha256:1111111111111111111111111111111111111111111111111111111111111111';
const REF_MAP_B = 'pangolin://ns/artifact/map-b/sha256:2222222222222222222222222222222222222222222222222222222222222222';
const REF_MAP_C = 'pangolin://ns/artifact/map-c/sha256:3333333333333333333333333333333333333333333333333333333333333333';

// ---------------------------------------------------------------------------
// Inline fake executor (mirrors pattern-harness.ts idKeyedExecutor shape).
//
// fire()       — seals resolved inputs.inputRefs into a buildManifest blob.
// reconcile()  — returns deterministic done/outputRefs keyed by item id.
//
// Item ids arrive de-namespaced (the orchestrator wraps executors):
//   'split'       → done + outputRefs { 'a.json': REF_A, 'b.json': REF_B, 'c.json': REF_C }
//   'map-a.json'  → done + outputRefs { result: REF_MAP_A }
//   'map-b.json'  → done + outputRefs { result: REF_MAP_B }
//   'map-c.json'  → done + outputRefs { result: REF_MAP_C }
//   'reduce'      → done
// ---------------------------------------------------------------------------

function makeFakeExecutor(blobs: Map<string, Uint8Array>): Executor {
  const dispatchMap = new Map<string, string>();

  return {
    id: 'dispatch',

    async fire(item, ctx) {
      const inputRefs = item.inputs['inputRefs'] as Record<string, string> | undefined;

      const { manifest, bytes } = buildManifest({
        runId: ctx?.runId ?? '',
        itemId: item.id,
        executor: 'dispatch',
        executorManifest: {},
        secretRefs: [],
        actor: ctx?.actor ?? 'human:demo',
        firedAt: new Date().toISOString(),
        ...(inputRefs ? { inputRefs } : {}),
      });

      const manifestRef = `pangolin://ns/manifest/m/${manifest.manifestHash}`;
      blobs.set(manifestRef, bytes);

      const dispatchHash = `d-${ctx?.runId ?? ''}-${item.id}`;
      dispatchMap.set(dispatchHash, item.id);

      return { dispatchHash, manifestRef };
    },

    async reconcile(dispatchHash) {
      const itemId = dispatchMap.get(dispatchHash);
      if (itemId === undefined) return null;

      const outputRefsForSplit: Record<string, string> = { 'a.json': REF_A, 'b.json': REF_B, 'c.json': REF_C };
      const outputRefsForMapA: Record<string, string> = { result: REF_MAP_A };
      const outputRefsForMapB: Record<string, string> = { result: REF_MAP_B };
      const outputRefsForMapC: Record<string, string> = { result: REF_MAP_C };

      if (itemId === 'split') {
        return { status: 'done', outputRefs: outputRefsForSplit };
      }
      if (itemId === 'map-a.json') {
        return { status: 'done', outputRefs: outputRefsForMapA };
      }
      if (itemId === 'map-b.json') {
        return { status: 'done', outputRefs: outputRefsForMapB };
      }
      if (itemId === 'map-c.json') {
        return { status: 'done', outputRefs: outputRefsForMapC };
      }
      // reduce and anything else
      return { status: 'done' };
    },
  };
}

async function main(): Promise<void> {
  const blobs = new Map<string, Uint8Array>();
  const store = new SqliteRunStateStore();

  try {
    const executor = makeFakeExecutor(blobs);

    // Wire up the orchestrator with the mapReduce pattern on the default queue.
    const anchor = new LocalAnchor(store);
    const auditLog = new AuditLog({ store, signer: NoneSigner, anchor });

    const orch = new PangolinOrchestrator({
      store,
      executors: { dispatch: executor },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 5, pattern: mapReduce } },
      auditLog,
    });

    // Load plan.json — contains ONLY the splitter item.
    const raw = await readFile(PLAN_PATH, 'utf-8');
    const plan = JSON.parse(raw) as Run;

    const runId = orch.submitRun(plan, 'human:demo');
    console.log(`Submitted run '${runId}' — plan has ${plan.items.length} item(s) (splitter only).`);

    // Tick until all items are terminal.
    for (let i = 0; i < 64; i++) {
      await orch.tick('default');
      const statuses = orch.getStatus(runId).map((s) => s.status);
      if (statuses.length > 0 && statuses.every((s) => ['done', 'failed', 'skipped', 'cancelled'].includes(s))) {
        break;
      }
    }

    // 1. Print the grown item tree (id + status).
    console.log('\n=== Grown item tree (splitter + 3 maps + reduce) ===');
    const itemStatuses = orch.getStatus(runId);
    for (const s of itemStatuses.sort((a, b) => a.id.localeCompare(b.id))) {
      console.log(`  ${s.id}: ${s.status}`);
    }
    console.log(`  Total items: ${itemStatuses.length} (plan submitted 1; orchestrator grew to ${itemStatuses.length})`);

    // 2. Print run.extended audit entries (cause + actor).
    const exp = orch.getAuditExport(runId);
    console.log('\n=== run.extended audit entries ===');
    const extendedEntries = exp.entries.filter((e) => e.kind === 'run.extended');
    if (extendedEntries.length === 0) {
      console.log('  (none)');
    }
    for (const entry of extendedEntries) {
      console.log(`  kind=${entry.kind}  actor=${entry.actor}  causeItemId=${entry.itemId ?? '(none)'}`);
    }

    // 3. assembleBundle → verifyBundle — prove provenance closure.
    console.log('\n=== verifyBundle provenance closure ===');
    const storage = {
      async get(ref: string): Promise<Uint8Array> {
        const b = blobs.get(ref);
        if (!b) throw new Error(`missing blob: ${ref}`);
        return b;
      },
    };

    const bundle = await assembleBundle(exp, { anchor, storage });
    const report = await verifyBundle(bundle, { anchor });

    console.log(`  intact:         ${report.intact}`);
    console.log(`  checks.chain:   ${JSON.stringify(report.checks.chain)}`);
    console.log(`  checks.root:    ${JSON.stringify(report.checks.root)}`);
    console.log(`  checks.handoff: ${JSON.stringify(report.checks.handoff)}`);
    if (report.failure) {
      console.log(`  failure:        ${report.failure}`);
    }

    if (report.intact && report.checks.handoff.ok === true) {
      console.log('\n=== pattern-mapreduce OK — graph grew at runtime; provenance sealed ===');
    } else {
      console.error('\n=== pattern-mapreduce FAILED (!intact or !handoff.ok) ===');
      process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error('pattern-mapreduce demo crashed:', err);
  process.exit(1);
});
