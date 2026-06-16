import { describe, it, expect } from 'vitest';
import {
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
} from 'node:crypto';
import { createKmsSigner } from '../src/index.js';

// A fake KMS client: signs locally with a P-256 key and returns a DER signature, exactly as
// KMS ECC_NIST_P256 / ECDSA_SHA_256 / MessageType:RAW does. The real `new SignCommand(input)`
// exposes its params on `.input` — assert on that (the genuine SDK shape).
function fakeKmsClient() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    spkiDer: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' })),
    async send(cmd: {
      input: { Message: Uint8Array; MessageType: string; SigningAlgorithm: string };
    }) {
      expect(cmd.input.MessageType).toBe('RAW');
      expect(cmd.input.SigningAlgorithm).toBe('ECDSA_SHA_256');
      const der = nodeSign('sha256', Buffer.from(cmd.input.Message), privateKey);
      return { Signature: new Uint8Array(der) };
    },
  };
}

describe('createKmsSigner', () => {
  it('produces an ecdsa-p256 Signature KMS-style; verifies against the KMS public key', async () => {
    const fake = fakeKmsClient();
    const signer = createKmsSigner({
      keyId: 'arn:aws:kms:...:key/abc',
      keyRef: 'pangolin-prod-2026',
      client: fake as never,
    });
    const root = new Uint8Array(32).fill(5);
    const sig = await signer.sign(root);
    expect(sig.alg).toBe('ecdsa-p256');
    expect(sig.keyRef).toBe('pangolin-prod-2026');
    const key = createPublicKey({ key: Buffer.from(fake.spkiDer), format: 'der', type: 'spki' });
    expect(nodeVerify('sha256', Buffer.from(root), key, Buffer.from(sig.bytes))).toBe(true);
  });
});
