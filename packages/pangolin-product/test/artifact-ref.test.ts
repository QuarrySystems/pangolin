import { it, expect } from 'vitest';
import { assertArtifactRef, ArtifactRefRejectedError } from '../src/artifact-ref.js';

function expectRejection(
  ref: string,
  expected: { namespace: string; dispatchId: string },
  reason: string,
) {
  // Capture and inspect — `toThrow` matches message/class, not properties, so
  // asserting `reason` (and the other fields below) requires the caught
  // instance.
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
  expectRejection(
    'pangolin://other-ns/artifact/d1/sha256:abc',
    { namespace: 'ns', dispatchId: 'd1' },
    'wrong-namespace',
  );
});

it('rejects a ref whose namespace differs only in case from the expected namespace', () => {
  expectRejection(
    'pangolin://NS/artifact/d1/sha256:abc',
    { namespace: 'ns', dispatchId: 'd1' },
    'wrong-namespace',
  );
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

it('rejects an unpinned ref with a trailing slash instead of a content hash, never returning an empty hash', () => {
  // Regresses a guard that must not depend on upstream `assertSegment`
  // rejecting the empty trailing segment before this package ever sees it:
  // whatever reason it fails with today, it must throw — never resolve to
  // `{ contentHash: '' }`.
  let caught: unknown;
  let result: { contentHash: string } | undefined;
  try {
    result = assertArtifactRef('pangolin://ns/artifact/d1/', { namespace: 'ns', dispatchId: 'd1' });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ArtifactRefRejectedError);
  expect(result).toBeUndefined();
});

it('rejects an over-long ref with an extra segment after the content hash', () => {
  expectRejection(
    'pangolin://ns/artifact/d1/hash/extra',
    { namespace: 'ns', dispatchId: 'd1' },
    'malformed-uri',
  );
});

it('rejects a dispatch-record root URI with no suffix with reason not-a-blob', () => {
  expectRejection(
    'pangolin://ns/dispatches/d1',
    { namespace: 'ns', dispatchId: 'd1' },
    'not-a-blob',
  );
});
