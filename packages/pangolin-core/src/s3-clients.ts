// Minimal injected S3 client seams — typed contracts shared by the orchestrator
// (which consumes them, staying AWS-SDK-free) and pangolin-storage-s3 (which ships
// the AWS-SDK implementations). Moved here from the orchestrator's contracts so
// the implementation package needs no orchestrator dependency: a storage-s3
// →dev→ orchestrator edge created a workspace dependency cycle (orchestrator
// →dev→ worker →prod→ storage-s3) that broke pnpm's topological build order on
// clean CI. The orchestrator re-exports both names for compatibility.

/** Minimal injected S3 seam for S3Mailbox.
 *  Keys are '/'-delimited logical paths under a bucket+prefix the impl owns. */
export interface MailboxS3Client {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  list(prefix: string): Promise<string[]>; // returns full logical keys
  delete(key: string): Promise<void>; // idempotent
  /** OPTIONAL: immediate child "directories" under `prefix`, each with its trailing '/'.
   *  Maps to ListObjectsV2 `Delimiter: '/'` + `CommonPrefixes`, which answers "what
   *  groups exist here?" in one entry per group instead of one per object. Optional so
   *  existing seams stay valid; callers fall back to `list`. */
  listPrefixes?(prefix: string): Promise<string[]>;
}

/** Minimal injected S3 seam for the object-lock anchor. */
export interface S3LockClient {
  putObject(
    key: string,
    body: Uint8Array,
    opts: { retainUntil: Date; mode: 'COMPLIANCE' },
  ): Promise<void>;
  /** Returns the ORIGINAL (earliest) version of `key`, never the latest. Object Lock keeps the
   *  original undeletable, but an attacker with write access can add a newer version; reading the
   *  earliest (server-ordered, lock-protected) version is what makes the anchored root immutable. */
  getObject(key: string): Promise<Uint8Array | undefined>;
}
