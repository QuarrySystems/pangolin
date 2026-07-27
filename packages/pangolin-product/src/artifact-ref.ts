// The security boundary of this package. A product ref is named by the
// sentinel, which is an unhashed overwrite-put, so following one unguarded
// lets an attacker aim the caller's credential at another dispatch's or
// namespace's bytes. Pure and separately exported so consumers can validate
// without fetching.

import { parsePangolinUri, parseStorageUri } from '@quarry-systems/pangolin-core';

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
    // Assign in the constructor, matching pangolin-core/src/errors.ts:75.
    this.name = 'ArtifactRefRejectedError';
  }
}

export function assertArtifactRef(
  ref: string,
  expect: { namespace: string; dispatchId: string },
): { contentHash: string } {
  // parseStorageUri FIRST: it RETURNS kind 'dispatch-record' for a dispatches/
  // URI (uri.ts:152-157) whereas parsePangolinUri THROWS a bare Error on that
  // reserved type — so this ordering buys a typed rejection.
  let kind: string;
  try {
    kind = parseStorageUri(ref).kind;
  } catch {
    // Not a well-formed pangolin URI at all — distinct from a well-formed
    // non-blob, so it gets its own reason rather than being mislabelled.
    throw new ArtifactRefRejectedError('malformed-uri', ref);
  }
  if (kind !== 'blob') throw new ArtifactRefRejectedError('not-a-blob', ref);

  const parts = parsePangolinUri(ref);
  if (parts.namespace !== expect.namespace) {
    throw new ArtifactRefRejectedError('wrong-namespace', ref);
  }
  if (parts.name !== expect.dispatchId) {
    throw new ArtifactRefRejectedError('wrong-dispatch', ref);
  }
  if (parts.contentHash === undefined) {
    throw new ArtifactRefRejectedError('unpinned', ref);
  }
  return { contentHash: parts.contentHash };
}
