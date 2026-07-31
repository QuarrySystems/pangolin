// deploy/serve-stack/client/submit-converted.mjs — submit a plan.json produced
// by remora's `to-plan-json` converter.
//
//   node client/submit-converted.mjs <plan.json>
//
// remora converts (pure, no pangolin dependencies); this submits. That split is
// deliberate — the converter never imports pangolin's packages, so it stays
// portable and testable without a running stack.
//
// Registers the `dag-implementer` subagent the converted plan names, plus a
// capability seeding the fixture file its first task edits. Both registrations
// are idempotent content-addressed storage, so re-running is safe.

import { readFile } from 'node:fs/promises';

import { OperationsApi } from '@quarry-systems/pangolin-orchestrator';

import client, { orch } from './pangolin.config.mjs';

const planPath = process.argv[2];
if (!planPath) {
  console.error('usage: node client/submit-converted.mjs <plan.json>');
  process.exit(1);
}

// Fixture the loop-proof plan's first task expects in its workspace.
await client.capabilities.register({
  name: 'dag-proof-cap',
  files: { 'proof.ts': 'export const OLD_NAME = 1;\n' },
});

// The subagent every converted item names via inputs.subagent. Its prompt is the
// task body verbatim: renderPrompt runs Mustache with workerInput as the view,
// and pangolin disables Mustache's HTML escaping globally, so code fences,
// quotes and angle brackets in the brief survive intact.
await client.subagent.register({
  name: 'dag-implementer',
  promptTemplate:
    'You are working in the current directory, which is your workspace.\n\n{{instructions}}',
  capabilities: ['dag-proof-cap'],
});

const plan = JSON.parse(await readFile(planPath, 'utf8'));

const api = new OperationsApi({
  transport: orch.transport,
  anchor: orch.anchor,
  storage: orch.storage,
  verifySignature: orch.verifySignature,
});
const runId = await api.submit(plan, 'human:converted');

console.log(`submitted '${runId}' (${plan.items.length} items, queue '${plan.queue}')`);
console.log('');
console.log('Follow along (from deploy/serve-stack/client — NOT via pnpm exec, see KNOWN-ISSUES.md #2):');
console.log(`  ../node_modules/.bin/pangolin orch watch ${runId}`);
console.log(`  ../node_modules/.bin/pangolin orch audit ${runId} --out converted-bundle.json`);
console.log('  ../node_modules/.bin/pangolin verify converted-bundle.json');
