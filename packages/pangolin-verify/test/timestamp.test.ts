import { it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { LocalCaTimestampAuthority, verifyTimestamp } from '../src/timestamp-authority.js';

it('local-CA TSA issues a token that verifyTimestamp accepts for the same root', async () => {
  const tsa = new LocalCaTimestampAuthority();
  const root = createHash('sha256').update('root').digest();
  const token = await tsa.timestamp(root);
  expect(verifyTimestamp(root, token, [tsa.caCertDer])).toBe(true);
});
it('verifyTimestamp rejects a token whose messageImprint != root', async () => {
  const tsa = new LocalCaTimestampAuthority();
  const token = await tsa.timestamp(createHash('sha256').update('root').digest());
  const otherRoot = createHash('sha256').update('different').digest();
  expect(verifyTimestamp(otherRoot, token, [tsa.caCertDer])).toBe(false);
});
it('verifyTimestamp rejects a token signed by an untrusted CA', async () => {
  const tsaA = new LocalCaTimestampAuthority();
  const tsaB = new LocalCaTimestampAuthority();
  const root = createHash('sha256').update('root').digest();
  const token = await tsaA.timestamp(root);
  expect(verifyTimestamp(root, token, [tsaB.caCertDer])).toBe(false);
});
