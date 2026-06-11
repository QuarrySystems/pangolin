import type { Run, Pattern, WorkItem } from '../contracts/index.js';
import { normalizeRun } from '../engine/run-validator.js';
import { parseAttempt } from '../patterns/respawn.js';
import type { RuntimeUsage } from '@quarry-systems/pangolin-core';

export type RunViewLayout = 'chain' | 'fan' | 'tree';
export type NodeKind = 'real' | 'ghost';

export interface RunViewNode {
  id: string;
  kind: NodeKind;
  status?: string;               // absent pre-run / for ghosts
  verifyPassed?: boolean;        // from StatusItem.verify.passed
  usage?: RuntimeUsage;
  generation: number;            // 0 = submitted; N = ~(N+1) wave
  isGate: boolean;
  depends_on: string[];          // resolved edges for layout
}

export interface RunView {
  runId: string;
  layout: RunViewLayout;
  nodes: RunViewNode[];          // stable order: plan order, then generations
  footer: { counts: Record<string, number>; costUsd: number; state: 'pre-run' | 'running' | 'terminal' };
}

/** Deliberate STRUCTURAL SUBSET of the orchestrator's StatusItem (decouples the
 *  pure view module from the status surface; drivers pass their own shapes). */
export interface StatusLike { id: string; status: string; depends_on?: string[]; manifestRef?: string; verify?: { passed: boolean } }

const TERMINAL = new Set(['done', 'failed', 'skipped', 'cancelled']);

/** A gate item declares respawn semantics via the reserved `inputs.gate` key (spec §6c). */
function gateConfigOf(item: WorkItem): { onRed?: unknown; subject?: unknown } | undefined {
  const g = (item.inputs as { gate?: unknown } | undefined)?.gate;
  if (g === null || typeof g !== 'object') return undefined;
  return g as { onRed?: unknown; subject?: unknown };
}

function isSpawnFixGate(item: WorkItem): boolean {
  return gateConfigOf(item)?.onRed === 'spawn-fix';
}

/** Data-edge exemption (mirrors dep-resolver.ts isBlockedBy): a consumer binding the
 *  gate's own outputs (`needs[*] = {from: gateId, select.kind === 'output'}`) RUNS
 *  rather than skips when the gate goes red — so it gets no ghost copy. */
function isExempt(consumer: WorkItem, gateId: string): boolean {
  return Object.values(consumer.needs ?? {}).some(
    (b) => b.from === gateId && b.select.kind === 'output',
  );
}

/** BFS-to-fixpoint over the would-be-skipped lineage (mirrors the dep-resolver skip
 *  semantics): seed only NON-exempt direct consumers of the gate; thereafter every
 *  dependent of a marked item is marked (multi-parent: marked if ANY parent marked).
 *  Exempt consumers and their EXCLUSIVE descendants are never marked from the gate edge. */
function computeMarked(items: WorkItem[], gate: WorkItem): Set<string> {
  const marked = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const it of items) {
      if (it.id === gate.id || marked.has(it.id)) continue;
      const hit = it.depends_on.some(
        (d) => marked.has(d) || (d === gate.id && !isExempt(it, gate.id)),
      );
      if (hit) {
        marked.add(it.id);
        changed = true;
      }
    }
  }
  return marked;
}

