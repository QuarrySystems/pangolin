import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand, NoSuchKey } from '@aws-sdk/client-s3';
import type { MailboxS3Client } from '@quarry-systems/agora-orchestrator';

export interface AwsS3MailboxClientOpts { client: S3Client; bucket: string; prefix?: string; }

export class AwsS3MailboxClient implements MailboxS3Client {
  private readonly p: string;
  constructor(private readonly o: AwsS3MailboxClientOpts) { this.p = o.prefix ? o.prefix.replace(/\/?$/, '/') : ''; }
  private k(key: string) { return this.p + key; }
  async put(key: string, bytes: Uint8Array) {
    await this.o.client.send(new PutObjectCommand({ Bucket: this.o.bucket, Key: this.k(key), Body: bytes }));
  }
  async get(key: string) {
    try {
      const r = await this.o.client.send(new GetObjectCommand({ Bucket: this.o.bucket, Key: this.k(key) }));
      if (!r.Body) return new Uint8Array(0); // present but empty object
      return new Uint8Array(await r.Body.transformToByteArray());
    } catch (e) { if (e instanceof NoSuchKey) return null; throw e; }
  }
  async list(prefix: string) {
    const out: string[] = []; let token: string | undefined;
    do {
      const r = await this.o.client.send(new ListObjectsV2Command({ Bucket: this.o.bucket, Prefix: this.k(prefix), ContinuationToken: token }));
      for (const c of r.Contents ?? []) if (c.Key) out.push(c.Key.slice(this.p.length));
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
  async delete(key: string) {
    await this.o.client.send(new DeleteObjectCommand({ Bucket: this.o.bucket, Key: this.k(key) }));
  }
}
