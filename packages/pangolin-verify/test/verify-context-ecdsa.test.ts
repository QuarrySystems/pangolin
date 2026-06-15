import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign, createPublicKey } from 'node:crypto';
import { makeVerifySignature, type VerifyContext } from '../src/verify-context.js';

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
