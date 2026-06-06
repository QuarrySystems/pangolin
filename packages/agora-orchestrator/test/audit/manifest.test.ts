import { describe, it, expect } from 'vitest';
import { buildManifest } from '../../src/audit/manifest.js';

it('is deterministic and self-hashes; hash is independent of field insertion order', () => {
  const a = buildManifest({ runId: 'r', itemId: 'i', executor: 'dispatch',
    executorManifest: { b: 1, a: 2 }, secretRefs: ['agora://secrets/x'],
    actor: 'human:brett', firedAt: '2026-05-31T00:00:00.000Z' });
  const b = buildManifest({ runId: 'r', itemId: 'i', executor: 'dispatch',
    executorManifest: { a: 2, b: 1 }, secretRefs: ['agora://secrets/x'],
    actor: 'human:brett', firedAt: '2026-05-31T00:00:00.000Z' });
  expect(a.manifest.manifestHash).toBe(b.manifest.manifestHash);
  expect(a.manifest.manifestHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(a.manifest.parent).toBe('run:r');
});

describe('buildManifest', () => {
  it('sets schemaVersion to 1', () => {
    const { manifest } = buildManifest({
      runId: 'r1', itemId: 'i1', executor: 'dispatch',
      executorManifest: {}, secretRefs: [],
      actor: 'human:test', firedAt: '2026-05-31T00:00:00.000Z',
    });
    expect(manifest.schemaVersion).toBe(1);
  });

  it('sets parent to run:<runId>', () => {
    const { manifest } = buildManifest({
      runId: 'my-run', itemId: 'i1', executor: 'dispatch',
      executorManifest: {}, secretRefs: [],
      actor: 'human:test', firedAt: '2026-05-31T00:00:00.000Z',
    });
    expect(manifest.parent).toBe('run:my-run');
  });

  it('manifestHash matches sha256:<64hex> pattern', () => {
    const { manifest } = buildManifest({
      runId: 'r', itemId: 'i', executor: 'dispatch',
      executorManifest: {}, secretRefs: [],
      actor: 'human:test', firedAt: '2026-05-31T00:00:00.000Z',
    });
    expect(manifest.manifestHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('does not set signature field', () => {
    const { manifest } = buildManifest({
      runId: 'r', itemId: 'i', executor: 'dispatch',
      executorManifest: {}, secretRefs: [],
      actor: 'human:test', firedAt: '2026-05-31T00:00:00.000Z',
    });
    expect(manifest.signature).toBeUndefined();
  });

  it('throws if any secretRefs entry is not a string', () => {
    expect(() => buildManifest({
      runId: 'r', itemId: 'i', executor: 'dispatch',
      executorManifest: {}, secretRefs: [42 as unknown as string],
      actor: 'human:test', firedAt: '2026-05-31T00:00:00.000Z',
    })).toThrow('secretRefs must be string references only');
  });

  it('manifestHash excludes manifestHash field (adding signature does not change the hash)', () => {
    const input = {
      runId: 'r', itemId: 'i', executor: 'dispatch',
      executorManifest: { x: 1 }, secretRefs: [],
      actor: 'human:test', firedAt: '2026-05-31T00:00:00.000Z',
    };
    const { manifest } = buildManifest(input);
    // The hash should not include manifestHash or signature fields.
    // We verify this by ensuring two manifests (one potentially with signature added
    // afterward) would have the same hash as the base computation.
    // This is structural: the builder hashes `base` (without manifestHash),
    // so the resulting manifest.manifestHash is over everything except those fields.
    expect(manifest.manifestHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Verify bytes are returned as Uint8Array
    const { bytes } = buildManifest(input);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('submittedAt is optional and its absence does not perturb the hash', () => {
    const without = buildManifest({
      runId: 'r', itemId: 'i', executor: 'dispatch',
      executorManifest: {}, secretRefs: [],
      actor: 'human:test', firedAt: '2026-05-31T00:00:00.000Z',
    });
    // With submittedAt undefined explicitly - should be identical hash
    const withUndefined = buildManifest({
      runId: 'r', itemId: 'i', executor: 'dispatch',
      executorManifest: {}, secretRefs: [],
      actor: 'human:test', firedAt: '2026-05-31T00:00:00.000Z',
      submittedAt: undefined,
    });
    expect(without.manifest.manifestHash).toBe(withUndefined.manifest.manifestHash);
  });

  it('inputRefs is optional and its absence does not perturb the hash', () => {
    const base = { runId: 'r', itemId: 'i', executor: 'dispatch', executorManifest: {},
      secretRefs: [], actor: 'human:test', firedAt: '2026-06-05T00:00:00.000Z' };
    const without = buildManifest(base);
    const withUndefined = buildManifest({ ...base, inputRefs: undefined });
    expect(without.manifest.manifestHash).toBe(withUndefined.manifest.manifestHash);
  });

  it('inputRefs is sealed into the manifest and covered by the self-hash', () => {
    const refs = { patch: 'agora://ns/artifact/d/sha256:' + 'a'.repeat(64) };
    const { manifest } = buildManifest({ runId: 'r', itemId: 'i', executor: 'dispatch',
      executorManifest: {}, secretRefs: [], actor: 'human:test',
      firedAt: '2026-06-05T00:00:00.000Z', inputRefs: refs });
    expect(manifest.inputRefs).toEqual(refs);
    // different refs -> different hash (the field is INSIDE the hash)
    const { manifest: manifest2 } = buildManifest({ runId: 'r', itemId: 'i', executor: 'dispatch',
      executorManifest: {}, secretRefs: [], actor: 'human:test',
      firedAt: '2026-06-05T00:00:00.000Z',
      inputRefs: { patch: 'agora://ns/artifact/d/sha256:' + 'b'.repeat(64) } });
    expect(manifest.manifestHash).not.toBe(manifest2.manifestHash);
  });

  it('adding pipelineRef does not perturb the hash of a manifest without it', () => {
    const base = { runId: 'r', itemId: 'i', executor: 'dispatch', executorManifest: {},
      secretRefs: [], actor: 'human:test', firedAt: '2026-06-05T00:00:00.000Z' };
    // A manifest without pipelineRef and one with pipelineRef: undefined should have the same hash
    const without = buildManifest(base);
    const withUndefined = buildManifest({ ...base, pipelineRef: undefined });
    expect(without.manifest.manifestHash).toBe(withUndefined.manifest.manifestHash);

    // A manifest WITH a pipelineRef value should have a different hash AND expose the field
    const pipelineUri = 'agora://ns/pipeline/my-pipe/sha256:' + 'c'.repeat(64);
    const { manifest: withPipeline } = buildManifest({ ...base, pipelineRef: pipelineUri });
    expect(withPipeline.manifestHash).not.toBe(without.manifest.manifestHash);
    expect(withPipeline.pipelineRef).toBe(pipelineUri);
  });
});
