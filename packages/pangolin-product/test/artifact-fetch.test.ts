import { it, expect } from 'vitest';
import { computeContentHash, IntegrityMismatchError } from '@quarry-systems/pangolin-core';
import { fetchDispatchArtifact } from '../src/artifact-fetch.js';
import { ArtifactRefRejectedError } from '../src/artifact-ref.js';

it('never calls storage.get when the ref is rejected', async () => {
  let called = false;
  const storage = {
    get: async () => {
      called = true;
      return new Uint8Array();
    },
  };
  await expect(
    fetchDispatchArtifact(storage as never, 'pangolin://other-ns/artifact/d1/sha256:abc', {
      namespace: 'ns',
      dispatchId: 'd1',
    }),
  ).rejects.toThrow(ArtifactRefRejectedError);
  expect(called).toBe(false);
});

it('returns the fetched bytes when the ref passes assertArtifactRef and the hash matches', async () => {
  const bytes = new TextEncoder().encode('hello world');
  const hash = computeContentHash(bytes);
  const ref = `pangolin://ns/artifact/d1/${hash}`;
  const storage = { get: async (_uri: string) => bytes };
  const result = await fetchDispatchArtifact(storage as never, ref, {
    namespace: 'ns',
    dispatchId: 'd1',
  });
  expect(result).toBe(bytes);
});

it('throws IntegrityMismatchError when the fetched bytes do not hash to the ref content hash', async () => {
  const bytes = new TextEncoder().encode('hello world');
  const hash = computeContentHash(bytes);
  const ref = `pangolin://ns/artifact/d1/${hash}`;
  const tamperedBytes = new TextEncoder().encode('goodbye world');
  const storage = { get: async (_uri: string) => tamperedBytes };
  const error: unknown = await fetchDispatchArtifact(storage as never, ref, {
    namespace: 'ns',
    dispatchId: 'd1',
  }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(IntegrityMismatchError);
  const mismatch = error as IntegrityMismatchError;
  // Pins the constructor argument order: `expected` must be the URI-pinned
  // hash and `actual` must be computeContentHash of the bytes actually
  // fetched. A swap of (expected, actual) would keep a bare
  // `.toThrow(IntegrityMismatchError)` assertion green.
  expect(mismatch.expected).toBe(hash);
  expect(mismatch.actual).toBe(computeContentHash(tamperedBytes));
});

it('throws IntegrityMismatchError (fail-closed) when the ref is pinned with the correct hex digest under the wrong algorithm prefix', async () => {
  // assertSegment only rejects empty segments and segments containing '/' —
  // it does not validate the shape of the hash segment. So a ref can be
  // pinned as `md5:<sha256-hex>` and still pass assertArtifactRef. The
  // fail-closed behavior here comes ONLY from computeContentHash's
  // `sha256:<hex>` output never string-equaling an `md5:<hex>` ref. If a
  // future refactor compared just the hex portion, this would silently
  // start accepting the mismatched prefix.
  const bytes = new TextEncoder().encode('hello world');
  const trueHash = computeContentHash(bytes);
  const trueHex = trueHash.slice('sha256:'.length);
  const ref = `pangolin://ns/artifact/d1/md5:${trueHex}`;
  const storage = { get: async (_uri: string) => bytes };
  await expect(
    fetchDispatchArtifact(storage as never, ref, { namespace: 'ns', dispatchId: 'd1' }),
  ).rejects.toThrow(IntegrityMismatchError);
});

it('throws IntegrityMismatchError (fail-closed) when the ref is pinned with the correct sha256 hex but uppercased', async () => {
  // computeContentHash always emits lowercase hex, so an uppercased ref
  // fails strict string equality today. Nothing pins that in beyond the
  // strict comparison itself — a case-insensitive comparison refactor
  // would silently start accepting this.
  const bytes = new TextEncoder().encode('hello world');
  const trueHash = computeContentHash(bytes);
  const trueHex = trueHash.slice('sha256:'.length);
  const ref = `pangolin://ns/artifact/d1/sha256:${trueHex.toUpperCase()}`;
  const storage = { get: async (_uri: string) => bytes };
  await expect(
    fetchDispatchArtifact(storage as never, ref, { namespace: 'ns', dispatchId: 'd1' }),
  ).rejects.toThrow(IntegrityMismatchError);
});
