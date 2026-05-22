// Storage provider contract (§5.3).
//
// `StorageProvider` is the runtime-facing surface for content-addressed
// blob storage. Integrators implement this interface against S3, GCS, a
// local FS, etc. The runtime uses it for two distinct flows:
//
//   - `put`/`get` move task artifacts in and out of storage.
//   - `resolveLatest`/`list` walk the symbolic-uri history for a logical
//     name; the storage layer is expected to keep a registry of
//     (uri, contentHash, registeredAt) tuples and answer those queries.
//
// Content hashes are returned by the implementation (typically a hex
// digest of the bytes); the core package does not pick the algorithm.

export interface StorageProvider {
  readonly name: string;
  put(uri: string, contents: Uint8Array): Promise<{ contentHash: string }>;
  get(uri: string): Promise<Uint8Array>;
  resolveLatest(
    uri: string,
  ): Promise<{ uri: string; contentHash: string; registeredAt: string } | null>;
  list(
    uri: string,
  ): Promise<Array<{ uri: string; contentHash: string; registeredAt: string }>>;
  /**
   * Reverse-lookup: find the registered blob in `(namespace, type)` whose
   * content hash matches `contentHash`, returning its logical `name` plus the
   * pinned URI + registeredAt. Returns `null` when no registered entry under
   * that (ns, type) has the requested hash.
   *
   * Used by the dispatch path to round-trip the subagent's bound
   * `capabilities: [hash, hash, ...]` (stored as hashes only) back to
   * `CapabilityRef[]` so the worker can fetch them. Implementations are
   * permitted to do an O(N) walk of the (ns, type) directory; v0.2 may add
   * a sidecar hash→name index for large registries.
   */
  resolveByHash(
    query: { namespace: string; type: string; contentHash: string },
  ): Promise<{
    uri: string;
    name: string;
    contentHash: string;
    registeredAt: string;
  } | null>;
}
