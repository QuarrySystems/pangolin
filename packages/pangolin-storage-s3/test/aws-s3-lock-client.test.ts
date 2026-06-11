import { describe, it, expect } from 'vitest';
import { S3Client, CreateBucketCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { AwsS3LockClient } from '../src/aws-s3-lock-client.js';

const MINIO = process.env.PANGOLIN_S3_ENDPOINT;
const d = MINIO ? describe : describe.skip;

d('AwsS3LockClient against MinIO object lock', () => {
  it('writes under COMPLIANCE retention; delete before retention is rejected', async () => {
    const client = new S3Client({ endpoint: MINIO, forcePathStyle: true, region: 'us-east-1',
      credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' } });
    await client.send(new CreateBucketCommand({ Bucket: 'pangolin-audit', ObjectLockEnabledForBucket: true })).catch(() => {});
    const lock = new AwsS3LockClient({ client, bucket: 'pangolin-audit' });
    const future = new Date(Date.now() + 60_000);
    await lock.putObject('audit/roots/e1.json', new Uint8Array([1]), { retainUntil: future, mode: 'COMPLIANCE' });
    expect((await lock.getObject('audit/roots/e1.json'))).toEqual(new Uint8Array([1]));
    await expect(client.send(new DeleteObjectCommand({ Bucket: 'pangolin-audit', Key: 'audit/roots/e1.json' }))).rejects.toThrow();
  });
});
