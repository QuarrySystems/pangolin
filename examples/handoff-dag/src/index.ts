// handoff-dag — §8 acceptance demo (real-Docker run).
//
// Drives the typed-product handoff flow end-to-end against real containers:
//   AgoraOrchestrator.tick → DispatchExecutor.fire (edit-a produces patch → apply-patch
//   binds it via `needs` and applies it with `git apply inputs/patch`).
//   After completion: assemble the audit bundle + verifyBundle for provenance-closure proof.
//
// Prerequisites (this is a LIVE run, not a unit test):
//   - Docker reachable (local Desktop, or DOCKER_HOST → a remote daemon).
//   - The worker image pullable: ghcr.io/quarrysystems/agora-worker:latest.
//   - ANTHROPIC_API_KEY set in the environment.
//     Run via: pnpm start:env   (reads ../../.env)   or export the var and `pnpm start`.

import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPLY_PATCH_SETUP_SH } from './capabilities.js';
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
  verifyBundle,
  serve,
} from '@quarry-systems/agora-orchestrator';
import type { Run } from '@quarry-systems/agora-orchestrator';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAN_PATH = join(__dirname, '../plan.json');
const WORKER_IMAGE = 'ghcr.io/quarrysystems/agora-worker:latest';
const RUN_TIMEOUT_MS = 300_000; // 5 min

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
  // Per-run unique dirs to isolate each invocation.
  const runDir = await mkdtemp(join(tmpdir(), 'agora-handoff-'));
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
      namespace: 'handoff-dag',
      compute: { 'local-docker': new LocalDockerProvider({ allowUnpinnedImage: true }) },
      storage: new LocalStorageProvider({ rootDir: storageRoot }),
      secretStores: { local: new LocalSecretStore({ dir: secretDir }) },
      credentials: { none: new NoopCredentialProvider() },
      targets: { local: { compute: 'local-docker', credentials: 'none', secretStore: 'local' } },
      resultSink: new StdoutResultSink(),
    });

    // 2. Register subagents:
    //    code-edit: edits src/main.ts in the workspace (produces a patch artifact = result_ref).
    //    apply-patch: receives the upstream patch via `needs.patch` → inputs.inputRefs.patch
    //      and applies it with `git apply inputs/patch` via agora-setup.sh.
    //
    // The `apply-patch` capability ships agora-setup.sh which runs before the agent adapter,
    // AFTER the inputs/ overlay — so inputs/patch is already present when setup runs.
    const srcContent = '// main.ts\nexport const GREETING = "hello";\n';
    await client.capabilities.register({
      name: 'handoff-cap-edit',
      files: { 'src/main.ts': srcContent },
    });
    await client.capabilities.register({
      name: 'handoff-cap-apply',
      files: {
        'agora-setup.sh': APPLY_PATCH_SETUP_SH,
      },
    });

    // code-edit: renames GREETING → SALUTATION in src/main.ts (produces a patch result_ref).
    await client.subagent.register({
      name: 'code-edit',
      promptTemplate:
        'You are working in the current directory (your workspace). A TypeScript file ' +
        '`src/main.ts` exists and contains `export const GREETING`. ' +
        'Use the Edit tool to rename the identifier GREETING to SALUTATION in `src/main.ts` only — ' +
        'edit and save that file, change nothing else, then stop.',
      capabilities: ['handoff-cap-edit'],
    });

    // apply-patch: the patch from edit-a is overlaid as inputs/patch before agora-setup.sh
    // runs `git apply inputs/patch`, building on the upstream edit.
    await client.subagent.register({
      name: 'apply-patch',
      systemPrompt:
        'The upstream patch has already been applied to your workspace by agora-setup.sh. ' +
        'Verify the file `src/main.ts` now contains SALUTATION (not GREETING), then exit 0.',
      capabilities: ['handoff-cap-apply'],
    });

    // 3. Audit primitives.
    const signer = createLocalSigner();
    const anchor = new LocalAnchor(store);
    const auditLog = new AuditLog({ store, signer, anchor });

    // 4. Orchestrator (concurrency 2; `apply-patch` depends_on edit-a via needs auto-union).
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

    // 6. OperationsApi: submit → watch → audit → verifyBundle.
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

    // 9. Print each item's resultRef.
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

    // 10. Assemble the audit bundle + run provenance-closure verification.
    console.log('\n=== Audit bundle + handoff verification ===');
    let proofOk = false;
    try {
      if (watchAc.signal.aborted) {
        // Timeout fired — ac.abort() already stopped the serve loop so the
        // audit export will never arrive.  Skip the retry loop entirely.
        console.error('  timed out before audit export');
      } else {
        // Poll for the audit export (published after epoch seal).
        let rawBundle: Awaited<ReturnType<typeof api.audit>> | undefined;
        for (let i = 0; i < 15; i++) {
          try {
            rawBundle = await api.audit(runId);
            break;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (i === 14 || !/no audit export/.test(msg)) throw e;
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
        if (!rawBundle) throw new Error('audit export never became available');

        // verifyBundle adds the handoff closure check on top of chain/anchor/root.
        const report = await verifyBundle(rawBundle, { anchor, verifySignature });
        console.log(`  intact:           ${report.intact}`);
        console.log(`  claim:            ${report.claim}`);
        console.log(`  anchorId:         ${report.anchorId ?? '(none)'}`);
        console.log(`  guarantee:        ${report.guarantee}`);
        console.log(`  checks.chain:     ${JSON.stringify(report.checks.chain)}`);
        console.log(`  checks.root:      ${JSON.stringify(report.checks.root)}`);
        console.log(`  checks.handoff:   ${JSON.stringify(report.checks.handoff)}`);
        if (report.failure) console.log(`  failure:          ${report.failure}`);
        if (report.intact && report.checks.handoff.ok === true) {
          proofOk = true;
        }
      }
    } catch (err) {
      console.error('  audit/verify failed:', err);
    }

    // 11. Stop the serve loop.
    ac.abort();
    await servePromise.catch(() => {}); // ignores the abort rejection

    // 12. Honest exit: 0 only if the run completed AND provenance was proven.
    if (anyFailed || !proofOk) {
      console.error(
        '\n=== handoff-dag FAILED (item failure or !intact or !handoff.ok) ===',
      );
      process.exitCode = 1;
    } else {
      console.log(
        '\n=== handoff-dag OK — downstream applied upstream patch; every byte provenance-sealed ===',
      );
    }
  } finally {
    store.close();
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error('handoff-dag demo crashed:', err);
  process.exit(1);
});
