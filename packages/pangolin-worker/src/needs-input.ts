// pangolin-worker: needs_input sentinel resolver (§6.9 step 11, ADR-0009).
//
// The runtime adapter reports the absolute path of a present sentinel file
// via `RuntimeExit.needsInputSentinelPath`. The worker then reads, parses,
// and validates that file. This module owns that resolution rule.
//
// Per ADR-0009, a malformed sentinel (unparseable JSON, missing or empty
// `question`, or `partial_state` whose canonical-JSON serialization exceeds
// 1 MiB) is a worker failure — the caller is expected to surface it as
// `reason: 'worker-failed'`, not as "no needs_input." We model that here by
// returning a discriminated outcome rather than throwing; the caller maps
// the discriminator to the right failure shape.
//
// Canonical-JSON sizing sorts object keys recursively and preserves array
// order. This matches the convention any future on-wire encoder of
// `partial_state` would use, so the 1 MiB cap is independent of how the
// sub-agent happened to order its keys when writing the sentinel.

import { readFile } from 'node:fs/promises';

/** Parsed needs_input payload after rename of `partial_state` → `partialState`. */
export interface NeedsInputPayload {
  question: string;
  options?: string[];
  context?: string;
  partialState?: unknown;
}

/**
 * Discriminated outcome of resolving a sentinel file.
 *
 * - `needs_input` — file present, well-formed, and within size limits.
 * - `malformed`   — file missing on disk, unparseable JSON, or schema-invalid.
 * - `oversized`   — `partial_state` canonical-JSON size exceeds 1 MiB.
 */
export type NeedsInputOutcome =
  | { kind: 'needs_input'; payload: NeedsInputPayload }
  | { kind: 'malformed'; detail: string }
  | { kind: 'oversized'; sizeBytes: number };

const ONE_MIB = 1024 * 1024;

export async function resolveNeedsInputSentinel(
  path: string,
): Promise<NeedsInputOutcome> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    return {
      kind: 'malformed',
      detail: `cannot read sentinel at ${path}: ${(err as Error).message}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      kind: 'malformed',
      detail: `cannot parse sentinel at ${path}: ${(err as Error).message}`,
    };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      kind: 'malformed',
      detail: `sentinel at ${path} is not a JSON object`,
    };
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.question !== 'string' || obj.question.length === 0) {
    return {
      kind: 'malformed',
      detail: `sentinel at ${path} missing required non-empty 'question' field`,
    };
  }

  if (obj.partial_state !== undefined) {
    const canonical = canonicalJson(obj.partial_state);
    const size = Buffer.byteLength(canonical, 'utf-8');
    if (size > ONE_MIB) {
      return { kind: 'oversized', sizeBytes: size };
    }
  }

  const payload: NeedsInputPayload = { question: obj.question };
  if (Array.isArray(obj.options)) {
    payload.options = obj.options.filter(
      (o): o is string => typeof o === 'string',
    );
  }
  if (typeof obj.context === 'string') payload.context = obj.context;
  if (obj.partial_state !== undefined) payload.partialState = obj.partial_state;

  return { kind: 'needs_input', payload };
}

/**
 * Canonical JSON serialization: sorts object keys recursively, preserves
 * array order, uses `JSON.stringify` for scalars (which already produces a
 * canonical form for strings, numbers, booleans, and null).
 *
 * Returns `undefined` for `undefined`-valued inputs to match JSON.stringify's
 * own handling — but the caller guards against that by only invoking us when
 * `partial_state !== undefined`.
 */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    return `[${v.map(canonicalJson).join(',')}]`;
  }
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys
    .map(
      (k) =>
        `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`,
    )
    .join(',')}}`;
}
