import { computeContentHash, IntegrityMismatchError } from '@quarry-systems/pangolin-core';
import type { StorageProvider } from '@quarry-systems/pangolin-core';
import { assertArtifactRef } from './artifact-ref.js';

/**
 * Fetch and verify one product artifact.
 *
 * NOTE: `StorageProvider.get` takes no size bound and the interface exposes no
 * size metadata, so an oversized object cannot be pre-checked here. Bound it in
 * your own provider (e.g. HeadObject/Content-Length before GetObject).
 */
export async function fetchDispatchArtifact(
  storage: StorageProvider,
  ref: string,
  expect: { namespace: string; dispatchId: string },
): Promise<Uint8Array> {
  const { contentHash } = assertArtifactRef(ref, expect); // throws BEFORE any I/O
  const bytes = await storage.get(ref);
  const actual = computeContentHash(bytes); // raw bytes, never a parsed object
  if (actual !== contentHash) throw new IntegrityMismatchError(contentHash, actual);
  return bytes;
}
