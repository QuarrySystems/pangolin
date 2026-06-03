/** Mutable, name-addressed key→bytes store with prefix listing — the orchestrator
 *  submission/outbox backend. Keys are '/'-delimited logical paths. Distinct from the
 *  content-addressed StorageProvider (which stays for artifacts/manifests). */
export interface MailboxStore {
  put(key: string, bytes: Uint8Array): Promise<void>;  // write/overwrite
  get(key: string): Promise<Uint8Array | null>;         // null if absent
  list(prefix: string): Promise<string[]>;              // logical keys under prefix
  delete(key: string): Promise<void>;                   // idempotent (no-op if absent)
}

/** Minimal injected S3 seam for S3Mailbox — keeps agora-orchestrator AWS-SDK-free.
 *  Keys are '/'-delimited logical paths under a bucket+prefix the impl owns. */
export interface MailboxS3Client {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  list(prefix: string): Promise<string[]>;   // returns full logical keys
  delete(key: string): Promise<void>;          // idempotent
}
