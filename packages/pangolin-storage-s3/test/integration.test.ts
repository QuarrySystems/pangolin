// Integration tests for S3StorageProvider against LocalStack.
//
// Gated on PANGOLIN_TEST_S3_ENDPOINT — when absent, the whole describe block
// skips so `pnpm test` stays green without a Docker dependency. CI brings
// up the LocalStack service in docker/localstack/docker-compose.yml.
//
// Test matrix mirrors pangolin-storage-local's smoke suite plus an
// integrity-mismatch case that exercises the get() recomputed-hash guard:
//   1. round-trip put/get
//   2. idempotent put (same content → same hash, no duplicate index entry)
//   3. integrity verification (get throws when stored bytes don't match URI hash)
//   4. list returns entries newest-first after multiple puts
//   5. atomicity: concurrent puts on different content hashes all land in _index.json

import { S3StorageProvider } from '../src/index.js';
import { IntegrityMismatchError } from '@quarry-systems/pangolin-core';
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';

const endpoint = process.env.PANGOLIN_TEST_S3_ENDPOINT;
const describeIf = endpoint ? describe : describe.skip;

const client = new S3Client({
  endpoint,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

const BUCKET = 'pangolin-test-integration';

async function purgeBucket(): Promise<void> {
  let continuationToken: string | undefined;
  do {
    const res = (await client.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        ContinuationToken: continuationToken,
      }),
    )) as {
      Contents?: Array<{ Key?: string }>;
      NextContinuationToken?: string;
    };
    for (const obj of res.Contents ?? []) {
      if (obj.Key) {
        await client.send(
          new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key }),
        );
      }
    }
    continuationToken = res.NextContinuationToken;
  } while (continuationToken);
}

beforeAll(async () => {
  if (!endpoint) return;
  try {
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  } catch (e: unknown) {
    const name = (e as { name?: string }).name;
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') {
      throw e;
    }
  }
  // Start from a clean slate even if a previous run left objects behind.
  await purgeBucket();
});

afterAll(async () => {
  if (!endpoint) return;
  await purgeBucket();
  try {
    await client.send(new DeleteBucketCommand({ Bucket: BUCKET }));
  } catch {
    // Best-effort teardown — leaving the bucket around is harmless for
    // the next run because beforeAll purges before exercising.
  }
});

