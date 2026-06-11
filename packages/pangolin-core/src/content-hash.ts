// Content addressing for pangolin-core.
//
// `computeContentHash` returns `sha256:<hex>` of a canonical encoding:
//   - For raw bytes (`Uint8Array` / `Buffer`), the bytes are hashed directly
//     with no JSON wrapping. This is the "raw payload" case used by storage
//     tests that put the same bytes under different metadata.
//   - For everything else, the input is canonicalized as JSON (object keys
//     sorted lexicographically, array order preserved) and hashed as UTF-8.
//
// `verifyContentHash` throws IntegrityMismatchError if the recomputed hash
// does not match the expected value.

import { createHash } from 'node:crypto';

import { IntegrityMismatchError } from './errors.js';

const SHA256_PREFIX = 'sha256:';

/**
 * True if the input is a raw byte container we should hash directly
 * (no JSON wrapping). Node's `Buffer` is a `Uint8Array` subclass, so the
 * single instanceof check covers both.
 */
function isRawBytes(input: unknown): input is Uint8Array {
  return input instanceof Uint8Array;
}

/**
 * Canonical JSON encoding: object keys sorted lexicographically, array
 * order preserved, everything else delegated to JSON.stringify.
 *
 * `undefined` values inside objects are dropped (consistent with
 * JSON.stringify), and top-level `undefined` becomes the literal string
 * "undefined" — callers should not pass `undefined` at the top level.
 *
 * Exposed under the public name {@link canonicalJsonString} so callers
 * (notably the pangolin-client register helpers) can write the SAME bytes
 * to storage that `computeContentHash` would hash internally — anything
 * else risks an `IntegrityMismatchError` on the storage provider's
 * put-side hash check.
 */
function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map((v) => canonicalize(v));
    return `[${parts.join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue; // mirror JSON.stringify
    parts.push(`${JSON.stringify(k)}:${canonicalize(v)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * Public alias for the internal canonical-JSON serializer. Callers that
 * need to PRODUCE the exact bytes `computeContentHash` would hash for an
 * object (e.g. to write them to storage so the put-side byte-hash check
 * matches the URI's pinned hash) should use this rather than
 * `JSON.stringify`, whose key order is insertion-defined.
 */
export function canonicalJsonString(value: unknown): string {
  return canonicalize(value);
}

/**
 * Compute the content hash of an input.
 *
 * Returns a string of the form `sha256:<hex>`.
 *
 * - Raw bytes (`Uint8Array` / `Buffer`) are hashed directly.
 * - Everything else is canonicalized to JSON (sorted keys, preserved
 *   array order) and hashed as UTF-8.
 */
export function computeContentHash(input: unknown): string {
  const hasher = createHash('sha256');
  if (isRawBytes(input)) {
    hasher.update(input);
  } else {
    hasher.update(canonicalize(input), 'utf8');
  }
  return `${SHA256_PREFIX}${hasher.digest('hex')}`;
}

/**
 * Verify that the recomputed content hash of `input` matches `expected`.
 *
 * @throws IntegrityMismatchError if the hashes differ.
 */
export function verifyContentHash(input: unknown, expected: string): void {
  const actual = computeContentHash(input);
  if (actual !== expected) {
    throw new IntegrityMismatchError(expected, actual);
  }
}
