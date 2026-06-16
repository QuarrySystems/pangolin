import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign, createPublicKey } from 'node:crypto';
import {
  makeVerifySignature,
  makeVerifySignatureFromTrustRoot,
  type VerifyContext,
} from '../src/verify-context.js';
import type { TrustRoot } from '../src/trust-root.js';

function localEcdsa(keyRef: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    keyRef,
    publicKeySpki: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' })),
    sign(root: Uint8Array) {
      return {
        alg: 'ecdsa-p256',
        bytes: new Uint8Array(nodeSign('sha256', Buffer.from(root), privateKey)),
        keyRef,
      };
    },
  };
}

describe('makeVerifySignature alg dispatch', () => {
  it('verifies an ecdsa-p256 signature against the configured P-256 SPKI key', () => {
    const s = localEcdsa('ec1');
    const root = new Uint8Array(32).fill(9);
    const sig = s.sign(root);
    const ctx = {
      signerPublicKey: createPublicKey({
        key: Buffer.from(s.publicKeySpki),
        format: 'der',
        type: 'spki',
      }),
      anchor: { mode: 'offline' },
      tsaCaCertsDer: [],
    } as unknown as VerifyContext;
    const verify = makeVerifySignature(ctx)!;
    expect(verify(root, sig)).toBe(true);
    expect(verify(new Uint8Array(32).fill(8), sig)).toBe(false);
  });

  it('returns undefined when no signer key is configured (→ core n/a)', () => {
    const ctx = { anchor: { mode: 'offline' }, tsaCaCertsDer: [] } as unknown as VerifyContext;
    expect(makeVerifySignature(ctx)).toBeUndefined();
  });
});

function activeTrustRoot(
  keyRef: string,
  spki: Uint8Array,
  alg: 'ed25519' | 'ecdsa-p256' = 'ecdsa-p256',
): TrustRoot {
  return {
    schemaVersion: 1,
    keys: {
      [keyRef]: {
        alg,
        spkiDer: Buffer.from(spki).toString('base64'),
        status: 'active',
        notBefore: '2026-01-01T00:00:00Z',
        notAfter: null,
        revokedAt: null,
      },
    },
  };
}

describe('makeVerifySignatureFromTrustRoot', () => {
  it('known keyRef verifies; unknown keyRef hard-fails; no trust root → undefined', () => {
    const s = localEcdsa('k-active');
    const root = new Uint8Array(32).fill(3);
    const sig = s.sign(root);
    const verify = makeVerifySignatureFromTrustRoot(activeTrustRoot('k-active', s.publicKeySpki))!;
    expect(verify(root, sig)).toBe(true);
    expect(verify(root, { ...sig, keyRef: 'ghost' })).toBe(false); // unknown keyRef = hard fail
    expect(makeVerifySignatureFromTrustRoot(undefined)).toBeUndefined();
  });
  it('entry alg must match sig alg', () => {
    const s = localEcdsa('k-active');
    const root = new Uint8Array(32).fill(3);
    const sig = s.sign(root); // alg ecdsa-p256
    const verify = makeVerifySignatureFromTrustRoot(
      activeTrustRoot('k-active', s.publicKeySpki, 'ed25519'),
    )!;
    expect(verify(root, sig)).toBe(false); // alg mismatch
  });
});
