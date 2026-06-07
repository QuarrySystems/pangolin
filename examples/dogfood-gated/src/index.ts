// dogfood-gated RUN 3 — agora exercises the pattern layer's GATED CIRCLE-BACK
// live on its own source tree (run 1 = independent fan-out #36; run 2 = typed-
// product handoff on a dependent chain #51). Run 3 proves: gate red → audited
// respawn → fix-consumes-findings → remapped downstream — with real Claude
// workers, and every dispatch sealing model + cost (#52).
//
// Three items, queue `default`, `pipeline` pattern with one gate (spec §2):
//   write-page  (dispatch, subagent page-writer,  model standard) — creates the
//      execution-patterns explanation page from a deliberately PARTIAL seed view.
//   fact-check  (dispatch, subagent fact-checker, model max) — the GATE. Subject's
//      patch materialized at inputs/work, git-applied pre-agent; fact-checks every
//      claim against the source the page is about; findings → outputs/findings;
//      subagent-level verify `test ! -s outputs/findings` flips verify.passed=false
//      iff findings exist (done-but-red — the respawnLineage eligibility state).
//   announce    (dispatch, subagent announcer,   model standard) — adds a CHANGELOG
//      entry. On a red gate this is SKIPPED (§7 engine PR), then respawned as
//      announce~2 with needs.work remapped to the fix's patch.
//
// The driver IS the assertion (spec §4). After terminal state it downloads every
// patch, assembles the bundle, and exits non-zero unless the four §4 rows hold.
// Tier-0 posture: a failed ITEM does not fail the harness — you review the patches.
//
// Prerequisites (LIVE run):
//   - Docker reachable (local Desktop, or DOCKER_HOST → a remote daemon).
//   - The worker image MUST be rebuilt from THIS branch (spec §4): #52's
//     --model/level mapping and the sentinel `usage` block are worker-side; the
//     run-2-era image silently ignores both. The all-sentinels-lack-usage failure
//     in row 4 doubles as the stale-image preflight.
//       docker build -f docker/agora-worker/Dockerfile -t ghcr.io/quarrysystems/agora-worker:main .
//   - ANTHROPIC_API_KEY set. Run: `pnpm start:env` (reads ../../.env) or export it.

import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  AgoraClient,
  NoopCredentialProvider,
  StdoutResultSink,
} from '@quarry-systems/agora-client';
import { LocalStorageProvider } from '@quarry-systems/agora-storage-local';
import { LocalDockerProvider } from '@quarry-systems/agora-providers-local-docker';
import { LocalSecretStore } from '@quarry-systems/agora-secret-store';
import {
  AgoraOrchestrator,
  SqliteRunStateStore,
  ManualTrigger,
  DispatchExecutor,
  AuditLog,
  LocalAnchor,
  createLocalSigner,
  verifyEd25519,
  MailboxSubmissionTransport,
  LocalDirMailbox,
  OperationsApi,
  serve,
  verifyBundle,
  pipeline,
} from '@quarry-systems/agora-orchestrator';
import type {
  Run,
  AuditBundle,
  DispatchExecutorManifest,
} from '@quarry-systems/agora-orchestrator';
import { parseAgoraUri, buildDispatchRecordUri } from '@quarry-systems/agora-core';
import type { RuntimeUsage } from '@quarry-systems/agora-core';
import { EXECUTION_PATTERNS_TOPIC as TOPIC } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../..');
const PLAN_PATH = join(__dirname, '../plan.json');
const PATCHES_DIR = join(__dirname, '../patches');
const NAMESPACE = 'dogfood-gated';
// :main MUST be rebuilt from this branch — see the header preflight note.
const WORKER_IMAGE = 'ghcr.io/quarrysystems/agora-worker:main';
const RUN_TIMEOUT_MS = 900_000; // 15 min: red arc = up to 5 mostly-sequential dispatches.

