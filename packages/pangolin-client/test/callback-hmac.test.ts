import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { mintCallbackHmac, signCallback } from '../src/callback-hmac.js';

describe('signCallback', () => {
  it('produces a stable HMAC-SHA256 hex over dispatchId.timestamp.payload', () => {
    const sig = signCallback({
      hmacKey: 'k' + 'a'.repeat(63),
      dispatchId: 'd1',
      timestampIso: '2026-05-21T12:00:00Z',
      payload: '{"kind":"dispatch.finished"}',
    });
    expect(sig).toMatch(/^[0-9a-f]{64}$/);

    // Stable: same inputs → same signature
    const sig2 = signCallback({
      hmacKey: 'k' + 'a'.repeat(63),
      dispatchId: 'd1',
      timestampIso: '2026-05-21T12:00:00Z',
      payload: '{"kind":"dispatch.finished"}',
    });
    expect(sig2).toBe(sig);
  });

  it('matches an independent HMAC-SHA256 computation of dispatchId.timestamp.payload', () => {
    const hmacKey = 'super-secret-key';
    const dispatchId = 'dispatch-42';
    const timestampIso = '2026-05-21T13:14:15Z';
    const payload = '{"hello":"world"}';

    const sig = signCallback({ hmacKey, dispatchId, timestampIso, payload });

    const expected = createHmac('sha256', hmacKey)
      .update(`${dispatchId}.${timestampIso}.${payload}`)
      .digest('hex');
    expect(sig).toBe(expected);
  });

  it('produces a different signature when any field changes', () => {
    const base = {
      hmacKey: 'key',
      dispatchId: 'd1',
      timestampIso: '2026-05-21T12:00:00Z',
      payload: 'p',
    };
    const sigBase = signCallback(base);
    expect(signCallback({ ...base, hmacKey: 'different' })).not.toBe(sigBase);
    expect(signCallback({ ...base, dispatchId: 'd2' })).not.toBe(sigBase);
    expect(signCallback({ ...base, timestampIso: '2026-05-21T12:00:01Z' })).not.toBe(sigBase);
    expect(signCallback({ ...base, payload: 'q' })).not.toBe(sigBase);
  });
});

/**
 * Minimal fake SecretStore for testing mintCallbackHmac.
 */
function makeFakeStore(ref = 'local-secret://test-key') {
  const staged: unknown[] = [];
  const store = {
    name: 'fake',
    stage: async (args: unknown) => {
      staged.push(args);
      const ttlSeconds = (args as { ttlSeconds: number }).ttlSeconds;
      return { ref, ttlSeconds };
    },
    resolve: async () => '',
    cleanupByTag: async () => {},
  };
  return { store, staged };
}

describe('mintCallbackHmac', () => {
  it('stages the HMAC key via the injected store and returns its ref', async () => {
    const { store, staged } = makeFakeStore('local-secret://k');
    const { ref } = await mintCallbackHmac({ store: store as never, dispatchId: 'd1' });
    expect(ref).toBe('local-secret://k');
    expect(staged).toHaveLength(1);
  });

  it('returns ttlSeconds equal to dispatchTimeoutSeconds + 300 (5min buffer)', async () => {
    const { store } = makeFakeStore();
    const result = await mintCallbackHmac({
      store: store as never,
      dispatchId: 'dispatch-1',
      dispatchTimeoutSeconds: 3600,
    });
    expect(result.ttlSeconds).toBe(3900);
  });

  it('defaults ttlSeconds to 7200+300 when no dispatchTimeoutSeconds given', async () => {
    const { store } = makeFakeStore();
    const result = await mintCallbackHmac({
      store: store as never,
      dispatchId: 'dispatch-1',
    });
    expect(result.ttlSeconds).toBe(7500);
  });

  it('stages with name pangolin/callback-hmac/<dispatchId>', async () => {
    const { store, staged } = makeFakeStore();
    await mintCallbackHmac({
      store: store as never,
      dispatchId: 'dispatch-xyz',
    });
    expect(staged).toHaveLength(1);
    expect((staged[0] as { name: string }).name).toBe('pangolin/callback-hmac/dispatch-xyz');
  });

  it('uses a custom namePrefix when provided', async () => {
    const { store, staged } = makeFakeStore();
    await mintCallbackHmac({
      store: store as never,
      namePrefix: 'my/prefix',
      dispatchId: 'd9',
    });
    expect((staged[0] as { name: string }).name).toBe('my/prefix/d9');
  });

  it('stages a 64-char hex (32-byte) random key as the value', async () => {
    const { store, staged } = makeFakeStore();
    await mintCallbackHmac({
      store: store as never,
      dispatchId: 'dispatch-1',
    });
    const value = (staged[0] as { value: string }).value;
    expect(value).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates a fresh key on each invocation', async () => {
    const { store, staged } = makeFakeStore();
    await mintCallbackHmac({ store: store as never, dispatchId: 'a' });
    await mintCallbackHmac({ store: store as never, dispatchId: 'b' });
    const key1 = (staged[0] as { value: string }).value;
    const key2 = (staged[1] as { value: string }).value;
    expect(key1).not.toBe(key2);
  });

  it('tags the secret with pangolin:dispatchId', async () => {
    const { store, staged } = makeFakeStore();
    await mintCallbackHmac({
      store: store as never,
      dispatchId: 'dispatch-tagged',
      dispatchTimeoutSeconds: 1800,
    });
    const tags = (staged[0] as { tags: Record<string, string> }).tags;
    expect(tags).toMatchObject({ 'pangolin:dispatchId': 'dispatch-tagged' });
  });
});
