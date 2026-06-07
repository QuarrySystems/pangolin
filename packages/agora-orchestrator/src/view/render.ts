/**
 * Pure renderer for RunView.
 *
 * Returns `string[]` — a deliberate divergence from renderVerification's joined string.
 * Callers need the line count for cursor-up (ANSI reprint loop); joining is lossy for that use.
 *
 * Conventions follow src/audit/render.ts: manual ANSI map, color boolean defaulting plain,
 * narrow non-emoji glyphs.
 */
import type { RunView, RunViewNode } from './build.js';
import type { RuntimeUsage } from '@quarry-systems/agora-core';

export interface RenderRunViewOpts {
  color: boolean;
  unicode: boolean;
  width?: number;
}

// ---------------------------------------------------------------------------
// ANSI helpers (mirror audit/render.ts convention)
// ---------------------------------------------------------------------------

const ANSI = {
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  dim:    '\x1b[2m',
  reset:  '\x1b[0m',
} as const;

function paint(s: string, code: string, color: boolean): string {
  return color ? `${code}${s}${ANSI.reset}` : s;
}

// ---------------------------------------------------------------------------
// Glyph tables
// ---------------------------------------------------------------------------

/** Unicode status glyphs. */
const U_GLYPHS = {
  pending:  '·',
  running:  '⟳',
  done:     '✓',
  failed:   '✗',
  red:      '✗',   // done-but-red (verifyPassed === false)
  skipped:  '⊘',
  ghost:    '┊',
  gate:     '▣',
} as const;

/** ASCII status glyphs (unicode: false). */
const A_GLYPHS = {
  pending:  '[.]',
  running:  '[>]',
  done:     '[ok]',
  failed:   '[x]',
  red:      '[x]',
  skipped:  '[-]',
  ghost:    '[:]',
  gate:     '[gate]',
} as const;

function glyphs(unicode: boolean): typeof U_GLYPHS {
  // Both tables have the same keys — return the appropriate one.
  return (unicode ? U_GLYPHS : A_GLYPHS) as typeof U_GLYPHS;
}

// ---------------------------------------------------------------------------
// Status glyph + ANSI color for a node
// ---------------------------------------------------------------------------

function statusGlyph(node: RunViewNode, opts: RenderRunViewOpts): string {
  const g = glyphs(opts.unicode);
  const { color } = opts;

  if (node.kind === 'ghost') {
    return paint(g.ghost, ANSI.dim, color);
  }

  if (node.status === undefined) {
    // Pre-run real node — show pending/ready glyph
    return g.pending;
  }

  switch (node.status) {
    case 'running':  return paint(g.running, ANSI.yellow, color);
    case 'done':
      if (node.verifyPassed === false) {
        return paint(g.red, ANSI.red, color);
      }
      return paint(g.done, ANSI.green, color);
    case 'failed':   return paint(g.failed, ANSI.red, color);
    case 'skipped':  return paint(g.skipped, ANSI.dim, color);
    case 'cancelled': return paint(g.skipped, ANSI.dim, color);
    default:         return g.pending;
  }
}

// ---------------------------------------------------------------------------
// Evidence suffix
// ---------------------------------------------------------------------------

function evidenceSuffix(usage: RuntimeUsage | undefined): string {
  if (!usage) return '';
  const parts: string[] = [];
  if (usage.models && usage.models.length > 0) parts.push(usage.models.join(','));
  if (usage.costUsd !== undefined) parts.push(`$${usage.costUsd}`);
  if (usage.turns !== undefined) parts.push(`${usage.turns}t`);
  if (parts.length === 0) return '';
  return ` — ${parts.join(' · ')}`;
}

// ---------------------------------------------------------------------------
// Gate marker prefix
// ---------------------------------------------------------------------------

function gatePrefix(node: RunViewNode, unicode: boolean): string {
  if (!node.isGate) return '';
  return unicode ? `${U_GLYPHS.gate} ` : `${A_GLYPHS.gate} `;
}

// ---------------------------------------------------------------------------
// Shared helper: collect transitive arc ids from a seed set via depends_on edges
// ---------------------------------------------------------------------------

/**
 * Given a seed set of known arc node ids, expand it transitively by following
 * depends_on edges among `candidates`. Returns the expanded array (seed order
 * first, then discovered in iteration order).
 */
