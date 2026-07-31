// deploy/serve-stack/client/chain.mjs — multi-item handoff check for the always-on stack.
//
// Sibling of smoke.mjs. Where smoke.mjs submits ONE item with no dependencies,
// this submits THREE with two real `needs` handoff edges, so the run exercises:
//
//   - multi-item scheduling and fan-out (verify + announce both consume edit)
//   - the `needs` / InputBinding handoff lane (patch -> inputs/work)
//   - resourceLocks on two distinct files
//   - the handoff row of `pangolin verify`, which reports `n/a` at zero edges
//     (as smoke.mjs does) and therefore proves nothing about provenance there
//
// Run it exactly like smoke.mjs, from deploy/serve-stack:
//   node client/chain.mjs
//
// NOTE: invoke the CLI follow-ups WITHOUT `pnpm exec` — it rewrites cwd to the
// package root, so the CLI would load the serve config instead of this one.
// See KNOWN-ISSUES.md #2.

import { readFile } from 'node:fs/promises';

import { OperationsApi } from '@quarry-systems/pangolin-orchestrator';

import client, { orch } from './pangolin.config.mjs';

// 1. One fixture file, same shape as smoke-cap.
await client.capabilities.register({
  name: 'chain-cap',
  files: { 'chain.ts': 'export const OLD_NAME = 1;\n' },
});

// Producer: gets the capability, so chain.ts is in its workspace.
await client.subagent.register({
  name: 'chain-edit',
  promptTemplate:
    'You are working in the current directory (your workspace). A TypeScript file ' +
    '`chain.ts` exists in the workspace root and contains a line `export const OLD_NAME = 1;`. ' +
    'Use the Edit tool to rename the identifier OLD_NAME to NEW_NAME in `chain.ts` only — ' +
    'edit and save that one file, change nothing else, then stop.',
  capabilities: ['chain-cap'],
});

// Consumers: NO capability. Their only source of truth is the handed-off patch,
// which is what makes the provenance edge meaningful rather than incidental.
await client.subagent.register({
  name: 'chain-verify',
  promptTemplate:
    'Your workspace does NOT contain the edited file. `inputs/work` is a unified-diff ' +
    'patch produced by an upstream step — READ it, do NOT apply it. Confirm it renames ' +
    'the identifier OLD_NAME to NEW_NAME in `chain.ts`. Write your conclusion to EXACTLY ' +
    '`outputs/report` (no file extension, at the outputs/ root) as a JSON object ' +
    '{ "ok": true|false, "detail": "one sentence" }. Create no other files. Then stop.',
  capabilities: [],
});

await client.subagent.register({
  name: 'chain-announce',
  promptTemplate:
    'Your workspace does NOT contain the edited file. `inputs/work` is a unified-diff ' +
    'patch produced by an upstream step — READ it, do NOT apply it. Create a file ' +
    '`NOTES.md` in the workspace root containing exactly one line summarising what the ' +
    'patch changed. Create no other files. Then stop.',
  capabilities: [],
});

// 2. Fresh run id per invocation (submitRun is idempotent by id).
const plan = JSON.parse(
  await readFile(new URL('./chain-plan.json', import.meta.url), 'utf8'),
);
plan.id = 'chain-' + Date.now();

// 3. Submit over the mailbox transport — serve remains the single DB writer.
const api = new OperationsApi({
  transport: orch.transport,
  anchor: orch.anchor,
  storage: orch.storage,
  verifySignature: orch.verifySignature,
});
const runId = await api.submit(plan, 'human:chain');

console.log(`submitted chain run '${runId}' (3 items, 2 handoff edges)`);
console.log('');
console.log('Follow along / verify (from deploy/serve-stack/client):');
console.log(`  ../node_modules/.bin/pangolin orch watch ${runId}`);
console.log(`  ../node_modules/.bin/pangolin orch audit ${runId} --out chain-bundle.json`);
console.log('  ../node_modules/.bin/pangolin verify chain-bundle.json');
