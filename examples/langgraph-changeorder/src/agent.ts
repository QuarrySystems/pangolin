// agent.ts — an ORDINARY LangGraph.js agent. There is nothing unusual here and
// NOTHING about Pangolin: no provenance, no sealing, no audit. It is the kind of
// change-order workflow a reviewer would write on any normal day.
//
// The graph: ingest → assess → approvalGate → finalize.
// `approvalGate` pauses on a stock LangGraph `interrupt()` for a human to
// approve/reject; the driver resumes it with the human's decision. That pause is
// a plain workflow gate — it records nothing on its own. (The Pangolin seam in
// seam.ts is what turns that same decision into sealed, verifiable evidence.)

import { StateGraph, Annotation, START, END, MemorySaver, interrupt } from '@langchain/langgraph';

/** A proposed construction change order — the thing under review. */
export interface ChangeOrder {
  id: string;
  project: string;
  description: string;
  baselineCostUsd: number;
  proposedCostUsd: number;
  scheduleImpactDays: number;
}

/** The agent's machine assessment of the change order. */
export interface Assessment {
  costDeltaUsd: number;
  costDeltaPct: number;
  riskTier: 'routine' | 'review-required';
  requiresApproval: boolean;
  rationale: string;
}

/** A natural person's decision on the change order — supplied at the interrupt.
 *  (Mirrors Pangolin's ApprovalDecision shape so the seam can seal it verbatim.) */
export interface Approval {
  approver: string;
  decision: 'approve' | 'reject';
  decidedAt: string; // ISO-8601, supplied by the deciding system — not invented here
  reason?: string;
}

/** The terminal record the workflow produces. */
export interface Outcome {
  changeOrderId: string;
  outcome: 'APPROVED' | 'REJECTED';
  approver: string;
  decidedAt: string;
}

/** Cost threshold above which a change order needs human sign-off. */
export const APPROVAL_THRESHOLD_USD = 10_000;

const ChangeOrderState = Annotation.Root({
  changeOrder: Annotation<ChangeOrder>(),
  assessment: Annotation<Assessment | undefined>(),
  approval: Annotation<Approval | undefined>(),
  outcome: Annotation<Outcome | undefined>(),
});

type State = typeof ChangeOrderState.State;

/** ingest — normalize the incoming change order (round money to whole cents). */
function ingest(state: State): Partial<State> {
  const co = state.changeOrder;
  return {
    changeOrder: {
      ...co,
      baselineCostUsd: Math.round(co.baselineCostUsd * 100) / 100,
      proposedCostUsd: Math.round(co.proposedCostUsd * 100) / 100,
    },
  };
}

/** assess — compute the cost delta and decide whether human approval is required. */
function assess(state: State): Partial<State> {
  const co = state.changeOrder;
  const costDeltaUsd = Math.round((co.proposedCostUsd - co.baselineCostUsd) * 100) / 100;
  const costDeltaPct =
    co.baselineCostUsd > 0 ? Math.round((costDeltaUsd / co.baselineCostUsd) * 1000) / 1000 : 0;
  const requiresApproval = costDeltaUsd > APPROVAL_THRESHOLD_USD || co.scheduleImpactDays > 7;
  return {
    assessment: {
      costDeltaUsd,
      costDeltaPct,
      riskTier: requiresApproval ? 'review-required' : 'routine',
      requiresApproval,
      rationale: requiresApproval
        ? `Cost delta $${costDeltaUsd} (${(costDeltaPct * 100).toFixed(1)}%) and/or ${co.scheduleImpactDays}d schedule impact exceeds the routine threshold.`
        : `Within routine limits (≤ $${APPROVAL_THRESHOLD_USD}, ≤ 7d).`,
    },
  };
}

/** approvalGate — pause for a human decision via a stock LangGraph interrupt.
 *  `interrupt(payload)` suspends the run; the driver resumes it with an Approval,
 *  which becomes this node's return value. This is a PLAIN gate: it records nothing. */
function approvalGate(state: State): Partial<State> {
  const decision = interrupt({
    kind: 'change-order-approval',
    changeOrder: state.changeOrder,
    assessment: state.assessment,
  }) as Approval;
  return { approval: decision };
}

/** finalize — turn the human decision into the terminal outcome record. */
function finalize(state: State): Partial<State> {
  const approval = state.approval;
  if (!approval) throw new Error('finalize reached without an approval decision');
  return {
    outcome: {
      changeOrderId: state.changeOrder.id,
      outcome: approval.decision === 'approve' ? 'APPROVED' : 'REJECTED',
      approver: approval.approver,
      decidedAt: approval.decidedAt,
    },
  };
}

/** The ordered list of node names the graph executes, for any observer that wants
 *  to label work without reaching into LangGraph internals. */
export const NODE_SEQUENCE = ['ingest', 'assess', 'approvalGate', 'finalize'] as const;

/** Build and compile the change-order agent with an in-memory checkpointer
 *  (the checkpointer is what makes `interrupt()`/resume possible). Ordinary
 *  LangGraph — callable with `.invoke()` / `.stream()` and a thread id. */
export function buildChangeOrderAgent() {
  const graph = new StateGraph(ChangeOrderState)
    .addNode('ingest', ingest)
    .addNode('assess', assess)
    .addNode('approvalGate', approvalGate)
    .addNode('finalize', finalize)
    .addEdge(START, 'ingest')
    .addEdge('ingest', 'assess')
    .addEdge('assess', 'approvalGate')
    .addEdge('approvalGate', 'finalize')
    .addEdge('finalize', END);
  return graph.compile({ checkpointer: new MemorySaver() });
}