function collectArcIds(
  seedIds: string[],
  candidates: RunViewNode[],
): string[] {
  const arcIdSet = new Set(seedIds);
  const arcIds = [...seedIds];
  let changed = true;
  while (changed) {
    changed = false;
    for (const g of candidates) {
      if (arcIdSet.has(g.id)) continue;
      if (g.depends_on.some((dep) => arcIdSet.has(dep))) {
        arcIdSet.add(g.id);
        arcIds.push(g.id);
        changed = true;
      }
    }
  }
  return arcIds;
}

// ---------------------------------------------------------------------------
// Chain layout renderer
// ---------------------------------------------------------------------------

/**
 * Groups ghost nodes by their gate association (which real gate spawned them).
 * For chain layout: ghost arcs are rendered indented below the gate that spawns them.
 *
 * Ghost ids follow the pattern: `<base>-fix-<attempt>` and `<base>~<attempt+1>`
 * for a gate with id `<base>` at generation 0 (attempt=1).
 *
 * To identify which gate a ghost belongs to:
 * - A fix node `<base>-fix-N` belongs to the gate whose base is `<base>`.
 * - A gate copy `<base>~N` belongs to the original gate with id `<base>`.
 * - A marked copy `<orig>~N` belongs to the gate that spawned generation N.
 *
 * We use the depends_on edges to group: for the chain layout, all ghost nodes are
 * transitively reachable from the gate via depends_on edges.
 */
function buildGhostGroupsByGate(nodes: RunViewNode[]): Map<string, string[]> {
  const gateNodes = nodes.filter((n) => n.isGate && n.kind === 'real');
  const ghostNodes = nodes.filter((n) => n.kind === 'ghost');

  if (ghostNodes.length === 0 || gateNodes.length === 0) return new Map();

  // For each gate, find the ghost arc that belongs to it.
  // The ghost arc for gate `b` (attempt 1, base 'b') is:
  //   b-fix-1, b~2, and copies of b's skipped descendants (c~2, etc.)
  // We identify arcs by: fix node id matches `<gateBase>-fix-<attempt>`
  // where gateBase comes from parseAttempt(gate.id).base.

  const result = new Map<string, string[]>();

  for (const gate of gateNodes) {
    // Parse the gate's base and attempt
    const gateBase = parseAttemptSimple(gate.id).base;
    const gateAttempt = parseAttemptSimple(gate.id).attempt;
    const next = gateAttempt + 1;
    const fixId = `${gateBase}-fix-${gateAttempt}`;
    const gateCopyId = `${gateBase}~${next}`;

    // Find ghost nodes that belong to this gate's arc
    const seedIds: string[] = [];
    // fix node
    const fixNode = ghostNodes.find((n) => n.id === fixId);
    if (fixNode) seedIds.push(fixId);
    // gate copy
    const gateCopyNode = ghostNodes.find((n) => n.id === gateCopyId);
    if (gateCopyNode) seedIds.push(gateCopyId);
    // marked copies: ghost nodes whose depends_on chains back through gateCopyId or fixId
    // (transitively via collectArcIds)
    const arcIds = collectArcIds(seedIds, ghostNodes);

    if (arcIds.length > 0) {
      result.set(gate.id, arcIds);
    }
  }

  return result;
}

/** Minimal parseAttempt — mirrors respawn.ts but avoids re-importing. */
function parseAttemptSimple(id: string): { base: string; attempt: number } {
  const m = /^(.*)~(\d+)$/.exec(id);
  return m ? { base: m[1]!, attempt: Number(m[2]) } : { base: id, attempt: 1 };
}

