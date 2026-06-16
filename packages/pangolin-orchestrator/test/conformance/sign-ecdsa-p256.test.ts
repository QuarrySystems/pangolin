import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyEcdsaP256 } from '../../src/audit/signer.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const vec = JSON.parse(
  readFileSync(resolve(__dirname, 'audit-vectors/sign-ecdsa-p256.json'), 'utf8'),
);

it('frozen ecdsa-p256 vector: the pinned signature verifies, a wrong root does not', () => {
  const root = Uint8Array.from(Buffer.from(vec.rootHex, 'hex'));
  const sig = { alg: 'ecdsa-p256', bytes: Uint8Array.from(Buffer.from(vec.signatureHex, 'hex')) };
  const pub = Uint8Array.from(Buffer.from(vec.publicKeySpkiDerHex, 'hex'));
  expect(verifyEcdsaP256(root, sig, pub)).toBe(true);
  expect(verifyEcdsaP256(new Uint8Array(32).fill(1), sig, pub)).toBe(false);
});
