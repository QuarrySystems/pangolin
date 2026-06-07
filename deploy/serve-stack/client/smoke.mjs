// deploy/serve-stack/client/smoke.mjs — laptop health check for the always-on stack.
//
// Run from the laptop with the SSH tunnel up (ssh -L 9000:localhost:9000 …):
//   node deploy/serve-stack/client/smoke.mjs        (or: pnpm run smoke from deploy/serve-stack)
//
// Flow (spec §3, audit #6):
//   1. Register a tiny inline capability (one fixture file) + the smoke-edit subagent.
//      Registration is idempotent content-addressed storage — safe to re-run.
//   2. Read smoke-plan.json and stamp a FRESH run id ('smoke-' + Date.now()):
//      submitRun is idempotent by id, so a static id would health-check exactly
//      once per DB lifetime.
//   3. Submit via OperationsApi over the config's S3/MinIO transport.
//   4. Print the run id + the copy-pasteable follow-ups (watch / audit / verify).
//
// NO ANTHROPIC_API_KEY needed here — the serve container stages it per-dispatch.

import { readFile } from 'node:fs/promises';

import { OperationsApi } from '@quarry-systems/agora-orchestrator';

import client, { orch } from './agora.config.mjs';

// 1. Tiny inline capability: one fixture file the smoke-edit subagent renames.
await client.capabilities.register({
  name: 'smoke-cap',
  files: { 'smoke.ts': 'export const OLD_NAME = 1;\n' },
});

// smoke-edit: the run-2-style minimal rename — one file, one edit, stop.
await client.subagent.register({
  name: 'smoke-edit',
  promptTemplate:
    'You are working in the current directory (your workspace). A TypeScript file ' +
    '`smoke.ts` exists in the workspace root and contains a line `export const OLD_NAME = 1;`. ' +
    'Use the Edit tool to rename the identifier OLD_NAME to NEW_NAME in `smoke.ts` only — ' +
    'edit and save that one file, change nothing else, then stop.',
  capabilities: ['smoke-cap'],
});

// 2. Load the plan and stamp a fresh run id per invocation.
const plan = JSON.parse(
  await readFile(new URL('./smoke-plan.json', import.meta.url), 'utf8'),
);
plan.id = 'smoke-' + Date.now();

// 3. Submit over the mailbox transport. No SQLite opened here (D3) — the serve
//    container is the single writer; we only drop the run into its inbox.
const api = new OperationsApi({
  transport: orch.transport,
  anchor: orch.anchor,
  storage: orch.storage,
  verifySignature: orch.verifySignature,
});
const runId = await api.submit(plan, 'human:smoke');

// 4. Hand the operator the follow-ups.
console.log(`submitted smoke run '${runId}' (1 item)`);
console.log('');
console.log('Follow along / verify (from deploy/serve-stack/client — the CLI resolves agora.config.mjs from cwd; tunnel still up):');
console.log(`  pnpm exec agora orch watch ${runId}`);
console.log(`  pnpm exec agora orch audit ${runId} --out bundle.json`);
console.log('  pnpm exec agora verify bundle.json');
