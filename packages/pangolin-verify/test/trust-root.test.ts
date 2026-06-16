import { describe, it, expect } from 'vitest';
import { resolveKey, parseTrustRoot, type TrustRoot } from '../src/trust-root.js';

const tr: TrustRoot = {
  schemaVersion: 1,
  keys: {
    'k-active': {
      alg: 'ecdsa-p256',
      spkiDer: 'AAAA',
      status: 'active',
      notBefore: '2026-01-01T00:00:00Z',
      notAfter: null,
      revokedAt: null,
    },
    'k-revoked': {
      alg: 'ecdsa-p256',
      spkiDer: 'BBBB',
      status: 'revoked',
      notBefore: '2026-01-01T00:00:00Z',
      notAfter: null,
      revokedAt: '2026-06-01T00:00:00Z',
    },
  },
};

describe('resolveKey', () => {
  it('resolves an active key by keyRef', () => {
    expect(resolveKey(tr, 'k-active')?.status).toBe('active');
    expect(resolveKey(tr, 'k-active')?.alg).toBe('ecdsa-p256');
  });
  it('resolves a revoked key (status carried through; decision is the revocation layer)', () => {
    expect(resolveKey(tr, 'k-revoked')?.revokedAt).toBe('2026-06-01T00:00:00Z');
  });
  it('returns undefined for an unknown keyRef', () => {
    expect(resolveKey(tr, 'nope')).toBeUndefined();
  });
  it('returns undefined for an undefined keyRef', () => {
    expect(resolveKey(tr, undefined)).toBeUndefined();
  });
});

describe('parseTrustRoot (validate an UNTRUSTED manifest — it is the security root)', () => {
  it('accepts a well-formed manifest', () => {
    expect(parseTrustRoot(JSON.stringify(tr)).keys['k-active'].alg).toBe('ecdsa-p256');
  });
  it('rejects unknown schemaVersion', () => {
    expect(() => parseTrustRoot(JSON.stringify({ schemaVersion: 2, keys: {} }))).toThrow(
      /schemaVersion/,
    );
  });
  it('rejects a non-enum alg', () => {
    expect(() =>
      parseTrustRoot(
        JSON.stringify({
          schemaVersion: 1,
          keys: {
            k: { alg: 'rsa', spkiDer: 'AA', status: 'active', notBefore: '2026-01-01T00:00:00Z' },
          },
        }),
      ),
    ).toThrow(/alg/);
  });
  it('rejects a revoked entry missing revokedAt', () => {
    expect(() =>
      parseTrustRoot(
        JSON.stringify({
          schemaVersion: 1,
          keys: {
            k: {
              alg: 'ed25519',
              spkiDer: 'AA',
              status: 'revoked',
              notBefore: '2026-01-01T00:00:00Z',
            },
          },
        }),
      ),
    ).toThrow(/revokedAt/);
  });
  it('rejects a non-strict (offset-less) ISO timestamp', () => {
    expect(() =>
      parseTrustRoot(
        JSON.stringify({
          schemaVersion: 1,
          keys: {
            k: {
              alg: 'ed25519',
              spkiDer: 'AA',
              status: 'active',
              notBefore: '2026-01-01 00:00:00',
            },
          },
        }),
      ),
    ).toThrow(/notBefore|ISO/);
  });
  it('rejects malformed JSON', () => {
    expect(() => parseTrustRoot('{not json')).toThrow();
  });
});
