import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify, createPublicKey } from 'node:crypto';
import type { Signer, Signature } from '../contracts/index.js';

export const NoneSigner: Signer = { async sign() { return { alg: 'none', bytes: new Uint8Array(0) }; } };

/** ed25519 local signer; public key exported SPKI-DER (Mneme baseline). */
export function createLocalSigner(keyRef = 'local'): Signer & { publicKey: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    keyRef,
    publicKey: publicKey.export({ type: 'spki', format: 'der' }) as Buffer,
    async sign(root: Uint8Array): Promise<Signature> {
      return { alg: 'ed25519', bytes: new Uint8Array(nodeSign(null, Buffer.from(root), privateKey)), keyRef };
    },
  };
}

/** Verify an ed25519 signature over the root against an SPKI-DER public key. */
export function verifyEd25519(root: Uint8Array, sig: Signature, spkiDer: Uint8Array): boolean {
  if (sig.alg !== 'ed25519') return false;
  try {
    const key = createPublicKey({ key: Buffer.from(spkiDer), format: 'der', type: 'spki' });
    return nodeVerify(null, Buffer.from(root), key, Buffer.from(sig.bytes));
  } catch {
    return false;
  }
}
