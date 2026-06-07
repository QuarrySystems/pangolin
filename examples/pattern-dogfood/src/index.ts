// pattern-dogfood — §9 acceptance demo: gated circle-back (zero-credit).
//
// Drives the pipeline pattern's spawn-fix gate:
//   implement → review (gate: onRed=spawn-fix) → package (needs.work from implement)
//
// When review is done-but-red (done + verify.passed===false) the pattern spawns:
//   review-fix-1 (the fix, needs BOTH work + findings), then review~2 (re-gate), then package~2.
//
// The original branch (review: done-but-red / package: skipped) is preserved as sealed
// history — a forward arc is added; no cycle ever forms.
//
// This demo is entirely in-memory (SqliteRunStateStore :memory:) — no Docker, no API key.
// Run: pnpm start
//
// DATA-EDGE EXEMPTION (dep-resolver §7, commit 9fb0ea7):
//   review (attempt 1) returns outputRefs:{findings:REF_FINDINGS} as a true gate output.
//   respawnLineage sees gate.outputRefs.findings and auto-binds needs.findings on the fix item:
//     { from: 'review', select: { kind:'output', path:'findings' } }
//   The dep-resolver's isBlockedBy predicate exempts this data-consumer edge — review-fix-1
//   readies normally despite the red gate. The engine resolves findings via needs-resolver
//   (selectProductRef → upstream.outputRefs['findings']) at fire time. No manual injection needed.

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

/** Findings artifact produced by the done-but-red 'review' gate.
 *  Returned as review's outputRefs.findings — a true gate output.
 *  The engine auto-binds needs.findings on the fix item and resolves it via needs-resolver
 *  (selectProductRef → upstream.outputRefs['findings']). */
const REF_FINDINGS =
  'agora://ns/artifact/findings/sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

// ---------------------------------------------------------------------------
// Id-keyed fake executor (re-created inline — examples cannot import test fixtures)
//
// Mirrors packages/agora-orchestrator/test/fixtures/pattern-harness.ts idKeyedExecutor:
//   fire() seals engine-resolved inputs.inputRefs into a buildManifest blob.
//   reconcile() returns the deterministic behavior keyed by de-namespaced item id.
// ---------------------------------------------------------------------------

type ItemBehavior = {
  status: 'done' | 'failed';
  resultRef?: string;
  verify?: { passed: boolean };
  outputRefs?: Record<string, string>;
};

function behavior(itemId: string): ItemBehavior {
  // review (attempt 1): done-but-red — findings as a TRUE gate outputRef.
  // respawnLineage sees outputRefs.findings and auto-binds needs.findings on the fix item.
  // The data-edge exemption (dep-resolver §7) allows the fix item to ready itself.
  if (itemId === 'review')
    return { status: 'done', verify: { passed: false }, outputRefs: { findings: REF_FINDINGS } };
  if (itemId === 'implement') return { status: 'done', resultRef: REF_IMPL };
  if (itemId === 'review-fix-1') return { status: 'done', resultRef: REF_FIX };
  // review~2, package, package~2 → done (green)
  return { status: 'done' };
}

