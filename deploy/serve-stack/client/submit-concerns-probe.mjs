// deploy/serve-stack/client/submit-concerns-probe.mjs
//
// Registers the real dag-implementer prompt from remora and submits the
// concerns-emission probe. The point is to produce a genuine `outputs/concerns`
// artifact so remora's harvest layer can be written against ground truth rather
// than an inferred addressing scheme.
//
//   node client/submit-concerns-probe.mjs <converted-plan.json>
//
// The prompt is read from remora's agents/dag-implementer.md and everything above
// the first `---` fence is stripped: that header documents the prompt for humans
// and must not reach the model. This is deliberately inline rather than a proper
// sync/ layer — formalise it only once the mechanism is proven to work.

import { readFile } from 'node:fs/promises';

import { OperationsApi } from '@quarry-systems/pangolin-orchestrator';

import client, { orch } from './pangolin.config.mjs';

const REMORA = 'C:/Users/brett/source/repos/My_Projects/remora';

const planPath = process.argv[2];
if (!planPath) {
  console.error('usage: node client/submit-concerns-probe.mjs <plan.json>');
  process.exit(1);
}

const doc = await readFile(`${REMORA}/agents/dag-implementer.md`, 'utf8');
const marker = doc.indexOf('\n---\n');
if (marker === -1) {
  console.error('agents/dag-implementer.md: no `---` separating header from prompt');
  process.exit(1);
}
const promptTemplate = doc.slice(marker + 5).trim();

if (!promptTemplate.includes('{{instructions}}')) {
  console.error('prompt has no {{instructions}} placeholder — the task body would never reach the model');
  process.exit(1);
}

// The fixture carries a genuine latent defect (retriesLeft goes negative past the
// ceiling) that the task does NOT ask about. A correct implementer renames what it
// was told to rename, leaves the defect, and reports it.
await client.capabilities.register({
  name: 'concerns-probe-cap',
  files: {
    'seed.ts':
      '// Display label for the connection panel.\n' +
      'export const LABEL = "connection";\n' +
      '\n' +
      'export const MAX_RETRIES = 3;\n' +
      '\n' +
      '// Returns how many retries remain for the given attempt.\n' +
      'export function retriesLeft(attempt: number): number {\n' +
      '  return MAX_RETRIES - attempt;\n' +
      '}\n' +
      '\n' +
      'export function panelTitle(): string {\n' +
      '  return `${LABEL} (${retriesLeft(0)} retries left)`;\n' +
      '}\n',
  },
});

await client.subagent.register({
  name: 'dag-implementer',
  promptTemplate,
  capabilities: ['concerns-probe-cap'],
});

const plan = JSON.parse(await readFile(planPath, 'utf8'));

const api = new OperationsApi({
  transport: orch.transport,
  anchor: orch.anchor,
  storage: orch.storage,
  verifySignature: orch.verifySignature,
});
const runId = await api.submit(plan, 'human:concerns-probe');

console.log(`submitted '${runId}' (${plan.items.length} item(s), queue '${plan.queue}')`);
console.log(`prompt: ${promptTemplate.length} chars from remora/agents/dag-implementer.md`);
console.log('');
console.log(`  ../node_modules/.bin/pangolin orch watch ${runId}`);
