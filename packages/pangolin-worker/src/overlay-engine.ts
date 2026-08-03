// pangolin-worker: overlay engine (§6.3).
//
// Materializes a series of capability bundles onto the worker filesystem.
// For each path inside each bundle, the engine picks a merge rule in this
// precedence:
//
//   1. Pangolin Scale-defined manifest paths (`pangolin-channel.json`,
//      `pangolin-setup.sh`, `pangolin-notifications.json`) — fixed rules owned
//      by Pangolin Scale itself. These win over adapter claims so the runtime can
//      always reason about its own manifests.
//   2. Adapter-reserved paths (matched against `adapter.reservedPaths`
//      via a tiny glob matcher) — uses the adapter's `mergeRules` entry
//      for that glob. If no rule exists, falls back to last-write-wins.
//   3. Everything else — last-write-wins.
//
// The accumulated value per path is held in memory across all bundles
// then written to `workspaceDir` once at the end, so a single materialize
// pass is responsible for I/O. Bytes-as-opaque files are written
// byte-for-byte; JSON-parseable payloads are merged structurally and
// re-serialized.
//
// Type conflicts inside `deep-merge` / `array-union` surface as
// `MergeTypeConflictError` (re-thrown from `applyMergeRule`). The caller
// is expected to convert this into `reason: 'integrity-failed'` per §6.3.

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RuntimeAdapter, MergeRule } from '@quarry-systems/pangolin-core';
import { applyMergeRule } from './merge-rules.js';

/**
 * A decoded capability bundle: the bundle name (for diagnostics) plus a
 * map from workspace-relative path to file bytes. The fetcher decodes
 * the packed bundle bytes into this shape before handing it to the
 * overlay engine.
 */
export interface CapabilityBundle {
  name: string;
  files: Record<string, Uint8Array>;
}

const PANGOLIN_MANIFEST_RULES: Record<string, MergeRule> = {
  'pangolin-channel.json': { strategy: 'last-write-wins' },
  'pangolin-setup.sh': { strategy: 'last-write-wins' },
  'pangolin-notifications.json': { strategy: 'array-union' },
};

/**
 * Overlay a sequence of capability bundles onto `workspaceDir`. Bundles
 * are walked in declared order; per-path merge rules decide whether
 * later bundles overwrite, deep-merge, or array-union earlier values.
 */
export async function overlayCapabilities(opts: {
  workspaceDir: string;
  bundles: CapabilityBundle[];
  adapter: RuntimeAdapter;
}): Promise<void> {
  // Accumulate path -> (bytes | parsed-json) across all bundles, applying
  // the per-path merge rule each time a path reappears.
  const accumulated = new Map<string, unknown>();

  for (const bundle of opts.bundles) {
    for (const [path, bytes] of Object.entries(bundle.files)) {
      const rule = pickMergeRule(path, opts.adapter);
      const incoming = rule.strategy === 'last-write-wins' ? bytes : parseForMerge(bytes);

      if (!accumulated.has(path)) {
        accumulated.set(path, incoming);
        continue;
      }

      const existing = accumulated.get(path);
      accumulated.set(path, applyMergeRule(rule, existing, incoming, path));
    }
  }

  // Materialize the merged result to disk in a single pass.
  for (const [path, value] of accumulated) {
    const fullPath = join(opts.workspaceDir, path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, valueToBytes(value));
  }
}

function pickMergeRule(path: string, adapter: RuntimeAdapter): MergeRule {
  // 1. Pangolin Scale-defined manifest paths win over any adapter claim.
  for (const [name, rule] of Object.entries(PANGOLIN_MANIFEST_RULES)) {
    if (path === name || path.endsWith('/' + name)) return rule;
  }

  // 2. Adapter-reserved paths: try each reserved glob in declared order.
  for (const reserved of adapter.reservedPaths) {
    if (matchesGlob(path, reserved)) {
      const rule = adapter.mergeRules?.[reserved];
      if (rule) return rule;
      // Reserved but no rule declared: fall through to default.
      break;
    }
  }

  // 3. Default: last-write-wins.
  return { strategy: 'last-write-wins' };
}

/**
 * Tiny glob matcher supporting `**` (any number of path segments),
 * `*` (any chars except `/`), and literal segments. Sufficient for
 * adapter `reservedPaths` patterns like `.claude/settings.json` and
 * `.claude/skills/**`.
 *
 * Exported for reuse by `context-check.ts`: a third glob matcher inside
 * this package would diverge in semantics, so this is the de facto
 * dialect for anything in pangolin-worker that needs one.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  // Build a regex by escaping regex metachars then expanding glob tokens.
  // Order matters: ** must be expanded before *.
  const placeholder = '\u0000DOUBLE_STAR\u0000';
  const escaped = pattern
    .replace(/\*\*/g, placeholder)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(new RegExp(placeholder, 'g'), '.*');
  const re = new RegExp('^' + escaped + '$');
  return re.test(path);
}

/**
 * Decode bytes for structural merging. JSON-parseable text becomes the
 * parsed value; everything else falls through to the original bytes so
 * downstream merge logic can still treat it sensibly (typically as a
 * type conflict).
 */
function parseForMerge(bytes: Uint8Array): unknown {
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    return bytes;
  }
}

function valueToBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string') return new TextEncoder().encode(v);
  return new TextEncoder().encode(JSON.stringify(v, null, 2));
}
