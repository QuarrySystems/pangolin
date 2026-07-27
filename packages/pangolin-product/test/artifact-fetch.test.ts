import { it, expect } from 'vitest';
import { computeContentHash, IntegrityMismatchError } from '@quarry-systems/pangolin-core';
import { fetchDispatchArtifact } from '../src/artifact-fetch.js';

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
  ).rejects.toThrow();
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
  await expect(
    fetchDispatchArtifact(storage as never, ref, { namespace: 'ns', dispatchId: 'd1' }),
  ).rejects.toThrow(IntegrityMismatchError);
});