// Capability shipped to the apply-work-patch subagents: git-applies the upstream
// patch (materialized at inputs/work — the needs key is `work`) before the agent
// runs. Setup scripts execute after overlay and before captureBaseline — so the
// applied content is part of the baseline and the escaped patch holds only the
// agent's own edits. git init is required: the workspace is not a repo yet.
const APPLY_WORK_SETUP_SH = '#!/bin/sh\nset -e\ngit init -q\ngit apply inputs/work\n';

// Shared prompt scaffold (run-2 convention). {{{instructions}}} is unescaped so
// the plan.json task text passes through verbatim (backticks/punctuation intact).
const PROMPT =
  'You are a coding agent working inside a workspace that holds a subset of the agora ' +
  'monorepo at real repository paths (e.g. `docs-site/src/content/...`, `packages/...`). ' +
  'Complete EXACTLY the task below. Create or edit only the file(s) the task names; ' +
  'change nothing else. Use the Edit/Write tools, then stop.\n\nTASK:\n{{{instructions}}}';

const apiKeyRaw = process.env.ANTHROPIC_API_KEY;
if (!apiKeyRaw) {
  console.error('ANTHROPIC_API_KEY is not set. Run `pnpm start:env` (reads ../../.env) or export it.');
  process.exit(1);
}
const apiKey: string = apiKeyRaw;

/** Read the seed files (repo-relative paths) into a capability `files` map. */
async function seedFiles(rels: readonly string[]): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      rels.map(async (rel) => [rel, await readFile(join(REPO_ROOT, rel), 'utf8')] as const),
    ),
  );
}

// Status/audit body item shapes (refs only).
interface StatusBodyItem {
  id: string;
  status: string;
  resultRef?: string;
  manifestRef?: string;
  verify?: { passed: boolean };
}

