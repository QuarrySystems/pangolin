// Tests for S3StorageProvider.
//
// Smoke tests run against LocalStack when PANGOLIN_TEST_S3_ENDPOINT is set.
// Unit tests below use a fake S3 client and run unconditionally — they
// pin down the conditional-write behavior on the index update.

import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { beforeAll, describe, it, expect } from 'vitest';

import { ConflictError } from '@quarry-systems/pangolin-core';

import { S3StorageProvider } from '../src/index.js';

const endpoint = process.env.PANGOLIN_TEST_S3_ENDPOINT;
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
    await client.send(new CreateBucketCommand({ Bucket: 'pangolin-test-smoke' }));
  } catch (e: unknown) {
    const name = (e as { name?: string }).name;
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') {
      throw e;
    }
  }
});

itIf('put + get round-trips bytes by content hash via LocalStack', async () => {
  const sp = new S3StorageProvider({ bucket: 'pangolin-test-smoke', client });
  const payload = new TextEncoder().encode('hello s3');
  const { contentHash } = await sp.put('pangolin://test/capability/foo', payload);
  const retrieved = await sp.get(`pangolin://test/capability/foo/${contentHash}`);
  expect(new TextDecoder().decode(retrieved)).toBe('hello s3');
});

describe('S3StorageProvider.rootUri', () => {
  it('bucket-only form returns s3://<bucket>', () => {
    const sp = new S3StorageProvider({ bucket: 'my-bucket', client });
    expect(sp.rootUri).toBe('s3://my-bucket');
  });

  it('bucket + prefix returns s3://<bucket>/<prefix> with no trailing slash', () => {
    const sp = new S3StorageProvider({
      bucket: 'my-bucket',
      client,
      prefix: 'pangolin/v1',
    });
    expect(sp.rootUri).toBe('s3://my-bucket/pangolin/v1');
  });

  it('normalizes a trailing-slash prefix the same as a clean one', () => {
    const sp = new S3StorageProvider({
      bucket: 'my-bucket',
      client,
      prefix: 'pangolin/v1/',
    });
    expect(sp.rootUri).toBe('s3://my-bucket/pangolin/v1');
  });
});

// --------------------------------------------------------------------------
// Fake-client unit tests for the optimistic-concurrency index update.
// --------------------------------------------------------------------------

interface CapturedCmd {
  kind: 'get' | 'put';
  key: string;
  ifMatch?: string;
  ifNoneMatch?: string;
  body?: Uint8Array;
}

interface StoredObject {
  body: Uint8Array;
  etag: string;
}

function preconditionFailedError(): Error {
  const err = new Error('PreconditionFailed') as Error & {
    name: string;
    $metadata: { httpStatusCode: number };
  };
  err.name = 'PreconditionFailed';
  err.$metadata = { httpStatusCode: 412 };
  return err;
}

function notFoundError(): Error {
  const err = new Error('NoSuchKey') as Error & {
    name: string;
    $metadata: { httpStatusCode: number };
  };
  err.name = 'NoSuchKey';
  err.$metadata = { httpStatusCode: 404 };
  return err;
}

interface FakeClientOpts {
  /**
   * When provided, called on each PutObjectCommand targeting the given
   * index key before the put is applied. Returning true means: simulate
   * a concurrent writer landing first (rotate the etag), so the IfMatch
   * precondition this call carries will fail.
   */
  preempt?: (attempt: number, key: string) => boolean;
}

class FakeS3 {
  store = new Map<string, StoredObject>();
  commands: CapturedCmd[] = [];
  attempts = new Map<string, number>();
  etagCounter = 0;

  constructor(private opts: FakeClientOpts = {}) {}

  private nextEtag(): string {
    this.etagCounter += 1;
    return `"etag-${this.etagCounter}"`;
  }

