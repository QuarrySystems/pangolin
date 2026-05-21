// Smoke test for S3StorageProvider against LocalStack.
//
// Runs only when AGORA_TEST_S3_ENDPOINT is set (e.g. via docker-compose
// up'd LocalStack). Without it, the single behavior test is skipped, so
// `pnpm -F @quarry-systems/agora-storage-s3 test` exits 0 in environments
// without S3 available.

import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { beforeAll, it, expect } from 'vitest';

import { S3StorageProvider } from '../src/index.js';

const endpoint = process.env.AGORA_TEST_S3_ENDPOINT;
const itIf = endpoint ? it : it.skip;

const client = new S3Client({
  endpoint,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

beforeAll(async () => {
  if (!endpoint) return;
  try {
    await client.send(new CreateBucketCommand({ Bucket: 'agora-test-smoke' }));
  } catch (e: unknown) {
    const name = (e as { name?: string }).name;
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') {
      throw e;
    }
  }
});

itIf('put + get round-trips bytes by content hash via LocalStack', async () => {
  const sp = new S3StorageProvider({ bucket: 'agora-test-smoke', client });
  const payload = new TextEncoder().encode('hello s3');
  const { contentHash } = await sp.put('agora://test/capability/foo', payload);
  const retrieved = await sp.get(`agora://test/capability/foo/${contentHash}`);
  expect(new TextDecoder().decode(retrieved)).toBe('hello s3');
});
