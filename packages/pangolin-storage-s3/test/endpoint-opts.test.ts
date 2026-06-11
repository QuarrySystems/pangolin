// Tests for the optional `endpoint` / `forcePathStyle` / `region` opts on
// S3StorageProvider.
//
// These run unconditionally — no live S3/MinIO endpoint required. We
// inspect the S3Client that the provider builds internally by accessing the
// (private) `s3` field and calling the async `config.endpoint()` resolver
// that the AWS SDK exposes on every client it constructs.

import { describe, it, expect } from 'vitest';
import { S3StorageProvider } from '../src/index.js';

it('builds a client targeting the given endpoint when no client is injected', async () => {
  const p = new S3StorageProvider({ bucket: 'b', endpoint: 'http://localhost:9000', forcePathStyle: true });
  const cfgEndpoint = await (p as any).s3.config.endpoint();
  expect(cfgEndpoint.hostname).toBe('localhost');
  expect(cfgEndpoint.port).toBe(9000);
});

it('still prefers an injected client over endpoint opts', async () => {
  const sentinel: any = { __sentinel: true };
  const p = new S3StorageProvider({ bucket: 'b', client: sentinel, endpoint: 'http://localhost:9000' });
  expect((p as any).s3).toBe(sentinel);
});
