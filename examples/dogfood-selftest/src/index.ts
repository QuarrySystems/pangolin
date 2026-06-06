// dogfood-selftest RUN 2 — agora offloads DEPENDENT work on its OWN source tree,
// exercising the typed-product handoff live (run 1, the 4-task independent fan-out,
// landed as PR #36; its plan is preserved as plan-run1.json).
//
// Two-task dependent chain via `needs` (no hand-written depends_on on task B):
//   A `readme-handoff-section` — adds a Typed-product handoff section to README.md.
//   B `docs-handoff-page`     — declares needs.patch = A's patch; the worker
//      materializes it at inputs/patch, a capability-shipped agora-setup.sh
//      git-applies it BEFORE the agent runs, and the agent writes the docs-site
//      page consistent with A's actual wording. B literally builds on A's edit.
// After the run: patches escape per task, the audit bundle is assembled, and
// verifyBundle must report intact + checks.handoff.ok (provenance closure) —
// that green row on a REAL run is the point of run 2.
// Tier 0 posture unchanged: no in-worker toolchain; you + CI review the patches.
//
// Prerequisites (LIVE run):
//   - Docker reachable (local Desktop, or DOCKER_HOST → a remote daemon).
//   - The worker image pullable: ghcr.io/quarrysystems/agora-worker:main
//     (`:main` carries the Wave A–C handoff worker code; `:latest` only rolls on
//     v* tags and is still pre-handoff — do NOT use it for this run).
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
} from '@quarry-systems/agora-orchestrator';
import type { Run } from '@quarry-systems/agora-orchestrator';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../..');
const PLAN_PATH = join(__dirname, '../plan.json');
const PATCHES_DIR = join(__dirname, '../patches');
// :main carries Waves A–C (handoff worker code); :latest is pre-handoff until a v* tag.
const WORKER_IMAGE = 'ghcr.io/quarrysystems/agora-worker:main';
const RUN_TIMEOUT_MS = 600_000; // 10 min: 2 real edit tasks, B strictly after A

// The agora source files each task needs in its workspace, keyed by the REAL
// repo-relative path so the escaped patch applies straight back onto the repo.
// Both tasks share one seed capability: A edits README.md; B's workspace gets the
// SAME README.md base so A's patch (materialized at inputs/patch) applies cleanly.
const SEED_FILES = [
  'README.md',     // A's target; B's apply base
  'CHANGELOG.md',  // wording source for A
  'docs-site/src/content/docs/explanation/how-offload-runs.md', // style reference for B's new page
] as const;

// Capability shipped ONLY to task B's subagent: applies the upstream patch before
// the agent runs. Setup scripts execute after overlay (inputs/ exists) and before
// captureBaseline — so the applied content is part of B's baseline and B's escaped
// patch contains ONLY B's own edits. git init is required: the workspace is not a
// repo until captureBaseline. (Path is inputs/<needs-key>; the needs key is `patch`.)
const APPLY_PATCH_SETUP_SH = '#!/bin/sh\nset -e\ngit init -q\ngit apply inputs/patch\n';

const apiKeyRaw = process.env.ANTHROPIC_API_KEY;
if (!apiKeyRaw) {
  console.error('ANTHROPIC_API_KEY is not set. Run `pnpm start:env` (reads ../../.env) or export it.');
  process.exit(1);
}
const apiKey: string = apiKeyRaw;

