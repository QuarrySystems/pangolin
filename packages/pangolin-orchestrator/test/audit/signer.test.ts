import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalSigner, verifyEd25519, NoneSigner } from '../../src/audit/signer.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const vectorDir = resolve(__dirname, '../conformance/audit-vectors');
const vec = JSON.parse(readFileSync(resolve(vectorDir, 'sign-ed25519.json'), 'utf8'));

it('LocalSigner round-trips; tampered root fails', async () => {
  const s = createLocalSigner();
  const root = new Uint8Array(32).fill(7);
  const sig = await s.sign(root);
  expect(sig.alg).toBe('ed25519');
  expect(verifyEd25519(root, sig, s.publicKey)).toBe(true);
  expect(verifyEd25519(new Uint8Array(32).fill(8), sig, s.publicKey)).toBe(false);
});

it('NoneSigner emits an empty none-signature', async () => {
  expect(await NoneSigner.sign(new Uint8Array(32))).toEqual({ alg: 'none', bytes: new Uint8Array(0) });
});

it('frozen vector: the pinned signature verifies, a wrong root does not', () => {
  const root = Uint8Array.from(Buffer.from(vec.rootHex, 'hex'));
  const sig = { alg: 'ed25519', bytes: Uint8Array.from(Buffer.from(vec.signatureHex, 'hex')) };
  const pub = Uint8Array.from(Buffer.from(vec.publicKeySpkiDerHex, 'hex'));
  expect(verifyEd25519(root, sig, pub)).toBe(true);
  expect(verifyEd25519(new Uint8Array(32).fill(1), sig, pub)).toBe(false);
});

it('wrong-key: signature from signer A does not verify against signer B public key', async () => {
  const signerA = createLocalSigner('a');
  const signerB = createLocalSigner('b');
  const root = new Uint8Array(32).fill(42);
  const sig = await signerA.sign(root);
  expect(verifyEd25519(root, sig, signerB.publicKey)).toBe(false);
});

it('malformed SPKI bytes return false without throwing', async () => {
  const s = createLocalSigner();
  const root = new Uint8Array(32).fill(7);
  const sig = await s.sign(root);
  expect(verifyEd25519(root, sig, new Uint8Array([1, 2, 3]))).toBe(false);
});
