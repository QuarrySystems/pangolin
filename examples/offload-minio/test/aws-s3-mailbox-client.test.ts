import { describe, it, expect } from 'vitest';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { AwsS3MailboxClient } from '../src/aws-s3-mailbox-client.js';

const MINIO = process.env.AGORA_S3_ENDPOINT; // set when MinIO is running
const d = MINIO ? describe : describe.skip;

d('AwsS3MailboxClient against MinIO', () => {
  it('put/get/list/delete round-trips under prefix', async () => {
    const client = new S3Client({ endpoint: MINIO, forcePathStyle: true, region: 'us-east-1',
      credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' } });
    await client.send(new CreateBucketCommand({ Bucket: 'agora-data' })).catch(() => {});
    const mb = new AwsS3MailboxClient({ client, bucket: 'agora-data', prefix: 'mailbox/' });
    await mb.put('inbox/x.json', new Uint8Array([7]));
    expect(await mb.get('inbox/x.json')).toEqual(new Uint8Array([7]));
    expect(await mb.list('inbox/')).toContain('inbox/x.json');
    await mb.delete('inbox/x.json');
    expect(await mb.get('inbox/x.json')).toBeNull();
  });
});
