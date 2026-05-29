import type { WorkItem } from './types.js';

/** Outcome of reconciling a fired dispatch. `null` from reconcile = still running. */
export interface ExecutionResult {
  status: 'done' | 'failed';
  output?: unknown;
}

/**
 * Mechanism for carrying out a WorkItem (D6 fire-and-reconcile). The skeleton ships
 * NO concrete Executor; tests inline a fake. The real dispatch-executor lands in PR3.
 */
export interface Executor {
  id: string;
  /** Start the work; return a content-address handle. Must not block to completion. */
  fire(item: WorkItem): Promise<{ dispatchHash: string }>;
  /** Poll a fired dispatch; return its terminal result, or null if still running. */
  reconcile(dispatchHash: string): Promise<ExecutionResult | null>;
}
