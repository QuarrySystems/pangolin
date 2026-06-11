import type { ItemState, Run, WorkItem } from './types.js';

/** Items a pattern asks to append to a run, in submission (pre-namespace) id space. */
export interface SpawnDirective {
  items: WorkItem[];   // deterministic ids — replay-safe by construction (spec §5.1)
}

export interface PatternContext {
  /** All items of the run, de-namespaced — the pattern's ENTIRE world.
   *  Derived from the store by the orchestrator; patterns never touch the store. */
  runItems: ItemState[];
}

export interface Pattern {
  id: string;          // 'static-dag' | 'pipeline' | 'map-reduce'
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
  subject: string;              // itemId whose product is being gated
  fixTemplate?: SpawnTemplate;
  maxFixAttempts?: number;      // default 1
}

/** Map-reduce config carried on the splitter's reserved `inputs.mapReduce` key (spec §6d). */
export interface MapReduceConfig {
  map: SpawnTemplate & { needsKey?: string; outputPath?: string };   // defaults 'input', 'result'
  reduce: SpawnTemplate & { keyPrefix?: string };                    // default 'part'
}

/** One applied scan result: which terminal item caused which spawn (collectSpawns return). */
export interface CollectedSpawn {
  causeItemId: string;     // de-namespaced id of the terminal item that triggered the spawn
  items: WorkItem[];       // pre-namespace id space (extendRun namespaces)
}
