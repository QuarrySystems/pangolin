/** Mutable, name-addressed key→bytes store with prefix listing — the orchestrator
 *  submission/outbox backend. Keys are '/'-delimited logical paths. Distinct from the
 *  content-addressed StorageProvider (which stays for artifacts/manifests). */
export interface MailboxStore {
  put(key: string, bytes: Uint8Array): Promise<void>;  // write/overwrite
  get(key: string): Promise<Uint8Array | null>;         // null if absent
  list(prefix: string): Promise<string[]>;              // logical keys under prefix
  delete(key: string): Promise<void>;                   // idempotent (no-op if absent)
}
