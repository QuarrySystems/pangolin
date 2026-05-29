export const RUN_STATUSES = ['pending', 'ready', 'running', 'done', 'failed', 'skipped'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** The subset of RunStatus an item can hold once it stops moving. */
export type TerminalStatus = 'done' | 'failed' | 'skipped';

export type EffectTier = 'pure' | 'read-impure' | 'write-impure';

/** A single dispatchable unit (skeleton shape — packs/effect-policy/budget deferred). */
export interface WorkItem {
  id: string;
  /** id of the registered Executor that runs this item. */
  executor: string;
  inputs: Record<string, unknown>;
  /** ids of WorkItems in the same Run that must reach `done` before this readies. */
  depends_on: string[];
  /** shared resource keys that serialize contending items. */
  resourceLocks: string[];
}

/** One plan submission: a set of WorkItems + their edges, placed on a queue. */
export interface Run {
  id: string;
  queue: string;
  items: WorkItem[];
}

/** Persisted per-item run-state row (WorkItem + mutable state). */
export interface ItemState extends WorkItem {
  runId: string;
  queue: string;
  status: RunStatus;
  dispatchHash?: string;
}

/** Terminal-ish result for one item (skeleton — intents/signals/audit deferred). */
export interface WorkItemResult {
  itemId: string;
  status: TerminalStatus;
  output?: unknown;
}
