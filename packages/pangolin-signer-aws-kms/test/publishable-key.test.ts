import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { publishablePublicKey } from '../src/index.js';

describe('publishablePublicKey', () => {
  it('returns a manifest entry with base64 SPKI-DER and alg ecdsa-p256', async () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const spki = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }));
    const fake = {
      async send() {
        return { PublicKey: spki, KeySpec: 'ECC_NIST_P256' };
      },
    };
    const entry = await publishablePublicKey({
      keyId: 'arn:...',
      keyRef: 'pangolin-prod-2026',
      client: fake as never,
    });
    expect(entry.keyRef).toBe('pangolin-prod-2026');
    expect(entry.alg).toBe('ecdsa-p256');
    expect(entry.spkiDer).toBe(Buffer.from(spki).toString('base64'));
  });
});
