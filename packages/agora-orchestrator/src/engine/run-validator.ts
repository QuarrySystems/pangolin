import type { Run, WorkItem } from '../contracts/types.js';
import type { PackRegistry } from '../packs/registry.js';

/** Auto-union needs[*].from into depends_on (dedup; spec §3). Pure — returns a new Run. */
export function normalizeRun(run: Run): Run {
  return {
    ...run,
    items: run.items.map((it) => {
      const froms = Object.values(it.needs ?? {}).map((b) => b.from);
      return froms.length
        ? { ...it, depends_on: [...new Set([...it.depends_on, ...froms])] }
        : it;
    }),
  };
}

/** Whole-DAG, fail-fast validation (spec §6). Empty array = valid.
 *  Structural always: duplicate item ids; depends_on/needs.from reference existing items;
 *  needs ⊆ depends_on; no depends_on cycles (DFS).
 *  With packs: subagentShape ids resolve; edge-type tags match when BOTH ends declare them
 *  (upstream.outputEdgeType vs downstream.inputEdgeTypes[key]) — mismatch error names the edge:
 *  "edge a->b (patch): patch-ref->dataset-ref incompatible; needs an adapter block". */
export function validateRun(run: Run, packs?: PackRegistry): string[] {
  const errors: string[] = [];
  const idSet = new Set<string>();

  // ---- 1. Duplicate item ids ----
  for (const item of run.items) {
    if (idSet.has(item.id)) {
      errors.push(`duplicate item id "${item.id}"`);
    } else {
      idSet.add(item.id);
    }
  }

  // Build a lookup map (use idSet for existence checks — duplicates already flagged)
  const itemById = new Map<string, WorkItem>(run.items.map((i) => [i.id, i]));

  // ---- 2. Reference checks ----
  for (const item of run.items) {
    // depends_on references must exist
    for (const dep of item.depends_on) {
      if (!idSet.has(dep)) {
        errors.push(`item "${item.id}": depends_on references unknown item "${dep}"`);
      }
    }

    // needs.from references must exist and must be in depends_on
    for (const [key, binding] of Object.entries(item.needs ?? {})) {
      if (!idSet.has(binding.from)) {
        errors.push(`item "${item.id}": needs["${key}"].from references unknown item "${binding.from}"`);
      } else if (!item.depends_on.includes(binding.from)) {
        errors.push(
          `item "${item.id}": needs["${key}"].from "${binding.from}" is not in depends_on (run normalizeRun first, or add it explicitly)`,
        );
      }
    }
  }

  // ---- 3. Cycle detection (DFS) — any structural error suppresses cycle detection ----
  // (If unknown refs exist, cycles might false-positive)
  const hasStructuralErrors = errors.length > 0;
  if (!hasStructuralErrors) {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>(run.items.map((i) => [i.id, WHITE]));

    const dfs = (id: string): boolean => {
      color.set(id, GRAY);
      const item = itemById.get(id);
      for (const dep of item?.depends_on ?? []) {
        const c = color.get(dep) ?? WHITE;
        if (c === GRAY) {
          errors.push(`item "${id}": cycle detected in depends_on (via "${dep}")`);
          return true;
        }
        if (c === WHITE) {
          if (dfs(dep)) return true;
        }
      }
      color.set(id, BLACK);
      return false;
    };

    for (const item of run.items) {
      if ((color.get(item.id) ?? WHITE) === WHITE) {
        dfs(item.id);
      }
    }
  }

  // ---- 4. Pack-aware checks (only when packs provided) ----
  if (packs) {
    for (const item of run.items) {
      // 4a. Unknown subagentShape
      if (item.subagentShape !== undefined) {
        if (!packs.has(item.subagentShape)) {
          errors.push(`item "${item.id}": subagentShape "${item.subagentShape}" is not registered in packs`);
        }
      }

      // 4b. Edge-tag checks for each needs edge
      if (item.needs) {
        const downstreamShape = item.subagentShape ? packs.get(item.subagentShape) : undefined;

        for (const [key, binding] of Object.entries(item.needs)) {
          // Resolve upstream item and its shape
          const upstreamItem = itemById.get(binding.from);
          if (!upstreamItem) continue; // already flagged as unknown ref

          const upstreamShape = upstreamItem.subagentShape
            ? packs.get(upstreamItem.subagentShape)
            : undefined;

          // Permissive: only check when BOTH ends have shape AND declare tags
          const upstreamOutputTag = upstreamShape?.outputEdgeType;
          const downstreamInputTag = downstreamShape?.inputEdgeTypes?.[key];

          if (
            upstreamOutputTag !== undefined &&
            downstreamInputTag !== undefined &&
            upstreamOutputTag !== downstreamInputTag
          ) {
            errors.push(
              `edge ${binding.from}->${item.id} (${key}): ${upstreamOutputTag}->${downstreamInputTag} incompatible; needs an adapter block`,
            );
          }
        }
      }
    }
  }

  return errors;
}