/** Real-node decoration shared by plan nodes, reconciled ghosts, and spawned items. */
function statusFields(s: StatusLike, evidence?: Map<string, RuntimeUsage>): Pick<RunViewNode, 'status' | 'verifyPassed' | 'usage'> {
  const usage = evidence?.get(s.id);
  return {
    status: s.status,
    ...(s.verify !== undefined ? { verifyPassed: s.verify.passed } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
}

/** Pure view-model core of the pattern-aware run view (design spec §2.2-§2.3).
 *  Applies `pattern.plan()` THEN `normalizeRun` (mirroring submitRun); a throwing
 *  plan() propagates to the caller. Layout keys on Pattern.id; ghost lineages are
 *  synthesized per spawn-fix gate mirroring respawnLineage's id + substitution
 *  conventions (one generation only — maxFixAttempts: 1 semantics). */
export function buildRunView(args: {
  plan: Run;
  pattern?: Pattern;
  status?: StatusLike[];
  evidence?: Map<string, RuntimeUsage>;
}): RunView {
  const { plan, pattern, status, evidence } = args;

  // plan() THEN normalizeRun — same order as submitRun (orchestrator.ts).
  const planned = pattern ? pattern.plan(plan) : plan;
  const normalized = normalizeRun(planned);

  const layout: RunViewLayout =
    pattern?.id === 'pipeline' ? 'chain' : pattern?.id === 'map-reduce' ? 'fan' : 'tree';

  const statusById = new Map((status ?? []).map((s) => [s.id, s]));
  const itemById = new Map(normalized.items.map((i) => [i.id, i]));

  // ---- real nodes from the plan (plan order) ----
  const nodes: RunViewNode[] = normalized.items.map((it) => {
    const s = statusById.get(it.id);
    return {
      id: it.id,
      kind: 'real',
      ...(s ? statusFields(s, evidence) : {}),
      generation: parseAttempt(it.id).attempt - 1,
      isGate: isSpawnFixGate(it),
      depends_on: it.depends_on,
    };
  });

  // ---- ghost lineages per declared spawn-fix gate ----
  for (const gate of normalized.items) {
    const cfg = gateConfigOf(gate);
    if (cfg?.onRed !== 'spawn-fix' || typeof cfg.subject !== 'string') continue;

    const { base, attempt } = parseAttempt(gate.id);
    const next = attempt + 1;
    const fixId = `${base}-fix-${attempt}`;
    const gateCopyId = `${base}~${next}`;

    // Substitution map S (mirrors respawnLineage): lineage-internal edges remap to the
    // ~next/fix ids; non-lineage upstreams keep ORIGINAL ids — with the one pinned
    // exception that the SUBJECT remaps to the fix id (respawn.ts S.set(subject, fixId)).
    const marked = computeMarked(normalized.items, gate);
    const S = new Map<string, string>();
    S.set(gate.id, gateCopyId);
    for (const id of marked) S.set(id, `${parseAttempt(id).base}~${next}`);
    S.set(cfg.subject, fixId);
    const sub = (id: string): string => S.get(id) ?? id;

    // Lineage in respawnLineage order: fix, gate copy, marked copies (plan order).
    const lineage: { id: string; isGate: boolean; deps: string[] }[] = [
      { id: fixId, isGate: false, deps: [cfg.subject] },
      { id: gateCopyId, isGate: true, deps: gate.depends_on.map(sub) },
      ...normalized.items
        .filter((it) => marked.has(it.id))
        .map((it) => ({ id: S.get(it.id)!, isGate: isSpawnFixGate(it), deps: it.depends_on.map(sub) })),
    ];

    // Reconciliation: real counterpart in status -> real node; gate resolved green
    // (done + verify.passed !== false) -> remaining ghosts dropped; otherwise ghosts stay.
    const gs = statusById.get(gate.id);
    const greenResolved = gs?.status === 'done' && gs.verify?.passed !== false;

    for (const g of lineage) {
      const s = statusById.get(g.id);
      if (s) {
        nodes.push({
          id: g.id,
          kind: 'real',
          ...statusFields(s, evidence),
          generation: parseAttempt(g.id).attempt - 1,
          isGate: g.isGate,
          depends_on: s.depends_on ?? g.deps,
        });
      } else if (!greenResolved) {
        nodes.push({
          id: g.id,
          kind: 'ghost',
          generation: parseAttempt(g.id).attempt - 1,
          isGate: g.isGate,
          depends_on: g.deps,
        });
      }
      // greenResolved && !s -> ghost dropped
    }
  }

  // ---- spawned items present in status but absent from plan + ghost lineages ----
  const knownIds = new Set(nodes.map((n) => n.id));
  for (const s of status ?? []) {
    if (knownIds.has(s.id) || itemById.has(s.id)) continue;
    nodes.push({
      id: s.id,
      kind: 'real',
      ...statusFields(s, evidence),
      generation: parseAttempt(s.id).attempt - 1,
      isGate: false,
      depends_on: s.depends_on ?? [],
    });
  }

  // ---- footer ----
  const counts: Record<string, number> = {};
  for (const s of status ?? []) counts[s.status] = (counts[s.status] ?? 0) + 1;
  let costUsd = 0;
  for (const n of nodes) costUsd += n.usage?.costUsd ?? 0;
  // Empty status counts as pre-run (quality-review hardening): a polling caller can
  // legitimately see [] before the first status publishes; vacuous `every` would
  // otherwise misreport 'terminal'.
  const state: RunView['footer']['state'] =
    status === undefined || status.length === 0
      ? 'pre-run'
      : status.every((s) => TERMINAL.has(s.status))
        ? 'terminal'
        : 'running';

  return { runId: normalized.id, layout, nodes, footer: { counts, costUsd, state } };
}
