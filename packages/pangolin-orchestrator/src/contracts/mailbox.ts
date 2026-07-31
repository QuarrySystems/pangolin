/** Mutable, name-addressed key→bytes store with prefix listing — the orchestrator
 *  submission/outbox backend. Keys are '/'-delimited logical paths. Distinct from the
 *  content-addressed StorageProvider (which stays for artifacts/manifests). */
export interface MailboxStore {
  put(key: string, bytes: Uint8Array): Promise<void>; // write/overwrite
  get(key: string): Promise<Uint8Array | null>; // null if absent
  list(prefix: string): Promise<string[]>; // logical keys under prefix
  delete(key: string): Promise<void>; // idempotent (no-op if absent)
  /** OPTIONAL: the immediate child "directories" under `prefix` — one entry per distinct
   *  next segment, each returned with its trailing '/'.
   *
   *  `list` returns every key beneath a prefix, which makes "what exists here?" cost one
   *  entry per RECORD when the caller wanted one per GROUP. Enumerating runs from the
   *  outbox is the case that forced this: measured on the serve stack, the delimited
   *  form answered in 2 s where the recursive form took ~8 minutes over 1.7M objects for
   *  95 runs. S3 exposes exactly this via Delimiter + CommonPrefixes; the contract had
   *  no way to say it, so the cheap query was unreachable.
   *
   *  Optional so existing implementations stay valid — callers must fall back to `list`
   *  when it is absent. */
  listPrefixes?(prefix: string): Promise<string[]>;
}

// MailboxS3Client moved to @quarry-systems/pangolin-core (s3-clients.ts) so the
// pangolin-storage-s3 implementations need no orchestrator dependency (a dev-edge
// cycle broke pnpm's topological build order on clean CI). Re-exported here for
// compatibility — existing consumers keep importing it from this package.
export type { MailboxS3Client } from '@quarry-systems/pangolin-core';