describeIf('S3StorageProvider against LocalStack', () => {
  it('round-trips a blob through put/get', async () => {
    const sp = new S3StorageProvider({ bucket: BUCKET, client });
    const payload = new TextEncoder().encode('hello integration');
    const { contentHash } = await sp.put(
      'pangolin://test/capability/roundtrip',
      payload,
    );
    const retrieved = await sp.get(
      `pangolin://test/capability/roundtrip/${contentHash}`,
    );
    expect(new TextDecoder().decode(retrieved)).toBe('hello integration');
  });

  it('idempotent put: identical content returns same hash, no duplicate index entry', async () => {
    const sp = new S3StorageProvider({ bucket: BUCKET, client });
    const payload = new TextEncoder().encode('idempotent-payload');
    const uri = 'pangolin://test/capability/idempotent';
    const first = await sp.put(uri, payload);
    const second = await sp.put(uri, payload);
    expect(second.contentHash).toBe(first.contentHash);

    const list = await sp.list(uri);
    expect(list).toHaveLength(1);
    expect(list[0]!.contentHash).toBe(first.contentHash);
  });

  it('integrity verification: get throws on URI hash that does not match blob bytes', async () => {
    // Set up a corrupted blob in the bucket: store bytes "real" but
    // place them under the key that S3StorageProvider would derive for
    // a different (lying) content hash. Calling get() with the lying
    // URI must surface the mismatch instead of silently returning bytes.
    const sp = new S3StorageProvider({ bucket: BUCKET, client });

    // First, put real bytes so we know what the legitimate hash looks like.
    const realPayload = new TextEncoder().encode('the-real-bytes');
    const { contentHash: realHash } = await sp.put(
      'pangolin://test/capability/integrity-real',
      realPayload,
    );

    // Construct a *different* but well-formed sha256 hash that the
    // bytes do NOT hash to. The provider's URI parser only validates
    // that the segment is non-empty and free of slashes, so any
    // `sha256:<hex>` string is structurally valid.
    const lyingHash =
      realHash === `sha256:${'0'.repeat(64)}`
        ? `sha256:${'1'.repeat(64)}`
        : `sha256:${'0'.repeat(64)}`;
    expect(lyingHash).not.toBe(realHash);

    // Write the *real* bytes under the blob key the provider would use
    // for the *lying* hash. The blob key format mirrors src/index.ts:
    //   <namespace>/<type>/<name>/<safeHash>.blob
    // where safeHash replaces ':' with '_'.
    const safeLying = lyingHash.replace(':', '_');
    const corruptKey = `test/capability/integrity-corrupt/${safeLying}.blob`;
    await client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: corruptKey,
        Body: realPayload,
      }),
    );

    await expect(
      sp.get(`pangolin://test/capability/integrity-corrupt/${lyingHash}`),
    ).rejects.toBeInstanceOf(IntegrityMismatchError);
  });

  it('list returns entries newest-first after multiple puts', async () => {
    const sp = new S3StorageProvider({ bucket: BUCKET, client });
    const uri = 'pangolin://test/capability/ordering';
    // Sequential puts with a small delay so the ISO `registeredAt`
    // timestamps actually differ (millisecond resolution is plenty for
    // 3 puts in a row but isn't guaranteed without a yield).
    await sp.put(uri, new TextEncoder().encode('first'));
    await new Promise((r) => setTimeout(r, 10));
    await sp.put(uri, new TextEncoder().encode('second'));
    await new Promise((r) => setTimeout(r, 10));
    const third = await sp.put(uri, new TextEncoder().encode('third'));

    const list = await sp.list(uri);
    expect(list).toHaveLength(3);
    // Newest-first ordering: the most-recently-put hash leads.
    expect(list[0]!.contentHash).toBe(third.contentHash);
    // And the registeredAt timestamps must be monotone non-increasing.
    for (let i = 1; i < list.length; i++) {
      expect(
        list[i - 1]!.registeredAt >= list[i]!.registeredAt,
      ).toBe(true);
    }
  });

  it('concurrent puts on different content hashes do not lose entries', async () => {
    // This is the atomicity guarantee on _index.json: three writers
    // race the read-modify-write loop, and all three contentHashes
    // must survive in the index. The provider's IfMatch/IfNoneMatch
    // retry loop is what makes this true against real S3 semantics.
    const sp = new S3StorageProvider({ bucket: BUCKET, client });
    const uri = 'pangolin://test/capability/parallel';
    const [a, b, c] = await Promise.all([
      sp.put(uri, new TextEncoder().encode('A')),
      sp.put(uri, new TextEncoder().encode('B')),
      sp.put(uri, new TextEncoder().encode('C')),
    ]);

    // Sanity: three distinct hashes (different payloads).
    expect(new Set([a.contentHash, b.contentHash, c.contentHash]).size).toBe(3);

    const list = await sp.list(uri);
    expect(list).toHaveLength(3);
    expect(new Set(list.map((e) => e.contentHash))).toEqual(
      new Set([a.contentHash, b.contentHash, c.contentHash]),
    );

    // Each blob is independently retrievable and round-trips its bytes.
    const fetched = await Promise.all(
      list.map(async (e) => {
        const bytes = await sp.get(
          `pangolin://test/capability/parallel/${e.contentHash}`,
        );
        return new TextDecoder().decode(bytes);
      }),
    );
    expect(new Set(fetched)).toEqual(new Set(['A', 'B', 'C']));
  });

  describe('resolveByHash', () => {
    it('returns null when (ns, type) has no registered blobs', async () => {
      const sp = new S3StorageProvider({
        bucket: BUCKET,
        client,
        prefix: `tests/${Date.now()}-rbh-empty`,
      });
      const hit = await sp.resolveByHash({
        namespace: 'test',
        type: 'capability',
        contentHash:
          'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      });
      expect(hit).toBeNull();
    });

    it('finds the matching name when a capability is registered', async () => {
      const sp = new S3StorageProvider({
        bucket: BUCKET,
        client,
        prefix: `tests/${Date.now()}-rbh-single`,
      });
      const { contentHash } = await sp.put(
        'pangolin://test/capability/alpha',
        new TextEncoder().encode('alpha-bytes'),
      );
      const hit = await sp.resolveByHash({
        namespace: 'test',
        type: 'capability',
        contentHash,
      });
      expect(hit).not.toBeNull();
      expect(hit!.name).toBe('alpha');
      expect(hit!.contentHash).toBe(contentHash);
      expect(hit!.uri).toBe(`pangolin://test/capability/alpha/${contentHash}`);
    });

    it('distinguishes between multiple registered names', async () => {
      const sp = new S3StorageProvider({
        bucket: BUCKET,
        client,
        prefix: `tests/${Date.now()}-rbh-multi`,
      });
      const { contentHash: hA } = await sp.put(
        'pangolin://test/capability/alpha',
        new TextEncoder().encode('A'),
      );
      const { contentHash: hB } = await sp.put(
        'pangolin://test/capability/bravo',
        new TextEncoder().encode('B'),
      );
      const hitA = await sp.resolveByHash({
        namespace: 'test',
        type: 'capability',
        contentHash: hA,
      });
      const hitB = await sp.resolveByHash({
        namespace: 'test',
        type: 'capability',
        contentHash: hB,
      });
      expect(hitA!.name).toBe('alpha');
      expect(hitB!.name).toBe('bravo');
    });

    it('does not bleed across types', async () => {
      const sp = new S3StorageProvider({
        bucket: BUCKET,
        client,
        prefix: `tests/${Date.now()}-rbh-types`,
      });
      const { contentHash } = await sp.put(
        'pangolin://test/capability/alpha',
        new TextEncoder().encode('alpha'),
      );
      const hit = await sp.resolveByHash({
        namespace: 'test',
        type: 'subagent',
        contentHash,
      });
      expect(hit).toBeNull();
    });
  });
});
