import type { MailboxStore, MailboxS3Client } from '../contracts/index.js';

/** MailboxStore backed by an injected S3 seam. Logic only — the concrete
 *  AWS-SDK client is supplied by the caller (example/Tier-2 storage pkg). */
export class S3Mailbox implements MailboxStore {
  constructor(private readonly s3: MailboxS3Client) {}
  put(key: string, bytes: Uint8Array): Promise<void> { return this.s3.put(key, bytes); }
  get(key: string): Promise<Uint8Array | null> { return this.s3.get(key); }
  delete(key: string): Promise<void> { return this.s3.delete(key); }
  async list(prefix: string): Promise<string[]> {
    // segment-boundary-safe prefix match, matching LocalDirMailbox semantics
    const dirPrefix = prefix.endsWith('/') ? prefix : prefix + '/';
    const keys = await this.s3.list(prefix); // pass BARE prefix; seam may over-return
    return keys.filter((k) => k === prefix || k.startsWith(dirPrefix));
  }
}
