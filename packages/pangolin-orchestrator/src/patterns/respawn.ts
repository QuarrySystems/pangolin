import type { ItemState, WorkItem, InputBinding } from '../contracts/types.js';
import type { GateConfig } from '../contracts/pattern.js';

/** 'review' -> {base:'review', attempt:1}; 'review~2' -> {base:'review', attempt:2}. */
export function parseAttempt(id: string): { base: string; attempt: number } {
  const m = /^(.*)~(\d+)$/.exec(id);
  return m ? { base: m[1]!, attempt: Number(m[2]) } : { base: id, attempt: 1 };
}

/**
 * Build the substitution map S and collect lineage members.
 *
 * Lineage = the gate + items transitively reachable FROM the gate via depends_on
 * (items that depend on it, directly or transitively) whose status is 'skipped'.
 *
 * S maps:
 *   gate.id  -> gateCopyId
 *   each skipped descendant d -> `${parseAttempt(d).base}~${next}`
 * (the caller adds subject -> fixId after this returns — the subject is never in the lineage)
 */
function buildLineage(args: {
  gate: ItemState;
  runItems: ItemState[];
  gateCopyId: string;
  next: number;
}): {
  S: Map<string, string>;
  skippedDescendants: ItemState[];
  hasCancelled: boolean;
} {
  const { gate, runItems, gateCopyId, next } = args;

  // Build lookup by id
  const byId = new Map<string, ItemState>();
  for (const it of runItems) byId.set(it.id, it);

  // BFS/DFS: find all items that depend on the gate (directly or transitively), skipped
  // We look for items whose depends_on includes any member of the lineage set
  const lineageIds = new Set<string>([gate.id]);
  let hasCancelled = gate.status === 'cancelled';

  // Iteratively expand: any item that depends_on a lineage member AND is skipped or cancelled
  // Multiple passes until stable
  let changed = true;
  while (changed) {
    changed = false;
    for (const it of runItems) {
      if (lineageIds.has(it.id)) continue;
      // Check if it depends on any lineage member
      const dependsOnLineage = it.depends_on.some((dep) => lineageIds.has(dep));
      if (!dependsOnLineage) continue;
      // Only include skipped/cancelled items (they were cascaded from the failed gate)
      if (it.status === 'skipped' || it.status === 'cancelled') {
        lineageIds.add(it.id);
        if (it.status === 'cancelled') hasCancelled = true;
        changed = true;
      }
    }
  }

  // Collect skipped descendants (exclude the gate itself)
  const skippedDescendants: ItemState[] = [];
  for (const id of lineageIds) {
    if (id === gate.id) continue;
    const it = byId.get(id);
    if (it && it.status === 'skipped') skippedDescendants.push(it);
  }

  // Build S
  // We need subject -> fixId, gate -> gateCopyId, each skipped d -> `${base}~${next}`
  // NOTE: subject is not in lineage — it's the upstream item that produced the work
  // We don't know the subject's S entry here — it's added in respawnLineage
  const S = new Map<string, string>();
  S.set(gate.id, gateCopyId);
  for (const d of skippedDescendants) {
    const { base } = parseAttempt(d.id);
    S.set(d.id, `${base}~${next}`);
  }

  return { S, skippedDescendants, hasCancelled };
}

/**
 * Apply substitution map S to an id: return S[id] if present, else id unchanged.
 */
function applyS(S: Map<string, string>, id: string): string {
  return S.get(id) ?? id;
}

/**
 * Remap depends_on and needs[*].from through S (identity for keys not in S).
 */
function remapEdges(
  depends_on: string[],
  needs: Record<string, InputBinding> | undefined,
  S: Map<string, string>,
): { depends_on: string[]; needs?: Record<string, InputBinding> } {
  const newDeps = depends_on.map((d) => applyS(S, d));
  if (!needs) return { depends_on: newDeps };
  const newNeeds: Record<string, InputBinding> = {};
  for (const [key, binding] of Object.entries(needs)) {
    newNeeds[key] = { ...binding, from: applyS(S, binding.from) };
  }
  return { depends_on: newDeps, needs: newNeeds };
}

/**
 * Extract only the WorkItem static fields from an ItemState (no runtime fields like status,
 * attempts, runId, queue, reason, dispatchHash, verify, outputRefs, manifestRef, submittedAt, etc.)
 */
function toWorkItemFields(item: ItemState): Omit<WorkItem, 'id' | 'depends_on' | 'needs'> {
  return {
    executor: item.executor,
    inputs: item.inputs,
    ...(item.subagentShape !== undefined ? { subagentShape: item.subagentShape } : {}),
    resourceLocks: item.resourceLocks,
  };
}

