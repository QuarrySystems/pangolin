// run-plain.ts — the agent ALONE, with the Pangolin seam removed.
//
// This proves acceptance criterion #1: the LangGraph agent runs standalone. It
// imports only the agent + LangGraph. Diff this against run-sealed.ts to see
// exactly how few lines the Pangolin seam adds.
//
//   pnpm --filter langgraph-changeorder-example agent

import { pathToFileURL } from 'node:url';
import { Command } from '@langchain/langgraph';
import { buildChangeOrderAgent, type Approval, type ChangeOrder, type Outcome } from './agent.js';

/** The single change order this demo processes, end to end. */
export const SAMPLE_CHANGE_ORDER: ChangeOrder = {
  id: 'CO-2026-0417',
  project: 'Riverside Bridge Retrofit',
  description: 'Substitute weathering steel for the east-span girders after a corrosion finding.',
  baselineCostUsd: 184_500,
  proposedCostUsd: 221_750,
  scheduleImpactDays: 12,
};

/** How the human decides at the approval gate. The demo supplies a fixed
 *  decision; a real deployment would block on a reviewer UI / Slack / email. */
export type Decide = (req: unknown) => Approval | Promise<Approval>;

/** Run the agent to completion, resuming the interrupt with a human decision.
 *  No Pangolin anywhere — this is the "before" picture. */
export async function runPlain(changeOrder: ChangeOrder, decide: Decide): Promise<Outcome> {
  const agent = buildChangeOrderAgent();
  const config = { configurable: { thread_id: changeOrder.id }, streamMode: 'updates' as const };

  // Run until the approval interrupt suspends the graph.
  let request: unknown;
  for await (const chunk of await agent.stream({ changeOrder }, config)) {
    const interrupts = (chunk as { __interrupt__?: Array<{ value: unknown }> }).__interrupt__;
    if (interrupts) request = interrupts[0]?.value;
  }
  if (request === undefined) throw new Error('expected the agent to pause at the approval gate');

  // A human decides; resume the graph with that decision.
  const approval = await decide(request);
  let outcome: Outcome | undefined;
  for await (const chunk of await agent.stream(new Command({ resume: approval }), config)) {
    const fin = (chunk as { finalize?: { outcome?: Outcome } }).finalize;
    if (fin?.outcome) outcome = fin.outcome;
  }
  if (!outcome) throw new Error('agent finished without an outcome');
  return outcome;
}

const fixedApproval: Decide = () => ({
  approver: 'human:dana.okafor (Project Director)',
  decision: 'approve',
  decidedAt: '2026-06-25T16:40:00.000Z',
  reason: 'Corrosion finding is material; substitution is the lowest-risk remedy.',
});

// Direct-invocation guard (ESM): true only when run as `tsx src/run-plain.ts`,
// never when imported by a test. (pathToFileURL handles Windows drive paths.)
const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runPlain(SAMPLE_CHANGE_ORDER, fixedApproval)
    .then((outcome) => {
      console.log('agent ran standalone (no Pangolin):');
      console.log(JSON.stringify(outcome, null, 2));
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
