import { it, expect } from 'vitest';
import { assertArtifactRef, ArtifactRefRejectedError } from '../src/artifact-ref.js';

function expectRejection(
  ref: string,
  expected: { namespace: string; dispatchId: string },
  reason: string,
) {
  let caught: unknown;
  try {
    assertArtifactRef(ref, expected);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ArtifactRefRejectedError);
  const err = caught as ArtifactRefRejectedError;
  expect(err.reason).toBe(reason);
  expect(err.name).toBe('ArtifactRefRejectedError');
  expect(err.ref).toBe(ref);
}

it('accepts a well-formed pinned blob ref matching namespace and dispatchId', () => {
  const result = assertArtifactRef('pangolin://ns/artifact/d1/sha256:abc', {
    namespace: 'ns',
    dispatchId: 'd1',
  });
  expect(result).toEqual({ contentHash: 'sha256:abc' });
});

it('rejects a dispatch-record URI with reason not-a-blob', () => {
  expectRejection(
    'pangolin://ns/dispatches/d1/record.json',
    { namespace: 'ns', dispatchId: 'd1' },
    'not-a-blob',
  );
});

it('rejects a URI without the pangolin scheme with reason malformed-uri', () => {
  expectRejection('http://x', { namespace: 'ns', dispatchId: 'd1' }, 'malformed-uri');
});

it('rejects a too-short pangolin URI with reason malformed-uri', () => {
  expectRejection('pangolin://ns', { namespace: 'ns', dispatchId: 'd1' }, 'malformed-uri');
});

it('rejects a ref for the same dispatchId under a different namespace', () => {
  // Capture and inspect — `toThrow` matches message/class, not properties, so
  // asserting `reason` requires the caught instance.
  let caught: unknown;
  try {
    assertArtifactRef('pangolin://other-ns/artifact/d1/sha256:abc', {
      namespace: 'ns',
      dispatchId: 'd1',
    });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ArtifactRefRejectedError);
  expect((caught as ArtifactRefRejectedError).reason).toBe('wrong-namespace');
});

it('rejects a ref for a different dispatchId under the matching namespace', () => {
  expectRejection(
    'pangolin://ns/artifact/other-id/sha256:abc',
    { namespace: 'ns', dispatchId: 'd1' },
    'wrong-dispatch',
  );
});

it('rejects an unpinned ref with no content hash', () => {
  expectRejection('pangolin://ns/artifact/d1', { namespace: 'ns', dispatchId: 'd1' }, 'unpinned');
});
