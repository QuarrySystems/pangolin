// Tests that S3StorageProvider.get() translates an S3 "no such key" SDK
// error into pangolin-core's StorageNotFoundError, on both the
// dispatch-record path and the content-addressed blob path.
//
// Today `getDispatchRecord` has no not-found handling at all, so a
// NoSuchKey propagates as the raw SDK error — that breaks
// `readOutputSentinel`'s published `{ status: 'absent' }` contract on S3.
// These tests fail before the fix and pass after.
//
// The fixture is a REAL `NoSuchKey` instance (not a hand-rolled
// `{ name: 'NoSuchKey' }` object) so the provider's `isNotFound` exercises
// its `err instanceof NoSuchKey` leg rather than falling back to the `name`
// string comparison.

import { describe, expect, it } from 'vitest';
import { GetObjectCommand, NoSuchKey, type S3Client } from '@aws-sdk/client-s3';

import { S3StorageProvider } from '../src/index.js';

/**
 * Minimal fake S3 client whose `send` always throws the given error for a
 * `GetObjectCommand`. `client?: S3Client` on S3StorageProviderOpts will not
 * structurally accept a hand-rolled `{ send }` object, so callers cast at
 * the construction site (matches the pattern already used by
 * `endpoint-opts.test.ts` / `encryption.test.ts` for injected fakes).
 */
function s3ThatThrows(err: unknown): { send: (cmd: unknown) => Promise<never> } {
  return {
    async send(cmd: unknown) {
      if (cmd instanceof GetObjectCommand) {
        throw err;
      }
      throw new Error(
        `unexpected command: ${(cmd as { constructor?: { name?: string } })?.constructor?.name}`,
      );
    },
  };
}

const NO_SUCH_KEY = () =>
  new NoSuchKey({
    $metadata: { httpStatusCode: 404 },
    message: 'The specified key does not exist.',
  });

const ACCESS_DENIED = () => {
  const err = new Error('Access Denied') as Error & {
    name: string;
    $metadata: { httpStatusCode: number };
  };
  err.name = 'AccessDenied';
  err.$metadata = { httpStatusCode: 403 };
  return err;
};

describe('S3StorageProvider not-found translation', () => {
  it('translates NoSuchKey on a dispatch record into StorageNotFoundError', async () => {
    const sp = new S3StorageProvider({
      bucket: 'b',
      client: s3ThatThrows(NO_SUCH_KEY()) as unknown as S3Client,
    });
    const uri = 'pangolin://ns/dispatches/d1/output.json';

    await expect(sp.get(uri)).rejects.toMatchObject({ name: 'StorageNotFoundError', uri });
  });

  it('translates NoSuchKey on a pinned blob into StorageNotFoundError', async () => {
    const sp = new S3StorageProvider({
      bucket: 'b',
      client: s3ThatThrows(NO_SUCH_KEY()) as unknown as S3Client,
    });
    const uri = 'pangolin://ns/capability/foo/sha256:abc123';

    await expect(sp.get(uri)).rejects.toMatchObject({ name: 'StorageNotFoundError', uri });
  });

  it('populates .uri with the pangolin:// URI, not the S3 key, for a dispatch record', async () => {
    const sp = new S3StorageProvider({
      bucket: 'b',
      prefix: 'some-prefix',
      client: s3ThatThrows(NO_SUCH_KEY()) as unknown as S3Client,
    });
    const uri = 'pangolin://ns/dispatches/d1/output.json';

    try {
      await sp.get(uri);
      throw new Error('expected sp.get to reject');
    } catch (err) {
      expect((err as { uri?: string }).uri).toBe(uri);
      // The S3 key would have been `some-prefix/ns/dispatches/d1/output.json`
      // — a different string in a different address space.
      expect((err as { uri?: string }).uri).not.toContain('some-prefix');
    }
  });

  it('leaves a non-404 SDK error (AccessDenied) unchanged on the dispatch-record path', async () => {
    const sp = new S3StorageProvider({
      bucket: 'b',
      client: s3ThatThrows(ACCESS_DENIED()) as unknown as S3Client,
    });
    const uri = 'pangolin://ns/dispatches/d1/output.json';

    await expect(sp.get(uri)).rejects.toMatchObject({ name: 'AccessDenied' });
  });

  it('leaves a non-404 SDK error (AccessDenied) unchanged on the blob path', async () => {
    const sp = new S3StorageProvider({
      bucket: 'b',
      client: s3ThatThrows(ACCESS_DENIED()) as unknown as S3Client,
    });
    const uri = 'pangolin://ns/capability/foo/sha256:abc123';

    await expect(sp.get(uri)).rejects.toMatchObject({ name: 'AccessDenied' });
  });
});
