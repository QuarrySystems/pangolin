import type { MailboxStore, MailboxS3Client } from '../contracts/index.js';

/** MailboxStore backed by an injected S3 seam. Logic only — the concrete
 *  AWS-SDK client is supplied by the caller (example/Tier-2 storage pkg). */
export class S3Mailbox implements MailboxStore {
  /** Present ONLY when the injected seam can actually do a delimited listing.
   *
   *  Assigned in the constructor rather than declared as a method so the capability is
   *  advertised honestly: a caller testing `mbox.listPrefixes` learns whether the cheap
   *  query exists, instead of finding a method that quietly emulates it over `list` at
   *  the O(records) cost it was added to avoid. Absent means absent, and the caller picks
   *  its own fallback knowing the price. */
  readonly listPrefixes?: (prefix: string) => Promise<string[]>;

  constructor(private readonly s3: MailboxS3Client) {
    const seamListPrefixes = s3.listPrefixes?.bind(s3);
    if (seamListPrefixes) {
      this.listPrefixes = async (prefix: string): Promise<string[]> => {
        const dirPrefix = prefix.endsWith('/') ? prefix : prefix + '/';
        return (await seamListPrefixes(dirPrefix)).filter((k) => k.startsWith(dirPrefix));
      };
    }
  }
  put(key: string, bytes: Uint8Array): Promise<void> {
    return this.s3.put(key, bytes);
  }
  get(key: string): Promise<Uint8Array | null> {
    return this.s3.get(key);
  }
  delete(key: string): Promise<void> {
    return this.s3.delete(key);
  }
  async list(prefix: string): Promise<string[]> {
    // segment-boundary-safe prefix match, matching LocalDirMailbox semantics
    const dirPrefix = prefix.endsWith('/') ? prefix : prefix + '/';
    const keys = await this.s3.list(prefix); // pass BARE prefix; seam may over-return
    return keys.filter((k) => k === prefix || k.startsWith(dirPrefix));
  }
}
