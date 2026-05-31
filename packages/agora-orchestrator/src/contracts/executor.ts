import type { WorkItem } from './types.js';

/** Outcome of reconciling a fired dispatch. `null` from reconcile = still running. */
export interface ExecutionResult {
  status: 'done' | 'failed';
  output?: unknown;
  /** Opaque ref to the escaped artifact (e.g. patch URI). Surfaced as result_ref. */
  resultRef?: string;
}

/** Generic, executor-agnostic context passed at fire time. NO AI/dispatch
 *  concepts (V1-D4) — just run identity + submission metadata. */
export interface FireContext {
  runId?: string;
  actor?: string;
  submittedAt?: string;
}

/**
 * Mechanism for carrying out a WorkItem (D6 fire-and-reconcile). The skeleton ships
 * NO concrete Executor; tests inline a fake. The real dispatch-executor lands in PR3.
 */
export interface Executor {
  id: string;
  /** Start the work; return a content-address handle plus an optional opaque
   *  manifest ref. Must not block to completion. */
  fire(item: WorkItem, ctx?: FireContext): Promise<{ dispatchHash: string; manifestRef?: string }>;
  /** Poll a fired dispatch; return its terminal result, or null if still running. */
  reconcile(dispatchHash: string): Promise<ExecutionResult | null>;
}