function makeIdKeyedExecutor(blobs: Map<string, Uint8Array>): Executor {
  const dispatchMap = new Map<string, string>();

  return {
    id: 'dispatch',

    async fire(item, ctx) {
      // Engine-resolved inputRefs from needs bindings.
      // For review-fix-1: work comes from implement (needs.work, kind=patch → resultRef)
      // and findings comes from review (needs.findings, kind=output → outputRefs.findings).
      // Both are resolved by the engine's needs-resolver before fire() is called; no
      // manual injection needed — the data-edge exemption (dep-resolver §7) ensures the
      // fix item readies itself and receives the gate's findings ref through normal resolve.
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
        ...(b.outputRefs !== undefined ? { outputRefs: b.outputRefs } : {}),
        ...(b.verify !== undefined ? { verify: b.verify } : {}),
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
      maxAttempts: 1, // so done-but-red gate resolves on first reconcile
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
    // (1) AFTER graph status
    // ---------------------------------------------------------------------------
    const statuses = orch.getStatus(runId);
    console.log('\n=== AFTER: graph status ===');
    for (const s of statuses) {
      const ref = s.resultRef ? ` resultRef=${s.resultRef.slice(0, 60)}…` : '';
      const vfy = s.verify ? ` verify.passed=${s.verify.passed}` : '';
      console.log(`  ${s.id}: ${s.status}${vfy}${ref}`);
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
    // (3) Fix item manifest: print both work + findings inputRefs
    // ---------------------------------------------------------------------------
    const storage = {
      async get(ref: string): Promise<Uint8Array> {
        const b = blobs.get(ref);
        if (!b) throw new Error(`missing blob: ${ref}`);
        return b;
      },
    };
    const bundle = await assembleBundle(exp, { anchor, storage });

    const fixManifest = bundle.manifests.find((m) => m.itemId === 'review-fix-1');
    console.log('\n=== review-fix-1 manifest inputRefs ===');
    console.log(`  work:     ${fixManifest?.inputRefs?.['work'] ?? '(missing)'}`);
    console.log(`  findings: ${fixManifest?.inputRefs?.['findings'] ?? '(missing)'}`);

    // ---------------------------------------------------------------------------
    // (4) package~2 inputRefs.work === review-fix-1 resultRef
    // ---------------------------------------------------------------------------
    const pkg2Manifest = bundle.manifests.find(
      (m) => m.inputRefs !== undefined && m.inputRefs['work'] === REF_FIX,
    );
    console.log('\n=== package~2 provenance ===');
    console.log(`  inputRefs.work matches review-fix-1 resultRef: ${pkg2Manifest !== undefined}`);

    // ---------------------------------------------------------------------------
    // (5) verifyBundle report
    // ---------------------------------------------------------------------------
    console.log('\n=== verifyBundle report ===');
    const report = await verifyBundle(bundle, { anchor });
    console.log(`  intact:           ${report.intact}`);
    console.log(`  claim:            ${report.claim}`);
    console.log(`  guarantee:        ${report.guarantee}`);
    console.log(`  checks.chain:     ${JSON.stringify(report.checks.chain)}`);
    console.log(`  checks.root:      ${JSON.stringify(report.checks.root)}`);
    console.log(`  checks.handoff:   ${JSON.stringify(report.checks.handoff)}`);
    if (report.failure) console.log(`  failure:          ${report.failure}`);

    // ---------------------------------------------------------------------------
    // Assertions (self-test — exit non-zero on miss)
    // ---------------------------------------------------------------------------
    const errors: string[] = [];

    const statusById = new Map(statuses.map((s) => [s.id, s]));

    // review should be done-but-red (not failed)
    const reviewStatus = statusById.get('review');
    if (reviewStatus?.status !== 'done')
      errors.push(`expected review status=done, got ${reviewStatus?.status}`);
    if (reviewStatus?.verify?.passed !== false)
      errors.push(`expected review verify.passed=false, got ${JSON.stringify(reviewStatus?.verify)}`);

    // package should be skipped (engine red-gate cascade)
    if (statusById.get('package')?.status !== 'skipped')
      errors.push(`expected package skipped, got ${statusById.get('package')?.status}`);

    // package~2 should be done
    if (statusById.get('package~2')?.status !== 'done')
      errors.push(`expected package~2 done, got ${statusById.get('package~2')?.status}`);

    // review-fix-1 manifest must have both work AND findings
    if (!fixManifest)
      errors.push('review-fix-1 manifest not found in bundle');
    if (!fixManifest?.inputRefs?.['work'])
      errors.push('review-fix-1 manifest missing inputRefs.work');
    if (!fixManifest?.inputRefs?.['findings'])
      errors.push('review-fix-1 manifest missing inputRefs.findings');

    // package~2 must have inputRefs.work === REF_FIX
    if (!pkg2Manifest)
      errors.push(`package~2 manifest not found with inputRefs.work = REF_FIX`);

    // verifyBundle: intact + handoff ok
    if (!report.intact)
      errors.push('verifyBundle: intact=false');
    if (report.checks.handoff.ok === false)
      errors.push(`verifyBundle: handoff not ok — ${report.failure ?? '(no detail)'}`);

    if (errors.length > 0) {
      console.error('\n=== pattern-dogfood FAILED ===');
      for (const e of errors) console.error(`  ${e}`);
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
