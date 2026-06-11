// Tests for the optional server-side encryption (SSE) option on
// S3StorageProvider.
//
// These run unconditionally with an injected fake S3 client (the
// `opts.client` seam) — they assert on the *input* of every PutObjectCommand
// the provider issues, which a live S3 endpoint cannot observe. No
// PANGOLIN_TEST_S3_ENDPOINT and no Docker required.
//
// Coverage:
//   - SSE-KMS (BYOK): ServerSideEncryption: 'aws:kms' + SSEKMSKeyId on writes.
//   - SSE-S3: ServerSideEncryption: 'AES256', no SSEKMSKeyId.
//   - default (omitted): NO SSE fields at all — the no-downgrade rule.
// Asserted across the content-addressed blob path, the index-file path, and
// the dispatch-record path, since all three matter.

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { describe, it, expect } from 'vitest';

import { S3StorageProvider } from '../src/index.js';

interface CapturedPut {
  key: string;
  serverSideEncryption?: string;
  sseKmsKeyId?: string;
  hasSSE: boolean;
  hasKmsKeyId: boolean;
}

/**
 * Minimal fake S3 client that records every PutObjectCommand input and
 * returns a trivial success. GET returns NoSuchKey so the index starts
 * empty (forcing the create-with-IfNoneMatch path) without any stored state.
 */
class RecordingS3 {
  puts: CapturedPut[] = [];
  private etagCounter = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async send(cmd: any): Promise<any> {
    if (cmd instanceof PutObjectCommand) {
      const input = cmd.input as {
        Key?: string;
        ServerSideEncryption?: string;
        SSEKMSKeyId?: string;
      };
      this.puts.push({
        key: String(input.Key),
        serverSideEncryption: input.ServerSideEncryption,
        sseKmsKeyId: input.SSEKMSKeyId,
        hasSSE: 'ServerSideEncryption' in input,
        hasKmsKeyId: 'SSEKMSKeyId' in input,
      });
      this.etagCounter += 1;
      return { ETag: `"etag-${this.etagCounter}"` };
    }
    if (cmd instanceof GetObjectCommand) {
      // Always "not found" so updateIndex takes the create path.
      const err = new Error('NoSuchKey') as Error & {
        name: string;
        $metadata: { httpStatusCode: number };
      };
      err.name = 'NoSuchKey';
      err.$metadata = { httpStatusCode: 404 };
      throw err;
    }
    throw new Error(`unexpected command: ${cmd?.constructor?.name}`);
  }
}

function blobPut(fake: RecordingS3): CapturedPut {
  const hit = fake.puts.find((p) => p.key.endsWith('.blob'));
  if (!hit) throw new Error('no blob PutObjectCommand was captured');
  return hit;
}

function indexPut(fake: RecordingS3): CapturedPut {
  const hit = fake.puts.find((p) => p.key.endsWith('_index.json'));
  if (!hit) throw new Error('no index PutObjectCommand was captured');
  return hit;
}

const KMS_KEY = 'arn:aws:kms:us-east-1:111122223333:key/abc';