async function main(): Promise<void> {
  // Fresh per-run dirs (a fixed path would let a later run read a prior run's stale
  // records for a reused runId).
  const runDir = await mkdtemp(join(tmpdir(), 'agora-dogfood-gated-'));
  const mailboxDir = join(runDir, 'mailbox');
  const storageRoot = join(runDir, 'storage');
  const secretDir = join(runDir, 'secrets');
  await mkdir(mailboxDir, { recursive: true });
  await mkdir(storageRoot, { recursive: true });
  await mkdir(secretDir, { recursive: true });
  const store = new SqliteRunStateStore(); // :memory: — single-process

  // Hoisted so the readUsage helper (row 4) can reach client.storage.
  let client: AgoraClient;

  /** Sentinel read recipe (audit-pinned, spec §4): manifestRef → dispatchId →
   *  output.json → .usage. Best-effort by contract — any failure is (not captured). */
  async function readUsage(manifestRef: string | undefined): Promise<RuntimeUsage | undefined> {
    if (!manifestRef) return undefined;
    try {
      const dispatchId = parseAgoraUri(manifestRef).name;
      const bytes = await client.storage.get(buildDispatchRecordUri(NAMESPACE, dispatchId, 'output.json'));
      return (JSON.parse(new TextDecoder().decode(bytes)) as { usage?: RuntimeUsage }).usage;
    } catch {
      return undefined;
    }
  }

  try {
    // 1. Wire the local-stack client.
    client = new AgoraClient({
      namespace: NAMESPACE,
      compute: { 'local-docker': new LocalDockerProvider({ allowUnpinnedImage: true }) },
      storage: new LocalStorageProvider({ rootDir: storageRoot }),
      secretStores: { local: new LocalSecretStore({ dir: secretDir }) },
      credentials: { none: new NoopCredentialProvider() },
      targets: { local: { compute: 'local-docker', credentials: 'none', secretStore: 'local' } },
      resultSink: new StdoutResultSink(),
    });

    // 2. Capabilities — seed bundles (per config.ts) + the work-patch applier.
    await client.capabilities.register({ name: 'docs-seeds', files: await seedFiles(TOPIC.subjectSeeds) });
    await client.capabilities.register({ name: 'source-seeds', files: await seedFiles(TOPIC.gateSeeds) });
    await client.capabilities.register({ name: 'announce-seeds', files: await seedFiles(TOPIC.announceSeeds) });
    await client.capabilities.register({
      name: 'apply-work-patch',
      files: { 'agora-setup.sh': APPLY_WORK_SETUP_SH },
    });

    // 3. Subagents (spec §3). All carry model:. fact-checker carries the #37
    //    subagent-level verify seam — report-only, which is what makes done-but-red
    //    reachable. page-fixer deliberately OMITS apply-work-patch (it reconstructs
    //    the page from inputs/work as data so its patch applies cleanly downstream).
    await client.subagent.register({
      name: 'page-writer',
      promptTemplate: PROMPT,
      model: 'standard',
      capabilities: ['docs-seeds'],
    });
    await client.subagent.register({
      name: 'fact-checker',
      promptTemplate: PROMPT,
      model: 'max',
      capabilities: ['source-seeds', 'apply-work-patch'],
      verify: { command: 'test ! -s outputs/findings' },
    });
    await client.subagent.register({
      name: 'page-fixer',
      promptTemplate: PROMPT,
      model: 'standard',
      capabilities: ['docs-seeds'],
    });
    await client.subagent.register({
      name: 'announcer',
      promptTemplate: PROMPT,
      model: 'standard',
      capabilities: ['announce-seeds', 'apply-work-patch'],
    });

    // 4. Audit primitives (tamper-detecting tier — LocalAnchor).
    const signer = createLocalSigner();
    const anchor = new LocalAnchor(store);
    const auditLog = new AuditLog({ store, signer, anchor });

    // 5. Orchestrator. The queue passes the Pattern OBJECT (`pipeline`) — the gate
    //    policy is NOT queue-level; it lives on the gate item's inputs.gate key.
    const orchestrator = new AgoraOrchestrator({
      store,
      executors: {
        dispatch: new DispatchExecutor({
          client,
          target: 'local',
          workerImage: WORKER_IMAGE,
          secrets: { ANTHROPIC_API_KEY: { inline: apiKey } },
        }),
      },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 2, pattern: pipeline } },
      auditLog,
    });

    // 6. Mailbox transport + serve driver.
    const transport = new MailboxSubmissionTransport(new LocalDirMailbox(mailboxDir));
    const ac = new AbortController();
    const servePromise = serve({ orchestrator, transport, signal: ac.signal });

    const verifySignature = (root: Uint8Array, sig: { alg: string; bytes: Uint8Array; keyRef?: string }) =>
      verifyEd25519(root, sig, signer.publicKey);
    const api = new OperationsApi({ transport, anchor, storage: client.storage, verifySignature });

    // 7. Submit the plan.
    const plan = JSON.parse(await readFile(PLAN_PATH, 'utf-8')) as Run;
    const runId = await api.submit(plan, 'human:dogfood');
    console.log(`submitted run '${runId}' (${plan.items.length} items) — watching…`);

    // 8. Watch until terminal or timeout.
    const watchAc = new AbortController();
    const timeoutHandle = setTimeout(() => {
      watchAc.abort();
      console.error('=== TIMEOUT: run did not complete within', RUN_TIMEOUT_MS / 1000, 's ===');
      ac.abort();
      process.exitCode = 1;
    }, RUN_TIMEOUT_MS);
    for await (const rec of api.watch(runId, { intervalMs: 3_000, signal: watchAc.signal })) {
      if (Array.isArray(rec.body)) {
        for (const item of rec.body as StatusBodyItem[]) {
          const v = item.verify ? ` verify.passed=${item.verify.passed}` : '';
          console.log(`  ${item.id}: ${item.status}${item.resultRef ? ' resultRef=' + item.resultRef : ''}${v}`);
        }
      }
    }
    clearTimeout(timeoutHandle);

    // 9. Final status — the grown item graph (incl. pattern-spawned items).
    const statusRec = await api.status(runId);
    const items: StatusBodyItem[] = Array.isArray(statusRec?.body)
      ? (statusRec.body as StatusBodyItem[])
      : [];
    const byId = new Map(items.map((i) => [i.id, i] as const));

    // 10. Download every item's patch artifact for review.
    await mkdir(PATCHES_DIR, { recursive: true });
    console.log('\n=== Patches (review, then `git apply` from the repo root) ===');
    for (const item of items) {
      if (item.resultRef) {
        try {
          const bytes = await client.storage.get(item.resultRef);
          const out = join(PATCHES_DIR, `${item.id}.patch`);
          await writeFile(out, bytes);
          console.log(`  ${item.id}: ${item.status} -> ${out}`);
        } catch (e) {
          console.log(`  ${item.id}: ${item.status} (patch download failed: ${String(e)})`);
        }
      } else {
        console.log(`  ${item.id}: ${item.status} (no patch — no workspace change)`);
      }
    }

    // 11. Assemble the audit bundle (retry loop — the export publishes on seal).
    console.log('\n=== Audit bundle ===');
    let bundle: AuditBundle | undefined;
    for (let i = 0; i < 15; i++) {
      try {
        bundle = await api.audit(runId);
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (i === 14 || !/no audit export/.test(msg)) throw e;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (!bundle) throw new Error('audit export never became available');

    let ok = true; // the four §4 rows AND together into the honest exit code.

    // --- Row 1: provenance over the grown graph. -------------------------------
    const report = await verifyBundle(bundle, { anchor, verifySignature });
    console.log('\n--- Row 1: provenance closure ---');
    console.log(`  intact:         ${report.intact}`);
    console.log(`  checks.handoff: ${JSON.stringify(report.checks.handoff)}`);
    if (report.failure) console.log(`  failure:        ${report.failure}`);
    const row1 = report.intact === true && report.checks.handoff.ok === true;
    if (!row1) {
      ok = false;
      console.error('  Row 1 FAIL: bundle not intact or handoff closure not proven.');
    } else {
      console.log('  Row 1 OK.');
    }

    // --- Rows 2 & 3: red path vs green path. -----------------------------------
    // The fix item id is deterministically `fact-check-fix-1` (respawn.ts) — its
    // presence in the grown graph is how we detect which arc the run took.
    const FIX_ID = 'fact-check-fix-1';
    const redArc = items.some((i) => i.id === FIX_ID);

    if (redArc) {
      console.log('\n--- Row 2: red path (circle-back exercised) ---');

      // (a) a run.extended audit entry: kind, itemId=cause, actor=pattern:default.
      const extended = bundle.auditLog.entries.find(
        (e) => e.kind === 'run.extended' && e.itemId === 'fact-check' && e.actor === 'pattern:default',
      );
      const aOk = extended !== undefined;
      console.log(`  run.extended (itemId='fact-check', actor='pattern:default'): ${aOk}`);

      // (b) the fix item is done.
      const fix = byId.get(FIX_ID);
      const bOk = fix?.status === 'done';
      console.log(`  ${FIX_ID} done: ${bOk} (status=${fix?.status ?? 'absent'})`);

      // (c) the gate copy fact-check~2 is done AND green (verify.passed !== false).
      const gate2 = byId.get('fact-check~2');
      const cOk = gate2?.status === 'done' && gate2.verify?.passed !== false;
      console.log(`  fact-check~2 done+green: ${cOk} (status=${gate2?.status ?? 'absent'}, verify.passed=${gate2?.verify?.passed})`);

      // (d) announce~2 is done AND its inputRefs.work === the fix's resultRef (remap).
      const ann2Status = byId.get('announce~2');
      const ann2Manifest = bundle.manifests.find((m) => m.itemId === 'announce~2');
      const fixOutcome = bundle.items.find((i) => i.id === FIX_ID);
      const remapped =
        ann2Manifest?.inputRefs?.work !== undefined &&
        fixOutcome?.resultRef !== undefined &&
        ann2Manifest.inputRefs.work === fixOutcome.resultRef;
      const dOk = ann2Status?.status === 'done' && remapped;
      console.log(`  announce~2 done + needs.work remapped to fix.resultRef: ${dOk}`);
      console.log(`    announce~2.inputRefs.work = ${ann2Manifest?.inputRefs?.work ?? '(none)'}`);
      console.log(`    ${FIX_ID}.resultRef       = ${fixOutcome?.resultRef ?? '(none)'}`);

      const row2 = aOk && bOk && cOk && dOk;
      if (!row2) {
        ok = false;
        console.error('  Row 2 FAIL: red-path circle-back not fully proven.');
      } else {
        console.log('  Row 2 OK — gated circle-back PROVEN live.');
      }
    } else {
      console.log('\n--- Row 3: green path (honest) ---');
      const ann = byId.get('announce');
      const row3 = ann?.status === 'done';
      console.log(`  announce done: ${row3} (status=${ann?.status ?? 'absent'})`);
      if (!row3) {
        ok = false;
        console.error('  Row 3 FAIL: green path but announce not done.');
      } else {
        console.log('  GATE GREEN — no circle-back exercised');
        console.log('  Row 3 OK (exit 0). Rerun protocol (R6): re-invoke with the block-pipeline-runner page as subject.');
      }
    }

    // --- Row 4: evidence table (#52 — model + cost per dispatch). ---------------
    console.log('\n--- Row 4: dispatch evidence ---');
    console.log('  item | requested | actual model(s) | costUsd | turns');
    let anyUsage = false;
    let runTotalCost = 0;
    // Every item with a manifestRef contributes a row (bundle.items carries them).
    for (const outcome of bundle.items) {
      if (!outcome.manifestRef) continue;
      const manifest = bundle.manifests.find((m) => m.itemId === outcome.id);
      const requested = manifest
        ? (manifest.executorManifest as DispatchExecutorManifest).model.id
        : '(no manifest)';
      const usage = await readUsage(outcome.manifestRef);
      if (usage) {
        anyUsage = true;
        if (typeof usage.costUsd === 'number') runTotalCost += usage.costUsd;
        const models = usage.models.length ? usage.models.join(',') : '(none)';
        const cost = typeof usage.costUsd === 'number' ? usage.costUsd.toFixed(4) : '?';
        const turns = typeof usage.turns === 'number' ? String(usage.turns) : '?';
        console.log(`  ${outcome.id} | ${requested} | ${models} | ${cost} | ${turns}`);
      } else {
        console.log(`  ${outcome.id} | ${requested} | (not captured) | (not captured) | (not captured)`);
      }
    }
    console.log(`  run-total costUsd: ${runTotalCost.toFixed(4)}`);
    if (!anyUsage) {
      ok = false;
      console.error(
        '  Row 4 FAIL: no usage captured on any dispatch — rebuild the worker image from this branch ' +
        '(docker build -f docker/agora-worker/Dockerfile -t ghcr.io/quarrysystems/agora-worker:main .)',
      );
    } else {
      console.log('  Row 4 OK — at least one dispatch sealed usage.');
    }

    // 12. Stop serve.
    ac.abort();
    await servePromise.catch(() => {});

    // 13. Honest exit. A failed ITEM alone does not fail the harness (Tier-0); the
    //     four §4 rows are the contract.
    if (!ok) {
      console.error('\n=== dogfood run 3: one or more §4 acceptance rows FAILED — see above ===');
      process.exitCode = 1;
    } else {
      console.log(`\n=== dogfood run 3 OK — ${redArc ? 'RED arc (circle-back)' : 'GREEN arc'}: all §4 rows green ===`);
      console.log('   patches in examples/dogfood-gated/patches/ — Tier-0 review before merge.');
      if (redArc) {
        console.log('   red-arc apply order (spec §6): the FIX patch + announce~2 patch (NOT write-page + fix — both create the page).');
      }
    }
  } finally {
    store.close();
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error('dogfood-gated crashed:', err);
  process.exit(1);
});
