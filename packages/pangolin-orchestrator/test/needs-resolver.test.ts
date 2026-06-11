import { describe, it, expect } from 'vitest';
import { resolveInputRefs, selectProductRef } from '../src/engine/needs-resolver.js';
import type { ItemState } from '../src/contracts/index.js';

const base = { executor: 'fake', inputs: {}, depends_on: [], resourceLocks: [], runId: 'r', queue: 'default', status: 'done' as const };

describe('selectProductRef', () => {
  it('returns resultRef for kind=patch', () => {
    const upstream = { ...base, id: 'a', resultRef: 'pangolin://ns/artifact/d/sha256:aa' } as ItemState;
    expect(selectProductRef(upstream, { kind: 'patch' })).toBe('pangolin://ns/artifact/d/sha256:aa');
  });

  it('returns undefined for kind=patch when resultRef is absent', () => {
    const upstream = { ...base, id: 'a' } as ItemState;
    expect(selectProductRef(upstream, { kind: 'patch' })).toBeUndefined();
  });

  it('returns the outputRef entry for kind=output with a matching path', () => {
    const upstream = { ...base, id: 'a', outputRefs: { 'dist/index.js': 'pangolin://ns/artifact/d/sha256:bb' } } as ItemState;
    expect(selectProductRef(upstream, { kind: 'output', path: 'dist/index.js' })).toBe('pangolin://ns/artifact/d/sha256:bb');
  });

  it('returns undefined for kind=output when the path is absent from outputRefs', () => {
    const upstream = { ...base, id: 'a', outputRefs: {} } as ItemState;
    expect(selectProductRef(upstream, { kind: 'output', path: 'dist/index.js' })).toBeUndefined();
  });

  it('returns undefined for kind=output when outputRefs itself is absent', () => {
    const upstream = { ...base, id: 'a' } as ItemState;
    expect(selectProductRef(upstream, { kind: 'output', path: 'dist/index.js' })).toBeUndefined();
  });
});

describe('resolveInputRefs', () => {
  it('resolves a patch binding to the upstream resultRef', () => {
    const a = { ...base, id: 'a', resultRef: 'pangolin://ns/artifact/d/sha256:aa' } as ItemState;
    const b = { ...base, id: 'b', status: 'pending' as const, needs: { patch: { from: 'a', select: { kind: 'patch' as const } } } } as unknown as ItemState;
    expect(resolveInputRefs(b, new Map([['a', a]])))
      .toEqual({ inputRefs: { patch: 'pangolin://ns/artifact/d/sha256:aa' } });
  });

  it('resolves an output-path binding to the upstream outputRef entry', () => {
    const a = { ...base, id: 'a', outputRefs: { 'dist/index.js': 'pangolin://ns/artifact/d/sha256:cc' } } as ItemState;
    const b = { ...base, id: 'b', status: 'pending' as const, needs: { bundle: { from: 'a', select: { kind: 'output' as const, path: 'dist/index.js' } } } } as unknown as ItemState;
    expect(resolveInputRefs(b, new Map([['a', a]])))
      .toEqual({ inputRefs: { bundle: 'pangolin://ns/artifact/d/sha256:cc' } });
  });

  it('resolves multiple bindings in one call', () => {
    const a = { ...base, id: 'a', resultRef: 'ref-a' } as ItemState;
    const c = { ...base, id: 'c', outputRefs: { 'out.txt': 'ref-c' } } as ItemState;
    const b = {
      ...base, id: 'b', status: 'pending' as const,
      needs: {
        patch: { from: 'a', select: { kind: 'patch' as const } },
        out: { from: 'c', select: { kind: 'output' as const, path: 'out.txt' } },
      },
    } as unknown as ItemState;
    expect(resolveInputRefs(b, new Map([['a', a], ['c', c]])))
      .toEqual({ inputRefs: { patch: 'ref-a', out: 'ref-c' } });
  });

  it('returns an error when the from id is unknown', () => {
    const b = { ...base, id: 'b', status: 'pending' as const, needs: { patch: { from: 'missing', select: { kind: 'patch' as const } } } } as unknown as ItemState;
    const result = resolveInputRefs(b, new Map());
    expect(result).toEqual({ error: expect.stringContaining('patch') });
    expect((result as { error: string }).error).toContain('missing');
  });

  it('returns an error naming the key when the selected product is absent (patch case)', () => {
    const a = { ...base, id: 'a' } as ItemState; // no resultRef
    const b = { ...base, id: 'b', status: 'pending' as const, needs: { patch: { from: 'a', select: { kind: 'patch' as const } } } } as unknown as ItemState;
    expect(resolveInputRefs(b, new Map([['a', a]]))).toEqual({ error: expect.stringContaining('patch') });
  });

  it('returns an error naming the key when the selected product is absent (output case)', () => {
    const a = { ...base, id: 'a', outputRefs: {} } as ItemState;
    const b = { ...base, id: 'b', status: 'pending' as const, needs: { bundle: { from: 'a', select: { kind: 'output' as const, path: 'missing-path' } } } } as unknown as ItemState;
    const result = resolveInputRefs(b, new Map([['a', a]]));
    expect(result).toEqual({ error: expect.stringContaining('bundle') });
  });

  it('returns { inputRefs: {} } for an item with no needs field', () => {
    const b = { ...base, id: 'b', status: 'pending' as const } as ItemState;
    expect(resolveInputRefs(b, new Map())).toEqual({ inputRefs: {} });
  });

  it('returns { inputRefs: {} } for an item with an empty needs object', () => {
    const b = { ...base, id: 'b', status: 'pending' as const, needs: {} } as unknown as ItemState;
    expect(resolveInputRefs(b, new Map())).toEqual({ inputRefs: {} });
  });

  it('never throws — unknown upstream returns error object not exception', () => {
    const b = { ...base, id: 'b', status: 'pending' as const, needs: { x: { from: 'ghost', select: { kind: 'patch' as const } } } } as unknown as ItemState;
    expect(() => resolveInputRefs(b, new Map())).not.toThrow();
  });
});
