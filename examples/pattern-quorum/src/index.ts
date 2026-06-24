// pattern-quorum — independent-review quorum demo (zero-credit).
//
// Drives the quorum pattern's fan-out → tally → advance flow:
//   draft (done) → [draft::rev-0, draft::rev-1, draft::rev-2]  (N independent reviewers)
//                → tally approvals; ≥ threshold? → draft::commit
//
// One reviewer DISSENTS (verify.passed=false) but the 2-of-3 quorum still advances. The
// dissent is NOT discarded — every reviewer item and its verdict are sealed in the audit
// bundle, so the tally an auditor recomputes is provable. This is the "independent
// validation" control (SR 11-7 / EU AI Act Art. 14) rendered as an execution pattern:
// "prove what your AI agent did — and that it was independently approved."
//
// On a sub-threshold tally the pattern would instead spawn a fix + a re-review copy
// (draft~2) that re-fans-out — bounded by maxRounds, the failed round preserved as history.
// This demo shows the advance path; see the unit test for the circle-back path.
//
// Entirely in-memory (SqliteRunStateStore :memory:) — no Docker, no API key. Run: pnpm start

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
  assembleBundle,
  verifyBundle,
  buildManifest,
  quorum,
} from '@quarry-systems/pangolin-orchestrator';
import type { Run, Executor } from '@quarry-systems/pangolin-orchestrator';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAN_PATH = join(__dirname, '../plan.json');

// ---------------------------------------------------------------------------
// Constants — fake content-addressed refs (hex sha256-length URIs)
// ---------------------------------------------------------------------------

/** Artifact produced by the 'draft' subject (the work under review). */
const REF_DRAFT =
  'pangolin://ns/artifact/draft/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** Artifact produced by 'draft::commit' (the effecting step, gated by the quorum). */
const REF_COMMIT =
  'pangolin://ns/artifact/commit/sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

// ---------------------------------------------------------------------------
// Id-keyed fake executor (re-created inline — examples cannot import test fixtures)
//   fire() seals engine-resolved inputs.inputRefs into a buildManifest blob.
//   reconcile() returns the deterministic verdict keyed by de-namespaced item id.
// ---------------------------------------------------------------------------

type ItemBehavior = {
  status: 'done' | 'failed';
  resultRef?: string;
  verify?: { passed: boolean };
};

