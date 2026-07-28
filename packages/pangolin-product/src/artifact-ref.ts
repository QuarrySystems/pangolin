// The security boundary of this package. A product ref is named by the
// sentinel, which is an unhashed overwrite-put, so following one unguarded
// lets an attacker aim the caller's credential at another dispatch's or
// namespace's bytes. Pure and separately exported so consumers can validate
// without fetching.

import { parsePangolinUri, parseStorageUri } from '@quarry-systems/pangolin-core';
import type { StorageUriParts } from '@quarry-systems/pangolin-core';

export type ArtifactRefRejection =
  | 'malformed-uri'
  | 'not-a-blob'
  | 'wrong-namespace'
  | 'wrong-dispatch'
  | 'unpinned';

export class ArtifactRefRejectedError extends Error {
  constructor(
    readonly reason: ArtifactRefRejection,
    readonly ref: string,
  ) {
    super(`artifact ref rejected (${reason}): ${ref}`);
    // Assign in the constructor, matching the convention set by
    // pangolin-core's `IntegrityMismatchError`.
    this.name = 'ArtifactRefRejectedError';
  }
}

export function assertArtifactRef(
  ref: string,
  expect: { namespace: string; dispatchId: string },
): { contentHash: string } {
  // parseStorageUri FIRST: it RETURNS kind 'dispatch-record' for a dispatches/
  // URI (the `dispatch-record` branch of `parseStorageUri`) whereas
  // parsePangolinUri THROWS a bare Error on that reserved type — so this
  // ordering buys a typed rejection.
  let kind: StorageUriParts['kind'];
  try {
    kind = parseStorageUri(ref).kind;
  } catch {
    // Not a well-formed pangolin URI at all — distinct from a well-formed
    // non-blob, so it gets its own reason rather than being mislabelled.
    throw new ArtifactRefRejectedError('malformed-uri', ref);
  }
  if (kind !== 'blob') throw new ArtifactRefRejectedError('not-a-blob', ref);

  // Second parse, wrapped: if a future reserved type is ever added,
  // parseStorageUri above would still report 'blob' for it (RESERVED_TYPES
  // lives in pangolin-core, not here) and parsePangolinUri would throw a
  // bare Error on it below. Wrapping keeps that escape typed instead of
  // letting an untyped Error leak out of this function.
  let parts;
  try {
    parts = parsePangolinUri(ref);
  } catch {
    throw new ArtifactRefRejectedError('malformed-uri', ref);
  }
  if (parts.namespace !== expect.namespace) {
    throw new ArtifactRefRejectedError('wrong-namespace', ref);
  }
  if (parts.name !== expect.dispatchId) {
    throw new ArtifactRefRejectedError('wrong-dispatch', ref);
  }
  // `!parts.contentHash` rather than `=== undefined`: this must reject an
  // unpinned ref on its own terms, independent of whether upstream
  // `assertSegment` happens to reject an empty trailing segment first. If
  // that upstream guard ever loosens, this must not silently return an
  // effectively unpinned `{ contentHash: '' }`.
  if (!parts.contentHash) {
    throw new ArtifactRefRejectedError('unpinned', ref);
  }
  return { contentHash: parts.contentHash };
}
