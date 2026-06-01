// offload-fanout — §7 acceptance demo (real-Docker run).
//
// Drives the full fan-out flow end-to-end against real containers:
//   AgoraOrchestrator.tick (concurrency 2) → DispatchExecutor.fire (3 edit items in parallel,
//   shared.ts serialized by its resourceLock) → reconcile → verify item depends on all three.
//   After completion: fetch result_refs + assemble tamper-detecting audit bundle.
//
// Prerequisites (this is a LIVE run, not a unit test):
//   - Docker reachable (local Desktop, or DOCKER_HOST → a remote daemon).
//   - The worker image pullable: ghcr.io/quarrysystems/agora-worker:latest.
//   - ANTHROPIC_API_KEY set in the environment.
//     Run via: pnpm start:env   (reads ../../.env)   or export the var and `pnpm start`.

import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
} from '@quarry-systems/agora-orchestrator';
import type { Run } from '@quarry-systems/agora-orchestrator';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAN_PATH = join(__dirname, '../plan.json');
const WORKER_IMAGE = 'ghcr.io/quarrysystems/agora-worker:latest';
const RUN_TIMEOUT_MS = 300_000; // 5 min: fan-out of 3 edit items + verify

// ---------------------------------------------------------------------------
// Live-run guard: check the API key HERE (not in agora.config.mjs) so config
// import is always safe and composable.
// ---------------------------------------------------------------------------
const apiKeyRaw = process.env.ANTHROPIC_API_KEY;
if (!apiKeyRaw) {
  console.error(
    'ANTHROPIC_API_KEY is not set. Run `pnpm start:env` (reads ../../.env) or export it.',
  );
  process.exit(1);
}
// After the guard above, apiKey is guaranteed a string. TS strict doesn't
// narrow across the function boundary, so we use a non-null assertion here.
const apiKey: string = apiKeyRaw;

