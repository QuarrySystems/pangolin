// Tests for the canonical-JSON serializer exposed alongside
// `computeContentHash`. The serializer is load-bearing for the
// register-side helpers in pangolin-client: the bytes WRITTEN to storage
// must be the same bytes that `computeContentHash` hashes internally,
// or the storage provider's hash-of-bytes verification will reject the
// put.

import { describe, it, expect } from 'vitest';
import { canonicalJsonString, computeContentHash } from '../src/index.js';

describe('canonicalJsonString', () => {
  it('serializes object keys in sorted order regardless of insertion order', () => {
    const a = canonicalJsonString({ b: 1, a: 2 });
    const b = canonicalJsonString({ a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1}');
  });

  it('preserves array order', () => {
    expect(canonicalJsonString([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles nested objects with sorted keys at every depth', () => {
    expect(canonicalJsonString({ z: { b: 2, a: 1 }, a: [1, 2] })).toBe(
      '{"a":[1,2],"z":{"a":1,"b":2}}',
    );
  });

  it('mirrors JSON.stringify on primitives', () => {
    expect(canonicalJsonString(null)).toBe('null');
    expect(canonicalJsonString(42)).toBe('42');
    expect(canonicalJsonString('hi')).toBe('"hi"');
    expect(canonicalJsonString(true)).toBe('true');
  });

  it('drops undefined values inside objects (mirroring JSON.stringify)', () => {
    expect(canonicalJsonString({ a: 1, b: undefined, c: 3 })).toBe(
      '{"a":1,"c":3}',
    );
  });

  it('the bytes of canonicalJsonString match the bytes that computeContentHash hashes internally', () => {
    // The load-bearing invariant: if you write `canonicalJsonString(obj)`
    // bytes to storage, then `computeContentHash(thoseBytes)` must equal
    // `computeContentHash(obj)`. Storage providers verify the byte-hash
    // against the URI's pinned hash; the two MUST agree.
    const obj = { name: 'reviewer', model: null, prompt: 'be careful' };
    const canonicalBytes = new TextEncoder().encode(canonicalJsonString(obj));
    const byteHash = computeContentHash(canonicalBytes);
    const objHash = computeContentHash(obj);
    expect(byteHash).toBe(objHash);
  });
});
