import { describe, it, expect } from 'vitest';
import { keyUsableAt } from '../src/revocation.js';
import type { TrustRootKey } from '../src/trust-root.js';

const active: TrustRootKey = {
  alg: 'ecdsa-p256',
  spkiDer: 'x',
  status: 'active',
  notBefore: '2026-01-01T00:00:00Z',
  notAfter: null,
  revokedAt: null,
};
const windowed: TrustRootKey = {
  ...active,
  notBefore: '2026-03-01T00:00:00Z',
  notAfter: '2026-09-01T00:00:00Z',
};
const revoked: TrustRootKey = { ...active, status: 'revoked', revokedAt: '2026-06-01T00:00:00Z' };

describe('keyUsableAt', () => {
  it('active, no verified time: usable (window advisory without trusted time)', () => {
    expect(keyUsableAt(active, undefined)).toBe(true);
  });
  it('active within window (verified time): usable', () => {
    expect(keyUsableAt(windowed, new Date('2026-05-01T00:00:00Z'))).toBe(true);
  });
  it('active before notBefore / after notAfter (verified time): NOT usable', () => {
    expect(keyUsableAt(windowed, new Date('2026-02-01T00:00:00Z'))).toBe(false);
    expect(keyUsableAt(windowed, new Date('2026-10-01T00:00:00Z'))).toBe(false);
  });
  it('revoked + no verified genTime (asserted only): hard-fail', () => {
    expect(keyUsableAt(revoked, undefined)).toBe(false);
  });
  it('revoked + verified genTime strictly before revokedAt: usable', () => {
    expect(keyUsableAt(revoked, new Date('2026-05-31T23:59:59Z'))).toBe(true);
  });
  it('revoked + verified genTime at/after revokedAt: fail', () => {
    expect(keyUsableAt(revoked, new Date('2026-06-01T00:00:00Z'))).toBe(false);
    expect(keyUsableAt(revoked, new Date('2026-06-02T00:00:00Z'))).toBe(false);
  });
});
