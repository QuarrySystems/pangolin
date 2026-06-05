// pattern-dogfood — §9 acceptance demo: gated circle-back (zero-credit).
//
// Drives the pipeline pattern's spawn-fix gate:
//   implement → review (gate: onRed=spawn-fix) → package (needs.work from implement)
//
// When review fails the pattern spawns:
//   review-fix-1 (the fix), then review~2 (re-gate), then package~2 (via updated needs.work).
//
// The original failed branch (review: failed / package: skipped) is preserved as sealed
// history — a forward arc is added; no cycle ever forms.
//
// This demo is entirely in-memory (SqliteRunStateStore :memory:) — no Docker, no API key.
// Run: pnpm start

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AgoraOrchestrator,
  ManualTrigger,
  SqliteRunStateStore,
  AuditLog,
  NoneSigner,
  LocalAnchor,
  assembleBundle,
  verifyBundle,
  buildManifest,
  pipeline,
} from '@quarry-systems/agora-orchestrator';
import type { Run, Executor } from '@quarry-systems/agora-orchestrator';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAN_PATH = join(__dirname, '../plan.json');

// ---------------------------------------------------------------------------
// Constants — fake content-addressed refs (hex sha256-length URIs)
// ---------------------------------------------------------------------------

/** Artifact produced by 'implement'. */
const REF_IMPL =
  'agora://ns/artifact/impl/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** Artifact produced by 'review-fix-1'. */
const REF_FIX =
  'agora://ns/artifact/fix/sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

// ---------------------------------------------------------------------------
// Id-keyed fake executor (re-created inline — examples cannot import test fixtures)
//
// Mirrors packages/agora-orchestrator/test/fixtures/pattern-harness.ts idKeyedExecutor:
//   fire() seals engine-resolved inputs.inputRefs into a buildManifest blob.
//   reconcile() returns the deterministic behavior keyed by de-namespaced item id.
// ---------------------------------------------------------------------------

type ItemBehavior = { status: 'done' | 'failed'; resultRef?: string };

function behavior(itemId: string): ItemBehavior {
  if (itemId === 'review') return { status: 'failed' };
  if (itemId === 'implement') return { status: 'done', resultRef: REF_IMPL };
  if (itemId === 'review-fix-1') return { status: 'done', resultRef: REF_FIX };
  // review~2, package, package~2 → done
  return { status: 'done' };
}

function makeIdKeyedExecutor(blobs: Map<string, Uint8Array>): Executor {
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

      const manifestRef = `agora://ns/manifest/m/${manifest.manifestHash}`;
      blobs.set(manifestRef, bytes);

      const dispatchHash = `d-${ctx?.runId ?? ''}-${item.id}`;
      dispatchMap.set(dispatchHash, item.id);

      return { dispatchHash, manifestRef };
    },

    async reconcile(dispatchHash) {
      const itemId = dispatchMap.get(dispatchHash);
      if (itemId === undefined) return null;
      const b = behavior(itemId);
      return {
        status: b.status,
        ...(b.resultRef !== undefined ? { resultRef: b.resultRef } : {}),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Drive loop — tick until all items terminal (or tick limit)
// ---------------------------------------------------------------------------

async function driveUntilDone(orch: AgoraOrchestrator, runId: string, maxTicks = 64): Promise<void> {
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
  const blobs = new Map<string, Uint8Array>();
  const store = new SqliteRunStateStore(); // :memory: — single-process

  try {
    const executor = makeIdKeyedExecutor(blobs);
    const anchor = new LocalAnchor(store);
    const auditLog = new AuditLog({ store, signer: NoneSigner, anchor });

    const orch = new AgoraOrchestrator({
      store,
      executors: { dispatch: executor },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 5, pattern: pipeline } },
      maxAttempts: 1, // so review goes terminal on first failure
      auditLog,
    });

    // Load and submit plan.
    const raw = await readFile(PLAN_PATH, 'utf-8');
    const plan = JSON.parse(raw) as Run;

    console.log('=== BEFORE: submitted run ===');
    console.log(`  items: ${plan.items.map((i) => i.id).join(', ')}`);

    const runId = orch.submitRun(plan, 'human:demo');

    // Drive until all terminal.
    await driveUntilDone(orch, runId);

    // ---------------------------------------------------------------------------
    // (1) BEFORE shape + AFTER graph
    // ---------------------------------------------------------------------------
    const statuses = orch.getStatus(runId);
    console.log('\n=== AFTER: graph status ===');
    for (const s of statuses) {
      const ref = s.resultRef ? ` resultRef=${s.resultRef.slice(0, 60)}…` : '';
      console.log(`  ${s.id}: ${s.status}${ref}`);
    }

    // ---------------------------------------------------------------------------
    // (2) run.extended audit entries
    // ---------------------------------------------------------------------------
    const exp = orch.getAuditExport(runId);
    const extendedEntries = exp.entries.filter((e) => e.kind === 'run.extended');
    console.log('\n=== run.extended entries ===');
    for (const e of extendedEntries) {
      console.log(`  kind=${e.kind}  causeItemId=${e.itemId ?? '(none)'}  actor=${e.actor ?? '(none)'}`);
    }

    // ---------------------------------------------------------------------------
    // (3) verifyBundle report
    // ---------------------------------------------------------------------------
    console.log('\n=== verifyBundle report ===');
    const storage = {
      async get(ref: string): Promise<Uint8Array> {
        const b = blobs.get(ref);
        if (!b) throw new Error(`missing blob: ${ref}`);
        return b;
      },
    };
    const bundle = await assembleBundle(exp, { anchor, storage });
    const report = await verifyBundle(bundle, { anchor });
    console.log(`  intact:           ${report.intact}`);
    console.log(`  claim:            ${report.claim}`);
    console.log(`  guarantee:        ${report.guarantee}`);
    console.log(`  checks.chain:     ${JSON.stringify(report.checks.chain)}`);
    console.log(`  checks.root:      ${JSON.stringify(report.checks.root)}`);
    console.log(`  checks.handoff:   ${JSON.stringify(report.checks.handoff)}`);
    if (report.failure) console.log(`  failure:          ${report.failure}`);

    // ---------------------------------------------------------------------------
    // Exit logic: 0 iff intact && handoff ok && package~2 done
    // ---------------------------------------------------------------------------
    const statusById = new Map(statuses.map((s) => [s.id, s.status]));
    const pkg2Done = statusById.get('package~2') === 'done';
    const handoffOk = report.intact && report.checks.handoff.ok !== false;

    if (!handoffOk || !pkg2Done) {
      console.error('\n=== pattern-dogfood FAILED ===');
      if (!pkg2Done) console.error('  package~2 is not done');
      if (!handoffOk) console.error('  bundle verification failed');
      process.exitCode = 1;
    } else {
      console.log('\n=== pattern-dogfood OK — circle-back spawned; sealed history preserved; provenance intact ===');
    }
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error('pattern-dogfood crashed:', err);
  process.exit(1);
});
