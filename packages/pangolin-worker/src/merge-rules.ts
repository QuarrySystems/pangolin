// Pure merge functions for the three `MergeRule` strategies declared in
// `@quarry-systems/pangolin-core` (§5.8). Used by the overlay engine for
// adapter-reserved paths and for pangolin-defined manifest paths (§6.3).
//
// Inputs are never mutated. Type conflicts in `deep-merge` throw a typed
// error so the overlay engine can convert it into
// `reason: 'integrity-failed'` per §6.3.

import type { MergeRule } from "@quarry-systems/pangolin-core";

/**
 * Thrown by `applyMergeRule` (deep-merge / array-union) when two values
 * with incompatible runtime types meet at the same path. The overlay
 * engine converts this into `reason: 'integrity-failed'` per §6.3.
 */
export class MergeTypeConflictError extends Error {
  constructor(
    public readonly path: string,
    public readonly leftType: string,
    public readonly rightType: string,
  ) {
    super(`merge type conflict at ${path}: ${leftType} vs ${rightType}`);
    this.name = "MergeTypeConflictError";
  }
}

/**
 * Apply a single `MergeRule` to `existing` and `incoming`, returning the
 * merged value. Inputs are never mutated.
 *
 * @param debugPath dotted path used only for `MergeTypeConflictError`
 *   messages; defaults to an empty string when called at the root.
 */
export function applyMergeRule(
  rule: MergeRule,
  existing: unknown,
  incoming: unknown,
  debugPath = "",
): unknown {
  switch (rule.strategy) {
    case "last-write-wins":
      return incoming;
    case "array-union":
      if (!Array.isArray(existing) || !Array.isArray(incoming)) {
        throw new MergeTypeConflictError(debugPath, typeOf(existing), typeOf(incoming));
      }
      return dedupePreserveOrder([...existing, ...incoming]);
    case "deep-merge":
      return deepMerge(existing, incoming, rule.arrayMode ?? "union", debugPath);
  }
}

function deepMerge(
  left: unknown,
  right: unknown,
  arrayMode: "union" | "replace" | "concat",
  path: string,
): unknown {
  if (left === undefined) return right;
  if (right === undefined) return left;

  if (Array.isArray(left) && Array.isArray(right)) {
    switch (arrayMode) {
      case "union":
        return dedupePreserveOrder([...left, ...right]);
      case "replace":
        return [...right];
      case "concat":
        return [...left, ...right];
    }
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const out: Record<string, unknown> = { ...left };
    for (const key of Object.keys(right)) {
      const childPath = path === "" ? key : `${path}.${key}`;
      out[key] = deepMerge(left[key], right[key], arrayMode, childPath);
    }
    return out;
  }

  if (typeOf(left) !== typeOf(right)) {
    throw new MergeTypeConflictError(path, typeOf(left), typeOf(right));
  }

  // Same scalar runtime type (or both null): last-write-wins.
  return right;
}

function dedupePreserveOrder<T>(items: readonly T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function typeOf(v: unknown): string {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v;
}