/** PURE. Builds [fix, gateCopy, ...skippedCopies] or [] when respawn must not happen:
 *  - cause attempt > maxFixAttempts (default 1)
 *  - any lineage member (gate or skipped descendant) is `cancelled`
 *  - no fixTemplate configured
 *  Lineage = the gate + items transitively reachable FROM the gate via depends_on
 *  (i.e. items that depend on it, directly or transitively) whose status is 'skipped'.
 *  S = { subject -> fixId, gate.id -> gateCopyId, each skipped d -> `${d}~${next}` }.
 *  Edge remap applies S to every copy's depends_on AND needs[*].from (identity otherwise).
 *  Fix item: id `${base}-fix-${attempt}` (base/attempt from parseAttempt(gate.id));
 *  needs.work = subject's patch product ({ from: config.subject, select: { kind: 'patch' } });
 *  when the gate is done-but-red AND gate.outputRefs?.['findings'] exists, needs.findings
 *  binds it ({ from: gate-id, select: { kind: 'output', path: 'findings' } });
 *  when the gate FAILED, `gateReason: gate.reason` is merged into the fix's inputs as plain
 *  data (a failed gate has no outputRefs — provenance closure only admits done producers).
 *  Copies carry the original WorkItem fields (executor, inputs, subagentShape, resourceLocks)
 *  with remapped depends_on/needs — never ItemState runtime fields (status, attempts, ...).
 *  Gate copy id = `${base}~${attempt + 1}`; skipped copy ids = `${parseAttempt(d).base}~${attempt + 1}`. */
export function respawnLineage(args: {
  gate: ItemState;
  config: GateConfig;
  runItems: ItemState[];
}): WorkItem[] {
  const { gate, config, runItems } = args;

  // Guard: no fixTemplate
  if (!config.fixTemplate) return [];

  // Guard: gate must be in a respawn-eligible state.
  // Eligible states: 'failed' OR done-but-red (done + verify.passed === false).
  // A done gate that passed (verify absent or verify.passed !== false) must not respawn.
  const isDoneButRed = gate.status === 'done' && gate.verify?.passed === false;
  if (gate.status !== 'failed' && !isDoneButRed) return [];

  // Guard: attempt bound
  const { base, attempt } = parseAttempt(gate.id);
  const maxFixAttempts = config.maxFixAttempts ?? 1;
  if (attempt > maxFixAttempts) return [];

  // Derive ids
  const next = attempt + 1;
  const fixId = `${base}-fix-${attempt}`;
  const gateCopyId = `${base}~${next}`;

  // Build lineage and substitution map
  const { S, skippedDescendants, hasCancelled } = buildLineage({
    gate,
    runItems,
    gateCopyId,
    next,
  });

  // Guard: cancelled in lineage
  if (hasCancelled) return [];

  // Add subject -> fixId to S (subject is not in the lineage but its edges should map to fix)
  S.set(config.subject, fixId);

  // Build fix item
  const fixNeeds: Record<string, InputBinding> = {
    work: { from: config.subject, select: { kind: 'patch' } },
  };

  const fixInputs: Record<string, unknown> = { ...config.fixTemplate.inputs };

  if (isDoneButRed && gate.outputRefs?.['findings']) {
    fixNeeds['findings'] = { from: gate.id, select: { kind: 'output', path: 'findings' } };
  } else if (gate.status === 'failed' && gate.reason !== undefined) {
    fixInputs['gateReason'] = gate.reason;
  }

  const fixItem: WorkItem = {
    id: fixId,
    executor: config.fixTemplate.executor,
    inputs: fixInputs,
    depends_on: [config.subject],
    resourceLocks: config.fixTemplate.resourceLocks ?? [],
    ...(config.fixTemplate.subagentShape !== undefined
      ? { subagentShape: config.fixTemplate.subagentShape }
      : {}),
    needs: fixNeeds,
  };

  // Build gate copy
  const gateEdges = remapEdges(gate.depends_on, gate.needs, S);
  const gateCopy: WorkItem = {
    id: gateCopyId,
    ...toWorkItemFields(gate),
    ...gateEdges,
  };

  // Build skipped descendant copies
  const skippedCopies: WorkItem[] = skippedDescendants.map((d) => {
    const copyId = S.get(d.id)!;
    const edges = remapEdges(d.depends_on, d.needs, S);
    return {
      id: copyId,
      ...toWorkItemFields(d),
      ...edges,
    };
  });

  return [fixItem, gateCopy, ...skippedCopies];
}