  // Mimic S3Client.send for the two command types this provider uses.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async send(cmd: any): Promise<any> {
    if (cmd instanceof GetObjectCommand) {
      const key = String(cmd.input.Key);
      this.commands.push({ kind: 'get', key });
      const obj = this.store.get(key);
      if (!obj) throw notFoundError();
      return {
        Body: {
          transformToByteArray: async () => obj.body,
        },
        ETag: obj.etag,
      };
    }
    if (cmd instanceof PutObjectCommand) {
      const key = String(cmd.input.Key);
      const ifMatch = cmd.input.IfMatch as string | undefined;
      const ifNoneMatch = cmd.input.IfNoneMatch as string | undefined;
      const bodyInput = cmd.input.Body as Uint8Array | undefined;
      this.commands.push({
        kind: 'put',
        key,
        ifMatch,
        ifNoneMatch,
        body: bodyInput,
      });

      const attempt = this.attempts.get(key) ?? 0;
      this.attempts.set(key, attempt + 1);
      const preempt = this.opts.preempt?.(attempt, key) ?? false;

      const existing = this.store.get(key);

      if (preempt && existing) {
        // Simulate a concurrent writer arriving between this caller's
        // Get and Put: rotate the etag in the store so this IfMatch
        // fails. Preserve the existing body — we're modelling a writer
        // who appended something, not someone who blew the file away.
        const concurrent: StoredObject = {
          body: existing.body,
          etag: this.nextEtag(),
        };
        this.store.set(key, concurrent);
      }

      const current = this.store.get(key);

      if (ifNoneMatch === '*' && current) {
        throw preconditionFailedError();
      }
      if (ifMatch && (!current || current.etag !== ifMatch)) {
        throw preconditionFailedError();
      }

      const stored: StoredObject = {
        body: bodyInput ?? new Uint8Array(),
        etag: this.nextEtag(),
      };
      this.store.set(key, stored);
      return { ETag: stored.etag };
    }
    throw new Error(`unexpected command: ${cmd?.constructor?.name}`);
  }
}

function findIndexPuts(fake: FakeS3): CapturedCmd[] {
  return fake.commands.filter(
    (c) => c.kind === 'put' && c.key.endsWith('_index.json'),
  );
}

describe('S3StorageProvider index conditional writes', () => {
  it('writes the first index entry with IfNoneMatch: *', async () => {
    const fake = new FakeS3();
    const sp = new S3StorageProvider({
      bucket: 'b',
      // The provider only calls .send(); cast through unknown.
      client: fake as unknown as S3Client,
    });
    await sp.put('pangolin://ns/capability/foo', new TextEncoder().encode('x'));

    const indexPuts = findIndexPuts(fake);
    expect(indexPuts.length).toBe(1);
    expect(indexPuts[0]!.ifNoneMatch).toBe('*');
    expect(indexPuts[0]!.ifMatch).toBeUndefined();
  });

  it('writes a subsequent index entry with IfMatch: <etag>', async () => {
    const fake = new FakeS3();
    const sp = new S3StorageProvider({
      bucket: 'b',
      client: fake as unknown as S3Client,
    });
    await sp.put('pangolin://ns/capability/foo', new TextEncoder().encode('a'));
    await sp.put('pangolin://ns/capability/foo', new TextEncoder().encode('b'));

    const indexPuts = findIndexPuts(fake);
    expect(indexPuts.length).toBe(2);
    expect(indexPuts[1]!.ifMatch).toBeDefined();
    expect(indexPuts[1]!.ifNoneMatch).toBeUndefined();
  });

  it('retries the read-modify-write loop on 412 PreconditionFailed', async () => {
    // Preempt only on the first index Put attempt.
    const fake = new FakeS3({
      preempt: (attempt, key) =>
        attempt === 0 && key.endsWith('_index.json'),
    });
    const sp = new S3StorageProvider({
      bucket: 'b',
      client: fake as unknown as S3Client,
    });

    // Seed the index with an initial entry so the second put hits IfMatch.
    await sp.put('pangolin://ns/capability/foo', new TextEncoder().encode('a'));
    fake.commands.length = 0;
    fake.attempts.clear();

    await sp.put('pangolin://ns/capability/foo', new TextEncoder().encode('b'));

    const indexPuts = findIndexPuts(fake);
    // The first attempt should 412, the second should land.
    expect(indexPuts.length).toBeGreaterThanOrEqual(2);
  });

  it('throws ConflictError after exhausting retries', async () => {
    // Preempt every Put attempt — the retry loop can never converge.
    const fake = new FakeS3({
      preempt: (_attempt, key) => key.endsWith('_index.json'),
    });
    const sp = new S3StorageProvider({
      bucket: 'b',
      client: fake as unknown as S3Client,
    });

    // Seed initial entry so subsequent puts use IfMatch.
    await sp.put('pangolin://ns/capability/foo', new TextEncoder().encode('a'));

    await expect(
      sp.put('pangolin://ns/capability/foo', new TextEncoder().encode('b')),
    ).rejects.toBeInstanceOf(ConflictError);
  }, 10_000);

  it('no-ops the index update when the contentHash is already present', async () => {
    const fake = new FakeS3();
    const sp = new S3StorageProvider({
      bucket: 'b',
      client: fake as unknown as S3Client,
    });
    const payload = new TextEncoder().encode('a');
    await sp.put('pangolin://ns/capability/foo', payload);
    fake.commands.length = 0;

    // Re-put the same content. The blob put may still happen (and 412 on
    // IfNoneMatch:*) but the index put must NOT happen — the entry is
    // already registered.
    await sp.put('pangolin://ns/capability/foo', payload);

    expect(findIndexPuts(fake).length).toBe(0);
  });
});

