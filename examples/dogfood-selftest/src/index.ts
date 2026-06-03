// dogfood-selftest — agora offloads real maintenance work on its OWN source tree.
//
// Four file-disjoint tasks fan out to parallel Claude Code workers. Each worker
// gets a fresh workspace seeded with the exact agora source files its task needs
// (at real repo-relative paths), makes its edit, and the orchestrator escapes the
// workspace diff as a content-addressed patch artifact (the item's result_ref).
// After the run, each patch is downloaded to ./patches/<item>.patch for you to
// review, `git apply`, and let CI verify — this is Tier 0: NO in-worker toolchain,
// so the worker cannot run vitest/tsc on its own edit. Human + CI are the verifier.
//
// Prerequisites (LIVE run):
//   - Docker reachable (local Desktop, or DOCKER_HOST → a remote daemon).
//   - The worker image pullable: ghcr.io/quarrysystems/agora-worker:latest.
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
} from '@quarry-systems/agora-orchestrator';
import type { Run } from '@quarry-systems/agora-orchestrator';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../..');
const PLAN_PATH = join(__dirname, '../plan.json');
const PATCHES_DIR = join(__dirname, '../patches');
const WORKER_IMAGE = 'ghcr.io/quarrysystems/agora-worker:latest';
const RUN_TIMEOUT_MS = 600_000; // 10 min: 4 real edit tasks under concurrency 2

// The agora source files each task needs in its workspace, keyed by the REAL
// repo-relative path so the escaped patch applies straight back onto the repo.
// Targets are the files tasks edit/create; refs are read-only style examples.
const SEED_FILES = [
  // task targets (read to edit / read to model a new test against)
  'packages/agora-cli/src/sync.ts',
  'packages/agora-client/src/errors.ts',
  'packages/agora-client/src/dispatch.ts',
  'packages/agora-cli/src/manifest-parser.ts',
  // style references for the two new-test tasks
  'packages/agora-cli/test/frontmatter.test.ts',
  'packages/agora-client/test/secret-ttl.test.ts',
] as const;

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

    // 3. One templated code-edit subagent. {{{instructions}}} is unescaped so the
    //    task text passes through verbatim (backticks/punctuation intact).
    await client.subagent.register({
      name: 'code-edit',
      promptTemplate:
        'You are a coding agent working inside a workspace that holds a subset of the agora ' +
        'monorepo at real repository paths (e.g. `packages/agora-cli/src/...`). Complete EXACTLY ' +
        'the task below. Create or edit only the file(s) the task names; change nothing else. Use ' +
        'the Edit/Write tools, then stop.\n\nTASK:\n{{{instructions}}}',
      capabilities: ['agora-src'],
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

    // 11. Stop serve.
    ac.abort();
    await servePromise.catch(() => {});

    // 12. Honest exit. A failed ITEM does not fail the harness — review the patches.
    if (!bundleOk) {
      console.error('\n=== dogfood-selftest: audit bundle NOT intact ===');
      process.exitCode = 1;
    } else {
      const n = items.filter((i) => i.resultRef).length;
      console.log(`\n=== dogfood-selftest OK — ${n}/${items.length} items produced a patch; bundle tamper-detecting + intact ===`);
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