async function main(): Promise<void> {
  // Per-run unique dirs: the mailbox/storage persist on disk, so a FIXED path
  // would let a later run read an earlier run's stale outbox records for the
  // reused runId — verifying them against this run's fresh store yields a
  // spurious `anchor-missing`. A fresh dir per run isolates each run cleanly.
  const runDir = await mkdtemp(join(tmpdir(), 'agora-fanout-'));
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
      namespace: 'offload-fanout',
      compute: { 'local-docker': new LocalDockerProvider({ allowUnpinnedImage: true }) },
      storage: new LocalStorageProvider({ rootDir: storageRoot }),
      secretStores: { local: new LocalSecretStore({ dir: secretDir }) },
      credentials: { none: new NoopCredentialProvider() },
      targets: { local: { compute: 'local-docker', credentials: 'none', secretStore: 'local' } },
      resultSink: new StdoutResultSink(),
    });

    // 2. Register subagents:
    //    code-edit: renames the symbol OLD_NAME → NEW_NAME in the targeted file.
    //    verify: checks that the renamed symbol NEW_NAME appears in all three fixture files.
    // Seed the fixture files into the capability so they overlay into EACH
    // worker's workspace (entrypoint §6 step 6). captureBaseline snapshots them
    // before the agent runs; the code-edit subagent renames the symbol in its
    // target file → a real workspace diff → a patch artifact surfaced as the
    // item's result_ref (the §7 escape leg). Without seeding, the worker has
    // nothing to edit and no patch is produced.
    const fixtureDir = join(__dirname, '../fixture');
    const fixtureFiles = Object.fromEntries(
      await Promise.all(
        (['alpha.ts', 'beta.ts', 'shared.ts'] as const).map(
          async (f) => [f, await readFile(join(fixtureDir, f), 'utf8')] as const,
        ),
      ),
    );
    await client.capabilities.register({
      name: 'fanout-cap',
      files: fixtureFiles,
    });
    // Use a promptTemplate (NOT systemPrompt): the claude-code adapter renders
    // systemPrompt VERBATIM but Mustache-substitutes a promptTemplate with the
    // dispatch input — so {{file}} becomes the concrete file (alpha.ts/…). Without
    // this, claude never learns which file to edit → no diff → no result_ref.
    await client.subagent.register({
      name: 'code-edit',
      promptTemplate:
        'You are working in the current directory (your workspace). A TypeScript file ' +
        '`{{file}}` exists in the workspace root and contains a line `export const OLD_NAME = ...`. ' +
        'Use the Edit tool to rename the identifier OLD_NAME to NEW_NAME in `{{file}}` only — ' +
        'edit and save that one file, change nothing else, then stop.',
      capabilities: ['fanout-cap'],
    });
    // V1 dispatches are ISOLATED: each runs in its own fresh workspace, so this
    // gate cannot see the edit subagents' changes (their patches escape as
    // artifacts, consumed downstream — V1.1). Per §7 the verify item's role here
    // is the DAG GATE: it runs only after all edits reach `done`. Keep it honest.
    await client.subagent.register({
      name: 'verify',
      systemPrompt:
        'You are the post-edit gate step for a fan-out run. It runs after all edit ' +
        'items have completed. Confirm your workspace contains the fixture files, then exit 0.',
      capabilities: ['fanout-cap'],
    });

    // 3. Audit primitives: local signer + LocalAnchor (tamper-detecting tier).
    const signer = createLocalSigner();
    const anchor = new LocalAnchor(store);
    const auditLog = new AuditLog({ store, signer, anchor });

    // 4. Orchestrator (concurrency 2 — edits fan out; shared.ts serialized by its lock).
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

    // 5. Mailbox transport + serve driver.
    const transport = new MailboxSubmissionTransport(new LocalDirMailbox(mailboxDir));
    const ac = new AbortController();
    const servePromise = serve({ orchestrator, transport, signal: ac.signal });

    // 6. OperationsApi: submit → watch → audit.
    const verifySignature = (root: Uint8Array, sig: { alg: string; bytes: Uint8Array; keyRef?: string }) =>
      verifyEd25519(root, sig, signer.publicKey);

    const api = new OperationsApi({
      transport,
      anchor,
      storage: client.storage,
      verifySignature,
    });

    // 7. Load and submit the example plan.
    const raw = await readFile(PLAN_PATH, 'utf-8');
    const plan = JSON.parse(raw) as Run;
    const runId = await api.submit(plan, 'human:demo');
    console.log(`submitted run '${runId}' (${plan.items.length} items) — watching…`);

    // 8. Watch until terminal or timeout.
    //    The timeout is driven by a setTimeout OUTSIDE the loop so that a stalled
    //    serve (no records yielded) still fires the deadline rather than sleeping forever.
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

    // 9. Fetch and print each edit item's resultRef.
    const statusRec = await api.status(runId);
    const items = Array.isArray(statusRec?.body)
      ? (statusRec.body as Array<{ id: string; status: string; resultRef?: string }>)
      : [];

    console.log('\n=== Item result_refs ===');
    let anyFailed = false;
    for (const item of items) {
      console.log(`  ${item.id}: ${item.status}${item.resultRef ? ' -> ' + item.resultRef : ''}`);
      if (item.status === 'failed') anyFailed = true;
    }

    // 10. Assemble and print the audit bundle.
    console.log('\n=== Audit bundle ===');
    let bundleOk = true;
    try {
      // serve publishes the audit export on epoch seal, which lands a tick AFTER
      // the items go terminal — so poll briefly for it rather than racing.
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
      console.log(`  intact:    ${bundle.report.intact}`);
      console.log(`  claim:     ${bundle.report.claim}`);
      console.log(`  anchorId:  ${bundle.report.anchorId ?? '(none)'}`);
      console.log(`  guarantee: ${bundle.report.guarantee}`);
      if (bundle.report.failure) console.log(`  failure:   ${bundle.report.failure}`);
      if (!bundle.report.intact) bundleOk = false;
    } catch (err) {
      console.error('  audit failed:', err);
      bundleOk = false;
    }

    // 11. Stop the serve loop.
    ac.abort();
    await servePromise.catch(() => {}); // ignores the abort rejection

    // 12. Honest exit.
    if (anyFailed || !bundleOk) {
      console.error('\n=== offload-fanout FAILED (item failure or !intact bundle) ===');
      process.exitCode = 1;
    } else {
      console.log('\n=== offload-fanout OK — fan-out completed with tamper-detecting audit bundle ===');
    }
  } finally {
    store.close();
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error('offload-fanout demo crashed:', err);
  process.exit(1);
});