describe('S3StorageProvider server-side encryption', () => {
  describe('SSE-KMS (BYOK)', () => {
    it('blob put carries ServerSideEncryption: aws:kms and SSEKMSKeyId', async () => {
      const fake = new RecordingS3();
      const sp = new S3StorageProvider({
        bucket: 'b',
        client: fake as unknown as S3Client,
        encryption: { mode: 'aws:kms', kmsKeyId: KMS_KEY },
      });
      await sp.put('pangolin://ns/capability/foo', new TextEncoder().encode('x'));

      const blob = blobPut(fake);
      expect(blob.serverSideEncryption).toBe('aws:kms');
      expect(blob.sseKmsKeyId).toBe(KMS_KEY);
    });

    it('index-file put also carries the SSE-KMS params', async () => {
      const fake = new RecordingS3();
      const sp = new S3StorageProvider({
        bucket: 'b',
        client: fake as unknown as S3Client,
        encryption: { mode: 'aws:kms', kmsKeyId: KMS_KEY },
      });
      await sp.put('pangolin://ns/capability/foo', new TextEncoder().encode('x'));

      const idx = indexPut(fake);
      expect(idx.serverSideEncryption).toBe('aws:kms');
      expect(idx.sseKmsKeyId).toBe(KMS_KEY);
    });

    it('dispatch-record put also carries the SSE-KMS params', async () => {
      const fake = new RecordingS3();
      const sp = new S3StorageProvider({
        bucket: 'b',
        client: fake as unknown as S3Client,
        encryption: { mode: 'aws:kms', kmsKeyId: KMS_KEY },
      });
      await sp.put(
        'pangolin://ns/dispatches/d-1/record.json',
        new TextEncoder().encode('{}'),
      );

      const dispatch = fake.puts.find((p) => p.key.endsWith('record.json'));
      expect(dispatch).toBeDefined();
      expect(dispatch!.serverSideEncryption).toBe('aws:kms');
      expect(dispatch!.sseKmsKeyId).toBe(KMS_KEY);
    });

    it('omitting kmsKeyId sets aws:kms with no SSEKMSKeyId (bucket default key)', async () => {
      const fake = new RecordingS3();
      const sp = new S3StorageProvider({
        bucket: 'b',
        client: fake as unknown as S3Client,
        encryption: { mode: 'aws:kms' },
      });
      await sp.put('pangolin://ns/capability/foo', new TextEncoder().encode('x'));

      const blob = blobPut(fake);
      expect(blob.serverSideEncryption).toBe('aws:kms');
      expect(blob.hasKmsKeyId).toBe(false);
    });
  });

  describe('SSE-S3 (AES256)', () => {
    it('blob put carries ServerSideEncryption: AES256 and NO SSEKMSKeyId', async () => {
      const fake = new RecordingS3();
      const sp = new S3StorageProvider({
        bucket: 'b',
        client: fake as unknown as S3Client,
        encryption: { mode: 'AES256' },
      });
      await sp.put('pangolin://ns/capability/foo', new TextEncoder().encode('x'));

      const blob = blobPut(fake);
      expect(blob.serverSideEncryption).toBe('AES256');
      expect(blob.hasKmsKeyId).toBe(false);
    });

    it('index-file put carries AES256 too', async () => {
      const fake = new RecordingS3();
      const sp = new S3StorageProvider({
        bucket: 'b',
        client: fake as unknown as S3Client,
        encryption: { mode: 'AES256' },
      });
      await sp.put('pangolin://ns/capability/foo', new TextEncoder().encode('x'));

      const idx = indexPut(fake);
      expect(idx.serverSideEncryption).toBe('AES256');
      expect(idx.hasKmsKeyId).toBe(false);
    });
  });

  describe('default (encryption omitted) — no-downgrade rule', () => {
    it('blob put carries NO ServerSideEncryption and NO SSEKMSKeyId', async () => {
      const fake = new RecordingS3();
      const sp = new S3StorageProvider({
        bucket: 'b',
        client: fake as unknown as S3Client,
      });
      await sp.put('pangolin://ns/capability/foo', new TextEncoder().encode('x'));

      const blob = blobPut(fake);
      expect(blob.hasSSE).toBe(false);
      expect(blob.hasKmsKeyId).toBe(false);
    });

    it('index-file put carries NO SSE fields either', async () => {
      const fake = new RecordingS3();
      const sp = new S3StorageProvider({
        bucket: 'b',
        client: fake as unknown as S3Client,
      });
      await sp.put('pangolin://ns/capability/foo', new TextEncoder().encode('x'));

      const idx = indexPut(fake);
      expect(idx.hasSSE).toBe(false);
      expect(idx.hasKmsKeyId).toBe(false);
    });

    it('dispatch-record put carries NO SSE fields either', async () => {
      const fake = new RecordingS3();
      const sp = new S3StorageProvider({
        bucket: 'b',
        client: fake as unknown as S3Client,
      });
      await sp.put(
        'pangolin://ns/dispatches/d-1/record.json',
        new TextEncoder().encode('{}'),
      );

      const dispatch = fake.puts.find((p) => p.key.endsWith('record.json'));
      expect(dispatch).toBeDefined();
      expect(dispatch!.hasSSE).toBe(false);
      expect(dispatch!.hasKmsKeyId).toBe(false);
    });
  });
});
