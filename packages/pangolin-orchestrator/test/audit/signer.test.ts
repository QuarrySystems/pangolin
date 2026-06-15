import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createLocalSigner,
  createLocalEcdsaSigner,
  verifyEd25519,
  verifyEcdsaP256,
  NoneSigner,
} from '../../src/audit/signer.js';

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
  expect(await NoneSigner.sign(new Uint8Array(32))).toEqual({
    alg: 'none',
    bytes: new Uint8Array(0),
  });
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

it('LocalEcdsaSigner round-trips; tampered root fails', async () => {
  const s = createLocalEcdsaSigner('ec-local');
  const root = new Uint8Array(32).fill(7);
  const sig = await s.sign(root);
  expect(sig.alg).toBe('ecdsa-p256');
  expect(sig.keyRef).toBe('ec-local');
  expect(verifyEcdsaP256(root, sig, s.publicKey)).toBe(true);
  expect(verifyEcdsaP256(new Uint8Array(32).fill(8), sig, s.publicKey)).toBe(false);
});

it('verifyEcdsaP256 rejects a non-ecdsa-p256 alg (alg guard)', async () => {
  const ed = createLocalSigner();
  const root = new Uint8Array(32).fill(7);
  const edSig = await ed.sign(root); // alg 'ed25519'
  const ec = createLocalEcdsaSigner();
  expect(verifyEcdsaP256(root, edSig, ec.publicKey)).toBe(false);
});

it('verifyEcdsaP256 wrong-key and malformed SPKI return false without throwing', async () => {
  const a = createLocalEcdsaSigner('a');
  const b = createLocalEcdsaSigner('b');
  const root = new Uint8Array(32).fill(42);
  const sig = await a.sign(root);
  expect(verifyEcdsaP256(root, sig, b.publicKey)).toBe(false);
  expect(verifyEcdsaP256(root, sig, new Uint8Array([1, 2, 3]))).toBe(false);
});