function renderChain(view: RunView, opts: RenderRunViewOpts): string[] {
  const lines: string[] = [];

  // Ghost nodes map by gate
  const ghostsByGate = buildGhostGroupsByGate(view.nodes);

  // Also find real-but-generation>0 nodes (materialized respawn nodes)
  // These are real nodes that are NOT in the original plan order (generation > 0 or fix nodes)
  // We render them inline in their logical position.

  // Build node index
  const nodeById = new Map(view.nodes.map((n) => [n.id, n]));

  // Determine which real nodes are "primary" (original plan, gen 0 non-fix)
  // vs "arc" (part of a respawn arc that has materialized)
  // Fix nodes: id matches `<base>-fix-<N>`
  const isFix = (id: string): boolean => /-fix-\d+$/.test(id);
  const isGenerationCopy = (id: string): boolean => /~\d+$/.test(id);
  const isArcNode = (id: string): boolean => isFix(id) || isGenerationCopy(id);

  // Primary real nodes (in plan order)
  const primaryNodes = view.nodes.filter((n) => n.kind === 'real' && !isArcNode(n.id));

  // Real arc nodes (materialized ghosts)
  const realArcNodes = view.nodes.filter((n) => n.kind === 'real' && isArcNode(n.id));

  // Group real arc nodes by which gate they belong to
  const realArcByGate = new Map<string, RunViewNode[]>();
  for (const gateId of ghostsByGate.keys()) {
    const gateBase = parseAttemptSimple(gateId).base;
    const gateAttempt = parseAttemptSimple(gateId).attempt;
    const next = gateAttempt + 1;
    const fixId = `${gateBase}-fix-${gateAttempt}`;

    // fix node
    const realSeedIds: string[] = [];
    const fixNode = realArcNodes.find((n) => n.id === fixId);
    if (fixNode) realSeedIds.push(fixId);
    // gate copy
    const gateCopyId = `${gateBase}~${next}`;
    const gateCopyNode = realArcNodes.find((n) => n.id === gateCopyId);
    if (gateCopyNode) realSeedIds.push(gateCopyId);
    // marked copies (transitively via collectArcIds)
    const realArcIdList = collectArcIds(realSeedIds, realArcNodes);
    const arcNodeIds = new Set<string>(realArcIdList);

    if (arcNodeIds.size > 0) {
      realArcByGate.set(gateId, realArcNodes.filter((n) => arcNodeIds.has(n.id)));
    }
  }

  // Also handle gates with real arc nodes but NO ghost entries
  // (i.e. the gate resolved and ghosts were dropped, arcs are materialized)
  // We need to detect those gates too.
  for (const n of realArcNodes) {
    // Find if this arc node is already grouped
    let grouped = false;
    for (const [, nodes] of realArcByGate) {
      if (nodes.some((x) => x.id === n.id)) { grouped = true; break; }
    }
    if (grouped) continue;

    // Try to find the parent gate
    // Fix node: <base>-fix-N -> gate is <base> (attempt 1) or look for the gate
    if (isFix(n.id)) {
      const fixMatch = /^(.*)-fix-(\d+)$/.exec(n.id);
      if (fixMatch) {
        const base = fixMatch[1]!;
        // The gate could be <base> (gen 0) or <base>~N (gen N)
        const possibleGate = nodeById.get(base);
        if (possibleGate && possibleGate.isGate) {
          if (!realArcByGate.has(base)) realArcByGate.set(base, []);
          realArcByGate.get(base)!.push(n);
          // Also group related arcs
          const gateCopyId = `${base}~${parseInt(fixMatch[2]!) + 1}`;
          const gateCopy = nodeById.get(gateCopyId);
          if (gateCopy) realArcByGate.get(base)!.push(gateCopy);
        }
      }
    }
  }

  // Track which arc nodes have been rendered
  const renderedArcIds = new Set<string>();

  // Render primary nodes + inline their ghost/real arcs after the gate
  for (const node of primaryNodes) {
    const glyph = statusGlyph(node, opts);
    const gp = gatePrefix(node, opts.unicode);
    const evSuffix = evidenceSuffix(node.usage);
    lines.push(`${gp}${glyph} ${node.id}${evSuffix}`);

    if (!node.isGate) continue;

    // After a gate, render the arc (ghost or real) indented
    const indent = '  ';

    // Get ghost arc for this gate
    const ghostArcIds = ghostsByGate.get(node.id) ?? [];
    // Get real arc nodes for this gate
    const realArcForGate = realArcByGate.get(node.id) ?? [];
    const realArcForGateIds = new Set(realArcForGate.map((n) => n.id));

    // Render the arc in the correct order: fix, gate copy, marked copies
    // Order them by respawn lineage: fix first, then gate copy, then others
    const gateBase = parseAttemptSimple(node.id).base;
    const gateAttempt = parseAttemptSimple(node.id).attempt;
    const next = gateAttempt + 1;
    const fixId = `${gateBase}-fix-${gateAttempt}`;
    const gateCopyId = `${gateBase}~${next}`;

    // Build an ordered list of arc node ids to render
    const orderedArcIds: string[] = [];
    // fix
    if (ghostArcIds.includes(fixId) || realArcForGateIds.has(fixId)) orderedArcIds.push(fixId);
    // gate copy
    if (ghostArcIds.includes(gateCopyId) || realArcForGateIds.has(gateCopyId)) orderedArcIds.push(gateCopyId);
    // remaining in ghost arc order (marked copies)
    for (const id of ghostArcIds) {
      if (id !== fixId && id !== gateCopyId && !orderedArcIds.includes(id)) orderedArcIds.push(id);
    }
    // remaining real arc not yet included
    for (const n of realArcForGate) {
      if (!orderedArcIds.includes(n.id)) orderedArcIds.push(n.id);
    }

    for (const arcId of orderedArcIds) {
      const arcNode = nodeById.get(arcId);
      if (!arcNode) continue;
      const arcGlyph = statusGlyph(arcNode, opts);
      const arcGp = gatePrefix(arcNode, opts.unicode);
      const arcEv = evidenceSuffix(arcNode.usage);
      lines.push(`${indent}${arcGp}${arcGlyph} ${arcNode.id}${arcEv}`);
      renderedArcIds.add(arcId);
    }
  }

  // Render any real arc nodes not yet rendered (e.g. orphaned materialized nodes)
  for (const n of realArcNodes) {
    if (!renderedArcIds.has(n.id)) {
      const glyph = statusGlyph(n, opts);
      const evSuffix = evidenceSuffix(n.usage);
      lines.push(`${glyph} ${n.id}${evSuffix}`);
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Fan layout renderer (map-reduce)
// ---------------------------------------------------------------------------

function renderFan(view: RunView, opts: RenderRunViewOpts): string[] {
  const lines: string[] = [];
  const { width = 80 } = opts;

  // Identify splitter, map items, and reducer
  // In map-reduce: splitter is the node with mapReduce config (id != 'reduce' and depends_on = [])
  // Map items are spawned nodes (not plan nodes) with depends_on = ['split']
  // Reducer is the 'reduce' node

  // Find the splitter (plan node that's not a reducer)
  // 'reduce' is the mapReduce pattern's fixed reducer id — coupling is intentional and
  // matches the contract in src/patterns/map-reduce.ts (reducer WorkItem id = 'reduce').
  const planNodes = view.nodes.filter((n) => n.kind === 'real' && n.id !== 'reduce');
  const reducerNode = view.nodes.find((n) => n.id === 'reduce');

  // Spawned map items: real nodes whose depends_on includes the splitter id
  const splitterNode = planNodes.find((n) => !isArcId(n.id));
  const mapNodes = view.nodes.filter((n) =>
    n.kind === 'real' &&
    n.id !== 'reduce' &&
    n.id !== splitterNode?.id &&
    !isArcId(n.id) &&
    n.depends_on.some((d) => d === splitterNode?.id),
  );

  // Render splitter
  if (splitterNode) {
    const glyph = statusGlyph(splitterNode, opts);
    const evSuffix = evidenceSuffix(splitterNode.usage);
    lines.push(`${glyph} ${splitterNode.id}${evSuffix}`);
  }

  const indent = '  ';

  // Render map items (or placeholder)
  if (mapNodes.length === 0) {
    // Pre-run: show × ? placeholder
    lines.push(`${indent}× ?`);
  } else {
    // Determine if we should collapse
    const mapLines = mapNodes.map((n) => {
      const glyph = statusGlyph(n, opts);
      const evSuffix = evidenceSuffix(n.usage);
      return `${indent}${glyph} ${n.id}${evSuffix}`;
    });

    // Width budget: collapse if many items would exceed width.
    // AVG_MAP_LINE_CHARS: estimated per-item rendered width (glyph + space + avg-id + indent).
    const AVG_MAP_LINE_CHARS = 10;
    const wouldExceedBudget = mapLines.length > 1 && (mapLines.length * AVG_MAP_LINE_CHARS) > width;

    if (wouldExceedBudget) {
      lines.push(`${indent}× ${mapNodes.length}`);
    } else {
      lines.push(...mapLines);
    }
  }

  // Render reducer
  if (reducerNode) {
    const glyph = statusGlyph(reducerNode, opts);
    const evSuffix = evidenceSuffix(reducerNode.usage);
    lines.push(`${glyph} ${reducerNode.id}${evSuffix}`);
  }

  return lines;
}

function isArcId(id: string): boolean {
  return /-fix-\d+$/.test(id) || /~\d+$/.test(id);
}

// ---------------------------------------------------------------------------
// Tree layout renderer (generic DAG / static-dag)
// ---------------------------------------------------------------------------

function renderTree(view: RunView, opts: RenderRunViewOpts): string[] {
  const lines: string[] = [];

  // Build parent → children map
  const nodeById = new Map(view.nodes.map((n) => [n.id, n]));
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();

  for (const node of view.nodes) {
    for (const dep of node.depends_on) {
      if (!children.has(dep)) children.set(dep, []);
      children.get(dep)!.push(node.id);
      hasParent.add(node.id);
    }
  }

  // Root nodes (no parents in the graph)
  const roots = view.nodes.filter((n) => !hasParent.has(n.id));

  const rendered = new Set<string>();
  // visiting tracks nodes currently on the DFS stack; re-entry means a true cycle
  const visiting = new Set<string>();

  function renderNode(nodeId: string, indent: string): void {
    const node = nodeById.get(nodeId);
    if (!node) return;

    if (visiting.has(nodeId)) {
      // True cycle detected (A→B→A): emit a readable line instead of overflowing the stack
      lines.push(`${indent}↩ cycle ${nodeId}`);
      return;
    }

    if (rendered.has(nodeId)) {
      // Diamond re-reference: show ↩ see <id>
      lines.push(`${indent}↩ see ${nodeId}`);
      return;
    }

    visiting.add(nodeId);
    rendered.add(nodeId);

    const glyph = statusGlyph(node, opts);
    const gp = gatePrefix(node, opts.unicode);
    const evSuffix = evidenceSuffix(node.usage);
    lines.push(`${indent}${gp}${glyph} ${nodeId}${evSuffix}`);

    const kids = children.get(nodeId) ?? [];
    for (const childId of kids) {
      renderNode(childId, indent + '  ');
    }
    visiting.delete(nodeId);
  }

  for (const root of roots) {
    renderNode(root.id, '');
  }

  // Render any real nodes not yet reached (e.g. nodes in a pure cycle with no DAG root).
  // renderNode's visiting guard will emit "↩ cycle <id>" on re-entry, producing a
  // readable output instead of a RangeError stack overflow.
  for (const node of view.nodes) {
    if (node.kind === 'real' && !rendered.has(node.id)) {
      renderNode(node.id, '');
    }
  }

  // Include any ghost nodes that aren't in the tree
  for (const node of view.nodes) {
    if (node.kind === 'ghost' && !rendered.has(node.id)) {
      const glyph = statusGlyph(node, opts);
      const evSuffix = evidenceSuffix(node.usage);
      lines.push(`${glyph} ${node.id}${evSuffix}`);
      rendered.add(node.id);
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function renderFooter(view: RunView): string {
  const { counts, costUsd, state } = view.footer;
  const parts: string[] = [`state: ${state}`];

  const statusParts = Object.entries(counts)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
  if (statusParts) parts.push(statusParts);

  if (costUsd > 0) parts.push(`$${costUsd}`);

  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Render a RunView to an array of lines.
 *
 * Returns `string[]` — deliberately NOT a joined string. Callers (the frame loop) need
 * the line count for cursor-up to repaint the terminal in-place.
 */
export function renderRunView(view: RunView, opts: RenderRunViewOpts): string[] {
  let bodyLines: string[];

  switch (view.layout) {
    case 'chain': bodyLines = renderChain(view, opts); break;
    case 'fan':   bodyLines = renderFan(view, opts);   break;
    case 'tree':  bodyLines = renderTree(view, opts);  break;
    default:      bodyLines = renderTree(view, opts);  break;
  }

  const footerLine = renderFooter(view);

  return [...bodyLines, '', footerLine];
}