// --------------------------------------------------------------------------
// Dispatch-record (reserved `dispatches/` prefix) support.
//
// The retention layer in pangolin-client writes dispatch records to URIs like
// `pangolin://<ns>/dispatches/<id>/record.json`. The general `parsePangolinUri`
// rejects `type === 'dispatches'`, but the storage provider uses the
// permissive `parseStorageUri` so these writes go through. Dispatch records
// are NOT content-addressed: each URI maps directly to a single S3 object
// with no `_index.json` and no hash-suffixed `.blob` key.
// --------------------------------------------------------------------------

describe('S3StorageProvider dispatch-record prefix', () => {
  it('put + get round-trips bytes under the reserved dispatches prefix', async () => {
    const fake = new FakeS3();
    const sp = new S3StorageProvider({
      bucket: 'b',
      client: fake as unknown as S3Client,
    });
    const uri = 'pangolin://ns/dispatches/d-123/record.json';
    const payload = new TextEncoder().encode('{"hello":"dispatch"}');
    const { contentHash } = await sp.put(uri, payload);
    expect(contentHash).toMatch(/^sha256:/);

    const retrieved = await sp.get(uri);
    expect(new TextDecoder().decode(retrieved)).toBe('{"hello":"dispatch"}');

    // No _index.json mutation for dispatch records — there's no per-name
    // version registry, the URI itself is the canonical address.
    expect(findIndexPuts(fake).length).toBe(0);
  });

  it('put + get round-trips bytes under a nested dispatches suffix', async () => {
    const fake = new FakeS3();
    const sp = new S3StorageProvider({
      bucket: 'b',
      client: fake as unknown as S3Client,
    });
    const uri = 'pangolin://ns/dispatches/d-abc/events/0001.json';
    const payload = new TextEncoder().encode('{"event":1}');
    await sp.put(uri, payload);
    const retrieved = await sp.get(uri);
    expect(new TextDecoder().decode(retrieved)).toBe('{"event":1}');
  });

  it('overwriting a dispatch record replaces the prior bytes (NOT content-addressed)', async () => {
    const fake = new FakeS3();
    const sp = new S3StorageProvider({
      bucket: 'b',
      client: fake as unknown as S3Client,
    });
    const uri = 'pangolin://ns/dispatches/d-overwrite/record.json';
    await sp.put(uri, new TextEncoder().encode('first'));
    await sp.put(uri, new TextEncoder().encode('second'));
    const retrieved = await sp.get(uri);
    expect(new TextDecoder().decode(retrieved)).toBe('second');
  });
});
