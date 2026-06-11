import type { VerifyOutcome } from '@quarry-systems/pangolin-core';

export const RUN_STATUSES = ['pending', 'ready', 'running', 'done', 'failed', 'skipped', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** The subset of RunStatus an item can hold once it stops moving. */
export type TerminalStatus = 'done' | 'failed' | 'skipped' | 'cancelled';

export type EffectTier = 'pure' | 'read-impure' | 'write-impure';

/** Selects WHICH typed product of an upstream item a binding consumes (spec §3). */
export type OutputSelector =
  | { kind: 'patch' }                 // the upstream's resultRef (dev patchRef) — degenerate dev case
  | { kind: 'output'; path: string }; // a file the upstream wrote to outputs/ (Wave A outputRefs)

/** One typed-product handoff edge: input key -> upstream product. */
export interface InputBinding {
  from: string;            // upstream WorkItem id in the same Run
  select: OutputSelector;
}

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
  /** Optional id of a registered SubagentShape; when set, inputs are validated against its inputSchema. */
  subagentShape?: string;
  /** Typed-product handoff wiring: input key -> upstream product (spec §3).
   *  Auto-unioned into depends_on at submit-normalization. */
  needs?: Record<string, InputBinding>;
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
  /** Set when status is failed/skipped: why it failed or was cascaded. */
  reason?: string;
  /** Submitter identity (mechanism, not authz). */
  actor?: string;
  /** Retry counter; absent reads as 0. */
  attempts?: number;
  /** Epoch ms; the item is not fired before this (backoff gate). Absent === fire now. */
  nextAttemptAt?: number;
  /** Opaque escape artifact ref (e.g. patch URI). Never interpreted by the store. */
  resultRef?: string;
  /** Self-verify signal (Gap A) read from the worker's output sentinel. */
  verify?: VerifyOutcome;
  /** Content-addressed outputs/ deliverable refs (Wave A). Never interpreted by the store. */
  outputRefs?: Record<string, string>;
  /** Opaque dispatch-manifest ref. Never interpreted by the store. */
  manifestRef?: string;
  /** ISO-8601 submission time (if recorded). Never interpreted by the store. */
  submittedAt?: string;
}

/** Terminal-ish result for one item (skeleton — intents/signals/audit deferred). */
export interface WorkItemResult {
  itemId: string;
  status: TerminalStatus;
  output?: unknown;
}
