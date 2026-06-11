// `pipeline.register(spec)` — caller-side helper for registering pipeline specs.
//
// Behavior summary:
//   - Validates the spec using `validatePipelineSpec` from pangolin-core; throws
//     collecting ALL validation errors if any are found.
//   - The content hash is computed over the canonical-JSON serialization of the
//     spec object (sorted keys), so byte-hash and object-hash cohere.
//   - If the same content hash is already registered (same spec), the existing
//     `registeredAt` is returned and no duplicate put is issued (idempotent).
//   - A different spec for the same id produces a NEW pinned version; both
//     versions coexist immutably in storage.
//   - The storage layer is the authority on `registeredAt` — re-read after put.

import {
  buildPangolinUri,
  canonicalJsonString,
  computeContentHash,
  validatePipelineSpec,
  type PipelineSpec,
} from '@quarry-systems/pangolin-core';
import type { PangolinClient } from './client.js';

/** The reference returned after a successful `registerPipeline` call. */
export interface PipelineRef {
  id: string;
  registeredAt: string;
  contentHash: string;
}

/**
 * Register a pipeline spec against the client's storage. Returns a
 * {@link PipelineRef} containing the spec id, content hash, and the
 * storage-authoritative registration timestamp.
 *
 * Throws when the spec fails structural validation (all errors surfaced),
 * or when the storage provider is inconsistent (resolveLatest returns null
 * immediately after a successful put).
 */
export async function registerPipeline(
  client: PangolinClient,
  spec: PipelineSpec,
): Promise<PipelineRef> {
  const errors = validatePipelineSpec(spec);
  if (errors.length) {
    throw new Error(`pipeline.register: invalid spec:\n${errors.join('\n')}`);
  }

  // Write canonical JSON bytes (sorted-key serialization) — not JSON.stringify.
  // The storage provider recomputes the byte-hash and compares against the
  // pinned URI's hash; if we wrote insertion-order JSON, the byte-hash would
  // diverge from the canonical-object hash embedded in the URI and `put` would
  // throw IntegrityMismatchError. Hashing the object (not the bytes) keeps the
  // round-trip coherent on both sides.
  const contentHash = computeContentHash(spec);

  const baseUri = buildPangolinUri({
    namespace: client.namespace,
    type: 'pipeline',
    name: spec.id,
  });
  const pinnedUri = buildPangolinUri({
    namespace: client.namespace,
    type: 'pipeline',
    name: spec.id,
    contentHash,
  });

  // Idempotency check: if the latest registration for this logical id already
  // matches this content hash, reuse its registeredAt and skip the storage write.
  const latest = await client.storage.resolveLatest(baseUri);
  let registeredAt: string;
  if (latest && latest.contentHash === contentHash) {
    registeredAt = latest.registeredAt;
  } else {
    // Write canonical JSON bytes so byte-hash and object-hash cohere (see note above).
    await client.storage.put(
      pinnedUri,
      new TextEncoder().encode(canonicalJsonString(spec)),
    );
    // The storage layer is the authority on registeredAt — re-read it.
    // If resolveLatest returns null here, the storage provider is inconsistent
    // (a put just succeeded for this name); fail fast rather than inventing a
    // local timestamp, which would silently violate the storage-as-authority
    // contract.
    const after = await client.storage.resolveLatest(baseUri);
    if (!after) {
      throw new Error(
        `storage.resolveLatest returned null immediately after put: ${pinnedUri}. Storage provider may be inconsistent.`,
      );
    }
    registeredAt = after.registeredAt;
  }

  return { id: spec.id, registeredAt, contentHash };
}
