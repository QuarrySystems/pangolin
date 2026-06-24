import type { ItemState, Run, WorkItem } from './types.js';

/** Items a pattern asks to append to a run, in submission (pre-namespace) id space. */
export interface SpawnDirective {
  items: WorkItem[]; // deterministic ids — replay-safe by construction (spec §5.1)
}

export interface PatternContext {
  /** All items of the run, de-namespaced — the pattern's ENTIRE world.
   *  Derived from the store by the orchestrator; patterns never touch the store. */
  runItems: ItemState[];
}

export interface Pattern {
  id: string; // 'static-dag' | 'pipeline' | 'map-reduce'
  /** Expand/normalize a submission BEFORE validateRun. Pure. Identity for static-dag.
   *  MAY throw a descriptive Error on malformed pattern config — submitRun surfaces it
   *  before saveRun, so the store stays clean (spec §4). */
  plan(run: Run): Run;
  /** Called AT LEAST ONCE per terminal item of an in-scope run, every tick until the run
   *  seals. MUST be pure and idempotent (deterministic spawn ids). Curated patterns never
   *  spawn from a `cancelled` cause (spec §4). */
  onTaskDone(item: ItemState, ctx: PatternContext): SpawnDirective | null;
}

/** A user-declared template for items a pattern will spawn (subset of WorkItem). */
export interface SpawnTemplate {
  executor: string;
  inputs: Record<string, unknown>;
  subagentShape?: string;
  resourceLocks?: string[];
}

/** Gate policy carried on a gate item's reserved `inputs.gate` key (spec §6c). */
export interface GateConfig {
  onRed: 'advance' | 'spawn-fix';
  subject: string; // itemId whose product is being gated
  fixTemplate?: SpawnTemplate;
  maxFixAttempts?: number; // default 1
}

/** Map-reduce config carried on the splitter's reserved `inputs.mapReduce` key (spec §6d). */
export interface MapReduceConfig {
  map: SpawnTemplate & { needsKey?: string; outputPath?: string }; // defaults 'input', 'result'
  reduce: SpawnTemplate & { keyPrefix?: string }; // default 'part'
}

/** Independent-review quorum config carried on a subject's reserved `inputs.quorum` key.
 *  N independent reviewers review the subject's product; the `commit` item is spawned only when
 *  at least `threshold` reviewers approve (status `done` with `verify.passed !== false`).
 *  Sub-threshold tallies either circle back (`spawn-fix`) or seal the rejection as final history
 *  (`block`). The per-reviewer verdicts and the tally are sealed evidence.
 *
 *  Two assurance tiers, selected by WHAT a reviewer is (the pattern is reviewer-agnostic — a
 *  reviewer is just an executor that returns a verdict):
 *    - INDEPENDENT-VALIDATION tier — reviewers are AI subagents with distinct `subagentShape`s.
 *      An automated independent check (SR 11-7-style); AI-validates-AI. The sealed tally proves
 *      N independent *models* reached consensus.
 *    - OVERSIGHT / FOUR-EYES tier — at least one reviewer slot is a HUMAN-approval executor
 *      whose `reconcile()` stays pending until a natural person submits a decision, sealing the
 *      approver's identity + timestamp. Required for human-oversight controls (EU AI Act
 *      Art. 14, segregation-of-duties / four-eyes); an AI-only quorum does NOT meet these. */
export interface QuorumConfig {
  reviewers: SpawnTemplate[]; // one independent reviewer per template
  threshold: number; // min approvals (1..reviewers.length) to advance
  commit: SpawnTemplate; // spawned when the quorum approves
  onReject?: 'spawn-fix' | 'block'; // default 'spawn-fix'
  fixTemplate?: SpawnTemplate; // required when onReject === 'spawn-fix'
  maxRounds?: number; // circle-back bound; default 1
}

/** One applied scan result: which terminal item caused which spawn (collectSpawns return). */
export interface CollectedSpawn {
  causeItemId: string; // de-namespaced id of the terminal item that triggered the spawn
  items: WorkItem[]; // pre-namespace id space (extendRun namespaces)
}
