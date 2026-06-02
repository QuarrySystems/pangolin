// examples/offload-minio/src/index.ts — host-side client driver (spec §5 client side).
//
// Drives the full MinIO-backed offload flow end-to-end:
//   1. Register capability (minio-cap) + subagents (code-edit, verify) on the shared client.
//   2. Submit plan.json via OperationsApi over the S3/MinIO transport (orch.transport).
//   3. Watch item status to terminal via api.watch().
//   4. Assemble + print the tamper-detecting audit bundle via api.audit().
//   5. Exit nonzero on any item failure, !intact bundle, or non-external-immutable guarantee.
//
// Prerequisites (LIVE RUN — not a unit test):
//   - MinIO running at http://localhost:9000 (host port, §2.1)
//   - The serve container + worker image available (see docker-compose.yml)
//   - AGORA_S3_ENDPOINT=http://localhost:9000  AGORA_S3_ACCESS_KEY=minioadmin  AGORA_S3_SECRET_KEY=minioadmin
//   - NO ANTHROPIC_API_KEY required in the driver process (the serve container stages it)
//
// Run via:
//   AGORA_S3_ENDPOINT=http://localhost:9000 AGORA_S3_ACCESS_KEY=minioadmin \
//   AGORA_S3_SECRET_KEY=minioadmin pnpm start

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OperationsApi } from '@quarry-systems/agora-orchestrator';
import type {
  Run,
  SubmissionTransport,
  ControlChannel,
  AuditAnchor,
} from '@quarry-systems/agora-orchestrator';
import type { AgoraClient } from '@quarry-systems/agora-client';

// Import the shared config's wired client + orch context.
// The host driver does NOT build a fresh AgoraClient — it reuses the config's,
// which is already backed by S3/MinIO.  The client's storage is already pointed
// at the MinIO endpoint via the AGORA_S3_* env vars read at module load time.
//
// agora.config.mjs is a plain-JS module with no .d.ts declarations.
// We import it as `any` and cast below so that strict TS stays clean without
// requiring a declaration file in the examples/ tree.
// @ts-ignore — .mjs has no declaration file; typed below via explicit casts.
import * as _config from '../agora.config.mjs';

interface StorageLike { get(ref: string): Promise<Uint8Array>; }

interface OrchContext {
  transport: SubmissionTransport & ControlChannel;
  anchor: AuditAnchor;
  storage: StorageLike;
  verifySignature: (root: Uint8Array, sig: { alg: string; bytes: Uint8Array; keyRef?: string }) => boolean;
  createOrchestrator: () => unknown;
}

const config = _config as { client: AgoraClient; orch: OrchContext };
const client = config.client;
const orch = config.orch;

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAN_PATH = new URL('../plan.json', import.meta.url);

// ---------------------------------------------------------------------------
// How long to wait for the run to complete (5 min — same as fanout demo).
// ---------------------------------------------------------------------------
const RUN_TIMEOUT_MS = 300_000;

async function main(): Promise<void> {
  // 1. Register the shared capability: seed the three fixture files into
  //    content-addressed storage so the worker's workspace is populated.
  const fixtureDir = join(__dirname, '../fixture');
  const fixtureFiles = Object.fromEntries(
    await Promise.all(
      (['alpha.ts', 'beta.ts', 'shared.ts'] as const).map(
        async (f) => [f, await readFile(join(fixtureDir, f), 'utf8')] as const,
      ),
    ),
  );

  await client.capabilities.register({
    name: 'minio-cap',
    files: fixtureFiles,
  });

  // code-edit: Mustache-substitutes {{file}} at dispatch time with the concrete
  // filename (alpha.ts / beta.ts / shared.ts) from workerInput.file.
  await client.subagent.register({
    name: 'code-edit',
    promptTemplate:
      'You are working in the current directory (your workspace). A TypeScript file ' +
      '`{{file}}` exists in the workspace root and contains a line `export const OLD_NAME = ...`. ' +
      'Use the Edit tool to rename the identifier OLD_NAME to NEW_NAME in `{{file}}` only — ' +
      'edit and save that one file, change nothing else, then stop.',
    capabilities: ['minio-cap'],
  });

  // verify: post-edit gate — runs after all edits reach done.
  await client.subagent.register({
    name: 'verify',
    systemPrompt:
      'You are the post-edit gate step for a MinIO offload run. It runs after all edit ' +
      'items have completed. Confirm your workspace contains the fixture files, then exit 0.',
    capabilities: ['minio-cap'],
  });

  // 2. Build the OperationsApi over the orch context (transport + anchor + storage).
  //    No SQLite opened here — the serve container holds the single-writer store (D3).
  const api = new OperationsApi({
    transport: orch.transport,
    anchor: orch.anchor,
    storage: orch.storage,
    verifySignature: orch.verifySignature,
  });

  // 3. Load and submit the plan.
  const raw = await readFile(PLAN_PATH, 'utf-8');
  const plan = JSON.parse(raw) as Run;
  const runId = await api.submit(plan, 'human:demo');
  console.log(`submitted run '${runId}' (${plan.items.length} items) — watching…`);

  // 4. Watch to terminal (or timeout).
  const watchAc = new AbortController();
  const timeoutHandle = setTimeout(() => {
    watchAc.abort();
    console.error('=== TIMEOUT: run did not complete within', RUN_TIMEOUT_MS / 1000, 's ===');
    process.exitCode = 1;
  }, RUN_TIMEOUT_MS);

  for await (const rec of api.watch(runId, { intervalMs: 3_000, signal: watchAc.signal })) {
    if (Array.isArray(rec.body)) {
      for (const item of rec.body as Array<{ id: string; status: string; resultRef?: string }>) {
        console.log(
          `  ${item.id}: ${item.status}${item.resultRef ? ' resultRef=' + item.resultRef : ''}`,
        );
      }
    }
  }
  clearTimeout(timeoutHandle);

  // 5. Print final item statuses + collect failure state.
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

  // 6. Assemble + print the audit bundle.
  //    serve publishes the audit export on epoch seal, which lands a tick AFTER
  //    the items go terminal — so poll briefly (up to 15 s) rather than racing.
  console.log('\n=== Audit bundle ===');
  let bundleOk = true;
  let guaranteeOk = false;

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
    if (bundle.report.guarantee === 'external-immutable') guaranteeOk = true;
  } catch (err) {
    console.error('  audit failed:', err);
    bundleOk = false;
  }

  // 7. Honest exit — fail on any item failure, !intact bundle, or wrong guarantee.
  if (anyFailed || !bundleOk || !guaranteeOk) {
    console.error(
      '\n=== offload-minio FAILED (item failure, !intact bundle, or guarantee !== external-immutable) ===',
    );
    process.exitCode = 1;
  } else {
    console.log(
      '\n=== offload-minio OK — MinIO-backed run completed with tamper-detecting audit bundle ===',
    );
  }
}

main().catch((err) => {
  console.error('offload-minio demo crashed:', err);
  process.exit(1);
});