function behavior(itemId: string): ItemBehavior {
  if (itemId === 'draft') return { status: 'done', resultRef: REF_DRAFT };
  // Two reviewers approve, one dissents — 2-of-3 meets the threshold.
  if (itemId === 'draft::rev-0') return { status: 'done', verify: { passed: true } };
  if (itemId === 'draft::rev-1') return { status: 'done', verify: { passed: true } };
  if (itemId === 'draft::rev-2') return { status: 'done', verify: { passed: false } }; // dissent (sealed)
  if (itemId === 'draft::commit') return { status: 'done', resultRef: REF_COMMIT };
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

      const manifestRef = `pangolin://ns/manifest/m/${manifest.manifestHash}`;
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
        ...(b.verify !== undefined ? { verify: b.verify } : {}),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Drive loop — tick until all items terminal (or tick limit)
// ---------------------------------------------------------------------------

async function driveUntilDone(
  orch: PangolinOrchestrator,
  runId: string,
  maxTicks = 64,
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
  const blobs = new Map<string, Uint8Array>();
  const store = new SqliteRunStateStore(); // :memory:

  try {
    const executor = makeIdKeyedExecutor(blobs);
    const anchor = new LocalAnchor(store);
    const auditLog = new AuditLog({ store, signer: NoneSigner, anchor });

    const orch = new PangolinOrchestrator({
      store,
      executors: { dispatch: executor },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 5, pattern: quorum } },
      maxAttempts: 1,
      auditLog,
    });

    const raw = await readFile(PLAN_PATH, 'utf-8');
    const plan = JSON.parse(raw) as Run;

    console.log('=== BEFORE: submitted run ===');
    console.log(
      `  items: ${plan.items.map((i) => i.id).join(', ')}  (just the draft — reviewers are spawned)`,
    );

    const runId = await orch.submitRun(plan, 'human:demo');
    await driveUntilDone(orch, runId);

    // (1) AFTER graph status
    const statuses = orch.getStatus(runId);
    console.log('\n=== AFTER: graph status ===');
    for (const s of statuses) {
      const ref = s.resultRef ? ` resultRef=${s.resultRef.slice(0, 56)}…` : '';
      const vfy = s.verify ? ` verdict=${s.verify.passed ? 'APPROVE' : 'DISSENT'}` : '';
      console.log(`  ${s.id}: ${s.status}${vfy}${ref}`);
    }

    // (2) The sealed tally — recomputed from the reviewer verdicts (what an auditor checks)
    const reviewers = statuses.filter((s) => s.id.startsWith('draft::rev-'));
    const approvals = reviewers.filter(
      (r) => r.status === 'done' && r.verify?.passed !== false,
    ).length;
    const threshold = 2;
    console.log('\n=== independent-review tally (recomputed from sealed verdicts) ===');
    console.log(
      `  reviewers: ${reviewers.length}   approvals: ${approvals}   threshold: ${threshold}`,
    );
    console.log(
      `  quorum reached: ${approvals >= threshold}  →  commit ${approvals >= threshold ? 'ADVANCED' : 'BLOCKED'}`,
    );

    // (3) run.extended audit entries
    const exp = orch.getAuditExport(runId);
    const extended = exp.entries.filter((e) => e.kind === 'run.extended');
    console.log('\n=== run.extended entries ===');
    for (const e of extended) {
      console.log(
        `  kind=${e.kind}  causeItemId=${e.itemId ?? '(none)'}  actor=${e.actor ?? '(none)'}`,
      );
    }

    // (4) commit provenance — its manifest must seal an inputRef on the reviewed draft
    const storage = {
      async get(ref: string): Promise<Uint8Array> {
        const b = blobs.get(ref);
        if (!b) throw new Error(`missing blob: ${ref}`);
        return b;
      },
    };
    const bundle = await assembleBundle(exp, { anchor, storage });
    const commitManifest = bundle.manifests.find((m) => m.itemId === 'draft::commit');
    console.log('\n=== draft::commit provenance ===');
    console.log(
      `  inputRefs.work === draft resultRef: ${commitManifest?.inputRefs?.['work'] === REF_DRAFT}`,
    );

    // (5) verifyBundle report
    console.log('\n=== verifyBundle report ===');
    const report = await verifyBundle(bundle, { anchor });
    console.log(`  intact:         ${report.intact}`);
    console.log(`  claim:          ${report.claim}`);
    console.log(`  checks.chain:   ${JSON.stringify(report.checks.chain)}`);
    console.log(`  checks.root:    ${JSON.stringify(report.checks.root)}`);
    console.log(`  checks.handoff: ${JSON.stringify(report.checks.handoff)}`);
    if (report.failure) console.log(`  failure:        ${report.failure}`);

    // Assertions (self-test — exit non-zero on miss)
    const errors: string[] = [];
    const byId = new Map(statuses.map((s) => [s.id, s]));

    if (reviewers.length !== 3) errors.push(`expected 3 reviewers, got ${reviewers.length}`);
    if (approvals !== 2) errors.push(`expected 2 approvals, got ${approvals}`);
    if (byId.get('draft::commit')?.status !== 'done')
      errors.push(`expected draft::commit done, got ${byId.get('draft::commit')?.status}`);
    if (extended.length !== 2)
      errors.push(`expected 2 run.extended entries (fan-out + commit), got ${extended.length}`);
    if (commitManifest?.inputRefs?.['work'] !== REF_DRAFT)
      errors.push('commit manifest missing inputRefs.work === draft resultRef');
    if (!report.intact) errors.push('verifyBundle: intact=false');
    if (report.checks.handoff.ok === false)
      errors.push(`verifyBundle: handoff not ok — ${report.failure ?? '(no detail)'}`);

    if (errors.length > 0) {
      console.error('\n=== pattern-quorum FAILED ===');
      for (const e of errors) console.error(`  ${e}`);
      process.exitCode = 1;
    } else {
      console.log(
        '\n=== pattern-quorum OK — 2-of-3 independent quorum advanced; dissent + tally sealed; provenance intact ===',
      );
    }
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error('pattern-quorum crashed:', err);
  process.exit(1);
});
