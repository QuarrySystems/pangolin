// demo-claims-appeals — GTM Mode-A demo (real-Docker run).
//
// Domain-flavored reskin of offload-fanout: a batch of denied insurance claims
// fans out to parallel `claim-appeal` agents (concurrency 2), each drafts an
// appeal under a per-claim resource lock, each self-verifies before its patch
// escapes, and the run produces a tamper-detecting audit bundle. The `verify`
// item is the DAG gate (runs after all three appeals reach `done`).
//
// Prerequisites (LIVE run, not a unit test):
//   - Docker reachable (local Desktop, or DOCKER_HOST → a remote daemon).
//   - The worker image pullable: ghcr.io/quarrysystems/pangolin-worker:latest.
//   - ANTHROPIC_API_KEY set. Run: pnpm start:env (reads ../../.env) or export + pnpm start.
//
// TAMPER TIER: LocalAnchor → `tamper-detecting`. For the tamper-EVIDENT
// (external-immutable) recording, swap LocalAnchor → S3ObjectLockAnchor below.

import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PangolinClient,
  NoopCredentialProvider,
} from '@quarry-systems/pangolin-client';
import { LocalStorageProvider } from '@quarry-systems/pangolin-storage-local';
import { LocalDockerProvider } from '@quarry-systems/pangolin-providers-local-docker';
import { LocalSecretStore } from '@quarry-systems/pangolin-secret-store';
import {
  PangolinOrchestrator,
  SqliteRunStateStore,
  ManualTrigger,
  DispatchExecutor,
  AuditLog,
  LocalAnchor,
  createLocalSigner,
  verifyEd25519,
  verifyBundle,
  MailboxSubmissionTransport,
  LocalDirMailbox,
  OperationsApi,
  serve,
} from '@quarry-systems/pangolin-orchestrator';
import type { Run } from '@quarry-systems/pangolin-orchestrator';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAN_PATH = join(__dirname, '../plan.json');
const WORKER_IMAGE = 'ghcr.io/quarrysystems/pangolin-worker:latest';
const RUN_TIMEOUT_MS = 300_000; // 5 min: fan-out of 3 appeals + verify gate
const CLAIM_FILES = ['claim-001.json', 'claim-002.json', 'claim-003.json'] as const;

// --- demo presentation helpers (keep the live output readable on camera) -----
const STATUS_ICON: Record<string, string> = {
  pending: '·', ready: '•', running: '▸', done: '✓', failed: '✗', skipped: '⊘',
};
// pangolin://…/sha256:<64hex> → sha256:<10hex>… (full ref stays in the bundle).
const shortRef = (ref?: string): string => {
  if (!ref) return '';
  const hex = ref.split('sha256:')[1];
  return hex ? `sha256:${hex.slice(0, 10)}…` : ref;
};
const itemLine = (id: string, status: string, resultRef?: string): string => {
  const icon = STATUS_ICON[status] ?? '·';
  const ref = status === 'done' && resultRef ? `  ${shortRef(resultRef)}` : '';
  return `  ${icon} ${id.padEnd(11)} ${status}${ref}`;
};

// Live-run guard HERE (not in pangolin.config.mjs) so config import stays safe.
const apiKeyRaw = process.env.ANTHROPIC_API_KEY;
if (!apiKeyRaw) {
  console.error(
    'ANTHROPIC_API_KEY is not set. Run `pnpm start:env` (reads ../../.env) or export it.',
  );
  process.exit(1);
}
const apiKey: string = apiKeyRaw;