async function main(): Promise<void> {
  // Fresh per-run dirs (a fixed storage/mailbox path would let a later run read a
  // prior run's stale records for a reused runId — see offload-fanout note).
  const runDir = await mkdtemp(join(tmpdir(), 'agora-dogfood-'));
  const mailboxDir = join(runDir, 'mailbox');
  const storageRoot = join(runDir, 'storage');
  const secretDir = join(runDir, 'secrets');
  await mkdir(mailboxDir, { recursive: true });
  await mkdir(storageRoot, { recursive: true });
  await mkdir(secretDir, { recursive: true });
  const store = new SqliteRunStateStore(); // :memory: — single-process

  try {
    // 1. Wire the local-stack client.
    const client = new AgoraClient({
      namespace: 'dogfood-selftest',
      compute: { 'local-docker': new LocalDockerProvider({ allowUnpinnedImage: true }) },
      storage: new LocalStorageProvider({ rootDir: storageRoot }),
      secretStores: { local: new LocalSecretStore({ dir: secretDir }) },
      credentials: { none: new NoopCredentialProvider() },
      targets: { local: { compute: 'local-docker', credentials: 'none', secretStore: 'local' } },
      resultSink: new StdoutResultSink(),
    });

    // 2. Seed the agora source files into ONE capability overlaid into every
    //    worker's workspace (nested paths supported — overlay-engine mkdir -p's).
    //    captureBaseline snapshots them before the agent runs; the agent's
    //    edits/creations become the escaped patch (result_ref).
    const seeded = Object.fromEntries(
      await Promise.all(
        SEED_FILES.map(async (rel) => [rel, await readFile(join(REPO_ROOT, rel), 'utf8')] as const),
      ),
    );
    await client.capabilities.register({ name: 'agora-src', files: seeded });
    await client.capabilities.register({
      name: 'apply-upstream-patch',
      files: { 'agora-setup.sh': APPLY_PATCH_SETUP_SH },
    });

    // 3. Two templated subagents sharing one prompt. {{{instructions}}} is unescaped
    //    so the task text passes through verbatim (backticks/punctuation intact).
    //    `apply-edit` differs only by also carrying the apply-upstream-patch
    //    capability (per-item capability overrides aren't threaded through the
    //    orchestrator dispatch path, so the binding lives on the subagent).
    const PROMPT =
      'You are a coding agent working inside a workspace that holds a subset of the agora ' +
      'monorepo at real repository paths (e.g. `README.md`, `docs-site/src/content/...`). Complete EXACTLY ' +
      'the task below. Create or edit only the file(s) the task names; change nothing else. Use ' +
      'the Edit/Write tools, then stop.\n\nTASK:\n{{{instructions}}}';
    await client.subagent.register({
      name: 'code-edit',
      promptTemplate: PROMPT,
      capabilities: ['agora-src'],
    });
    await client.subagent.register({
      name: 'apply-edit',
      promptTemplate: PROMPT,
      capabilities: ['agora-src', 'apply-upstream-patch'],
    });

    // 4. Audit primitives (tamper-detecting tier — LocalAnchor).
    const signer = createLocalSigner();
    const anchor = new LocalAnchor(store);
    const auditLog = new AuditLog({ store, signer, anchor });

    // 5. Orchestrator. concurrency 2: the 4 items hold disjoint per-file locks, so
    //    they never serialize on a lock — concurrency alone paces them (2 at a time).
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
      queues: { default: { concurrency: 2 } },
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
        for (const item of rec.body as Array<{ id: string; status: string; resultRef?: string }>) {
          console.log(`  ${item.id}: ${item.status}${item.resultRef ? ' resultRef=' + item.resultRef : ''}`);
        }
      }
    }
    clearTimeout(timeoutHandle);

    // 9. Download each item's patch artifact for review.
    const statusRec = await api.status(runId);
    const items = Array.isArray(statusRec?.body)
      ? (statusRec.body as Array<{ id: string; status: string; resultRef?: string }>)
      : [];
    await mkdir(PATCHES_DIR, { recursive: true });
    console.log('\n=== Patches (review, then `git apply` from the repo root) ===');
    let anyFailed = false;
    for (const item of items) {
      if (item.status === 'failed') anyFailed = true;
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

    // 10. Assemble + print the audit bundle.
    console.log('\n=== Audit bundle ===');
    let bundleOk = true;
    try {
      let bundle: Awaited<ReturnType<typeof api.audit>> | undefined;
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
      // api.audit's embedded report is the bare verify (handoff is 'n/a' there by
      // design — entry-level verify has no manifests). Re-verify the assembled
      // bundle with verifyBundle to compute the PROVENANCE-CLOSURE handoff check:
      // the run-2 payoff is this row being green on a real dependent run.
      const report = await verifyBundle(bundle, { anchor, verifySignature });
      console.log(`  intact:         ${report.intact}`);
      console.log(`  claim:          ${report.claim}`);
      console.log(`  anchorId:       ${report.anchorId ?? '(none)'}`);
      console.log(`  guarantee:      ${report.guarantee}`);
      console.log(`  checks.handoff: ${JSON.stringify(report.checks.handoff)}`);
      if (report.failure) console.log(`  failure:        ${report.failure}`);
      if (!report.intact || report.checks.handoff.ok !== true) bundleOk = false;
    } catch (err) {
      console.error('  audit failed:', err);
      bundleOk = false;
    }

    // 11. Stop serve.
    ac.abort();
    await servePromise.catch(() => {});

    // 12. Honest exit. A failed ITEM does not fail the harness — review the patches.
    if (!bundleOk) {
      console.error('\n=== dogfood run 2: bundle NOT intact or handoff closure NOT proven ===');
      process.exitCode = 1;
    } else {
      const n = items.filter((i) => i.resultRef).length;
      console.log(`\n=== dogfood run 2 OK — ${n}/${items.length} items produced a patch; provenance closure PROVEN on a real dependent run ===`);
      console.log('   apply order from repo root: patches/readme-handoff-section.patch, then patches/docs-handoff-page.patch');
      if (anyFailed) console.log('   (one or more items failed — expected-possible on Tier 0; inspect above)');
    }
  } finally {
    store.close();
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error('dogfood-selftest crashed:', err);
  process.exit(1);
});
