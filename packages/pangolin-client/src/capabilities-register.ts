// `capabilities.register(opts)` — caller-side helper for §4.1.1 of the
// pangolin-core spec.
//
// Behavior summary:
//   - Walks every file in `opts.files`, enforcing a 50 MiB cap on the
//     bundle's total byte size (throws `CapabilityTooLargeError`).
//   - Scans every text file's contents for credential-shaped patterns and
//     throws `CredentialsInEnvError` with the field
//     `capability:<name>:<path>` on the first match. Binary inputs
//     (`Uint8Array`) are not scanned — the scanner is text-only by
//     contract.
//   - Serializes the bundle deterministically (`serializeCapabilityBundle`:
//     a JSON header line listing entries sorted by path, followed by the
//     concatenated file bytes) and computes the bundle's content hash as
//     `computeContentHash(serializedBundleBytes)`. Because the serializer
//     sorts entries by path, identical file contents in any insertion
//     order yield byte-identical output and therefore the same hash.
//     This matches what the worker's bundle-fetcher verifies on read.
//   - If the latest registration for this logical name already matches
//     this content hash, returns the existing `CapabilityRef` without
//     issuing a duplicate put (idempotent).
//   - Otherwise, writes the bundle blob to the configured
//     `StorageProvider` at the pinned URI and returns a fresh
//     `CapabilityRef`.

import {
  CapabilityTooLargeError,
  buildPangolinUri,
  computeContentHash,
  type CapabilityRef,
} from '@quarry-systems/pangolin-core';

import type { PangolinClient } from './client.js';
import {
  assertNoCredentialPattern,
  type CredentialPatternCheckOpts,
} from './credential-pattern.js';

/** 50 MiB cap on the total bundle size (§4.1.1). */
const FIFTY_MIB = 50 * 1024 * 1024;

/** Options to {@link registerCapability}. */
export interface RegisterCapabilityOpts extends CredentialPatternCheckOpts {
  name: string;
  /**
   * Map from logical path (e.g. `"index.js"`, `".claude/settings.json"`)
   * to the file's contents. `string` values are encoded as UTF-8 and
   * scanned for credential patterns; `Uint8Array` values are passed
   * through unchanged and are NOT scanned (the scanner is text-only).
   */
  files: Record<string, Uint8Array | string>;
}

/**
 * Register a capability bundle against the client's storage. Returns a
 * {@link CapabilityRef} pinning the registration's content hash.
 *
 * Throws:
 *   - {@link CapabilityTooLargeError} when total bytes > 50 MiB.
 *   - `CredentialsInEnvError` when any text file matches a credential
 *     pattern (the error's `field` is `capability:<name>:<path>`).
 *
 * Idempotent: re-registering with identical content returns the existing
 * `CapabilityRef` without bumping `registeredAt` or writing a new blob.
 */
export async function registerCapability(
  client: PangolinClient,
  opts: RegisterCapabilityOpts,
): Promise<CapabilityRef> {
  // 1. Normalize file contents to bytes, enforce the 50 MiB cap, and scan
  //    text contents for credential patterns. The size check is done
  //    incrementally so a single multi-GiB file aborts before we burn
  //    memory on the rest of the bundle.
  let totalSize = 0;
  const filesBytes: Record<string, Uint8Array> = {};
  for (const [path, contents] of Object.entries(opts.files)) {
    const bytes =
      typeof contents === 'string' ? new TextEncoder().encode(contents) : contents;
    totalSize += bytes.byteLength;
    if (totalSize > FIFTY_MIB) {
      throw new CapabilityTooLargeError(totalSize);
    }
    filesBytes[path] = bytes;
    if (typeof contents === 'string') {
      assertNoCredentialPattern(`capability:${opts.name}:${path}`, contents, {
        allowCredentialPatterns: opts.allowCredentialPatterns,
      });
    }
  }

  // 2. Pack the bundle bytes deterministically and hash THOSE bytes.
  //    The capability bundle is binary (JSON header + concatenated file
  //    bytes), and the worker's bundle-fetcher verifies it by hashing the
  //    raw bytes (`computeContentHash(bytes)`), NOT by canonicalizing the
  //    manifest. The URI's `contentHash` must therefore be the byte-hash
  //    of the serialized bundle — otherwise the storage provider's
  //    put-side check throws IntegrityMismatchError, AND the worker would
  //    later reject the same blob it was asked to fetch.
  //
  //    `serializeCapabilityBundle` is fully deterministic (entries sorted
  //    by path), so the same input files always produce the same bundle
  //    bytes — idempotency is preserved.
  const bundlePayload = serializeCapabilityBundle(opts.name, filesBytes);
  const contentHash = computeContentHash(bundlePayload);

  const baseUri = buildPangolinUri({
    namespace: client.namespace,
    type: 'capability',
    name: opts.name,
  });

  // 3. Idempotency check — if the latest registration already matches,
  //    reuse its registeredAt and skip the storage write.
  const latest = await client.storage.resolveLatest(baseUri);
  if (latest && latest.contentHash === contentHash) {
    return {
      name: opts.name,
      registeredAt: latest.registeredAt,
      contentHash,
    };
  }

  // 4. Otherwise, write the packed bytes at the pinned URI.
  const pinnedUri = buildPangolinUri({
    namespace: client.namespace,
    type: 'capability',
    name: opts.name,
    contentHash,
  });
  await client.storage.put(pinnedUri, bundlePayload);

  // The storage layer is the authority on registeredAt — re-read it.
  const after = await client.storage.resolveLatest(baseUri);
  const registeredAt = after?.registeredAt ?? new Date().toISOString();
  return { name: opts.name, registeredAt, contentHash };
}

/**
 * Deterministic bundle packing: a single UTF-8 JSON header line followed
 * by the concatenated file bytes in the order declared by the header.
 *
 * Layout:
 *
 *   <JSON header>\n<bytes for entries[0]><bytes for entries[1]>...
 *
 * The header is `{"name": ..., "entries": [{"path": ..., "size": N}, ...]}`
 * with `entries` sorted lexicographically by `path` so re-packing the same
 * inputs produces byte-identical output. The worker's bundle-fetcher
 * decodes this by reading up to the first `\n`, parsing the header, then
 * slicing the trailing region into per-file blobs using `size`.
 */
function serializeCapabilityBundle(
  name: string,
  files: Record<string, Uint8Array>,
): Uint8Array {
  const paths = Object.keys(files).sort();
  const entries = paths.map((path) => ({ path, size: files[path].byteLength }));
  const header = JSON.stringify({ name, entries });
  const headerBytes = new TextEncoder().encode(`${header}\n`);

  const totalSize =
    headerBytes.byteLength + paths.reduce((acc, p) => acc + files[p].byteLength, 0);
  const out = new Uint8Array(totalSize);
  let offset = 0;
  out.set(headerBytes, offset);
  offset += headerBytes.byteLength;
  for (const path of paths) {
    const bytes = files[path];
    out.set(bytes, offset);
    offset += bytes.byteLength;
  }
  return out;
}