async function main(): Promise<void> {
  // Per-run unique dirs (see offload-fanout for why a fixed path causes stale
  // outbox reads → spurious anchor-missing).
  const runDir = await mkdtemp(join(tmpdir(), 'pangolin-claims-'));
  const mailboxDir = join(runDir, 'mailbox');
  const storageRoot = join(runDir, 'storage');
  const secretDir = join(runDir, 'secrets');
  await mkdir(mailboxDir, { recursive: true });
  await mkdir(storageRoot, { recursive: true });
  await mkdir(secretDir, { recursive: true });
  const store = new SqliteRunStateStore(); // :memory: — single-process

  try {
    // 1. Wire the local-stack client.
    const client = new PangolinClient({
      namespace: 'demo-claims-appeals',
      compute: { 'local-docker': new LocalDockerProvider({ allowUnpinnedImage: true }) },
      storage: new LocalStorageProvider({ rootDir: storageRoot }),
      secretStores: { local: new LocalSecretStore({ dir: secretDir }) },
      credentials: { none: new NoopCredentialProvider() },
      targets: { local: { compute: 'local-docker', credentials: 'none', secretStore: 'local' } },
      // No resultSink: the client falls back to a minimal DispatchResult (carries
      // exitCode + stdout for status/patch extraction) and emits NO machine
      // `{"kind":"dispatch.finished"}` lines — keeps the live demo output clean
      // without a stdout monkey-patch. Status is shown by the watch loop below.
    });

    // 2. Capability: seed the synthetic denial files into EACH worker's workspace
    //    + a setup script that makes the appeals/ output dir. captureBaseline
    //    snapshots them before the agent runs; the appeal the agent writes is the
    //    real workspace diff → the patch artifact surfaced as the item result_ref.
    const fixtureDir = join(__dirname, '../fixture');
    const claimFiles = Object.fromEntries(
      await Promise.all(
        CLAIM_FILES.map(async (f) => [f, await readFile(join(fixtureDir, f), 'utf8')] as const),
      ),
    );
    await client.capabilities.register({
      name: 'appeal-kit',
      files: { 'pangolin-setup.sh': '#!/bin/sh\nmkdir -p appeals\n', ...claimFiles },
    });

    // 3. The drafting agent. promptTemplate (NOT systemPrompt) so {{claim}} is
    //    Mustache-substituted with the per-item dispatch input. `verify` is the
    //    Gap-A self-verify: the worker runs it over the edit and seals pass/fail.
    await client.subagent.register({
      name: 'claim-appeal',
      promptTemplate: [
        'You are working in your workspace (the current directory). A JSON file',
        '`{{claim}}` in the workspace root describes a denied insurance claim with',
        'fields: claimId, claimant, service, denialReason, policySection, supportingFacts.',
        'Read it. Then write a formal appeal letter to `appeals/<claimId>.md` (use the',
        'claimId value verbatim) containing, in order:',
        '  1. The claimant name and claim id.',
        '  2. A paragraph directly rebutting denialReason, grounded in supportingFacts.',
        '  3. A citation of policySection.',
        'Create ONLY that one file. Change nothing else. Then stop.',
      ].join('\n'),
      capabilities: ['appeal-kit'],
      verify: {
        // language-agnostic; report-only; sealed with the patch (Beat 3).
        command: 'ls appeals/*.md >/dev/null 2>&1 && grep -q "§" appeals/*.md',
        timeout: 60,
      },
    });

    // 4. The DAG gate. V1 dispatches are ISOLATED — it cannot see the appeals'
    //    edits (those escape as artifacts, consumed downstream in V1.1). Its role
    //    here is the post-fan-out gate: it runs only after all three reach `done`.
    await client.subagent.register({
      name: 'verify',
      systemPrompt:
        'You are the post-fan-out gate for a claims-appeal batch. It runs after all ' +
        'appeal items have completed. Confirm your workspace contains the claim JSON ' +
        'files, then exit 0.',
      capabilities: ['appeal-kit'],
    });

    // 5. Audit primitives: local signer + LocalAnchor (tamper-detecting tier).
    const signer = createLocalSigner();
    const anchor = new LocalAnchor(store);
    const auditLog = new AuditLog({ store, signer, anchor });

    // 6. Orchestrator (concurrency 2 — appeals fan out under disjoint locks).
    const orchestrator = new PangolinOrchestrator({
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

    // 7. Mailbox transport + serve driver.
    const transport = new MailboxSubmissionTransport(new LocalDirMailbox(mailboxDir));
    const ac = new AbortController();
    const servePromise = serve({ orchestrator, transport, signal: ac.signal });

    // 8. OperationsApi: submit → watch → audit.
    const verifySignature = (
      root: Uint8Array,
      sig: { alg: string; bytes: Uint8Array; keyRef?: string },
    ) => verifyEd25519(root, sig, signer.publicKey);

    const api = new OperationsApi({ transport, anchor, storage: client.storage, verifySignature });

    // 9. Load and submit the example plan.
    const raw = await readFile(PLAN_PATH, 'utf-8');
    const plan = JSON.parse(raw) as Run;
    const runId = await api.submit(plan, 'human:demo');
    console.log(`\n▶ submitted run '${runId}' — ${plan.items.length} items (3 appeals fan out, then the verify gate)\n`);

    // 10. Watch until terminal or timeout. Print ONE line per status TRANSITION
    //     (not the full table every poll) so the live log reads as a clean
    //     progression: ▸ running → ✓ done, ⊘ skipped, ✗ failed.
    const watchAc = new AbortController();
    const timeoutHandle = setTimeout(() => {
      watchAc.abort();
      console.error('=== TIMEOUT: run did not complete within', RUN_TIMEOUT_MS / 1000, 's ===');
      ac.abort();
      process.exitCode = 1;
    }, RUN_TIMEOUT_MS);
    const lastStatus = new Map<string, string>();
    for await (const rec of api.watch(runId, { intervalMs: 3_000, signal: watchAc.signal })) {
      if (!Array.isArray(rec.body)) continue;
      for (const item of rec.body as Array<{ id: string; status: string; resultRef?: string }>) {
        if (lastStatus.get(item.id) === item.status) continue; // only on change
        lastStatus.set(item.id, item.status);
        console.log(itemLine(item.id, item.status, item.resultRef));
      }
    }
    clearTimeout(timeoutHandle);

    // 11. Fetch and print each appeal item's resultRef.
    const statusRec = await api.status(runId);
    const items = Array.isArray(statusRec?.body)
      ? (statusRec.body as Array<{ id: string; status: string; resultRef?: string }>)
      : [];

    console.log('\n━━━ Drafted appeals (content-addressed result refs) ━━━');
    let anyFailed = false;
    for (const item of items) {
      console.log(itemLine(item.id, item.status, item.resultRef));
      if (item.status === 'failed') anyFailed = true;
    }

    // 12. Assemble and print the audit bundle.
    console.log('\n━━━ Audit bundle (sealed epoch) ━━━');
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

      // 12b. THE HEADLINE BEAT — serialize the bundle, verify it clean, then forge
      //      exactly one byte and re-verify. A single flipped hex char in the first
      //      audit entry's hash breaks the recomputed chain → intact:false. This is
      //      the same verifyBundle() the `pangolin verify bundle.json --full` CLI runs.
      const bundlePath = join(runDir, 'bundle.json');
      await writeFile(bundlePath, JSON.stringify(bundle, null, 2));

      console.log('\n━━━ Tamper check (forge one byte → verification fails) ━━━');
      const clean = await verifyBundle(JSON.parse(await readFile(bundlePath, 'utf8')), { anchor, verifySignature });
      console.log(`  clean bundle.json:   intact=${clean.intact}  claim=${clean.claim}`);

      // Forge: flip one hex char of the first entry's hash, write a tampered copy.
      const forged = JSON.parse(await readFile(bundlePath, 'utf8')) as typeof bundle;
      const e0 = forged.auditLog.entries[0];
      e0.entryHash = (e0.entryHash[0] === '0' ? '1' : '0') + e0.entryHash.slice(1);
      const forgedPath = join(runDir, 'bundle.forged.json');
      await writeFile(forgedPath, JSON.stringify(forged, null, 2));

      const tampered = await verifyBundle(JSON.parse(await readFile(forgedPath, 'utf8')), { anchor, verifySignature });
      console.log(`  forged 1 byte:       intact=${tampered.intact}  failure=${tampered.failure ?? '(none)'}`);

      if (clean.intact === true && tampered.intact === false) {
        console.log('  ✓ tamper DETECTED — a single forged byte fails verification');
      } else {
        console.error('  ✗ TAMPER BEAT BROKEN — expected clean intact + forged !intact');
        bundleOk = false;
      }
    } catch (err) {
      console.error('  audit failed:', err);
      bundleOk = false;
    }

    // 13. Stop the serve loop.
    ac.abort();
    await servePromise.catch(() => {});

    // 14. Honest exit.
    if (anyFailed || !bundleOk) {
      console.error('\n✗ demo-claims-appeals FAILED (item failure or !intact bundle)');
      process.exitCode = 1;
    } else {
      console.log('\n✓ demo-claims-appeals OK — parallel appeals drafted, sealed, and tamper-detecting');
    }
  } finally {
    store.close();
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error('demo-claims-appeals crashed:', err);
  process.exit(1);
});
