import { describe, it, expect } from 'vitest';
import {
  LocalCaTimestampAuthority,
  verifyTimestamp,
  verifyTimestampWithTime,
} from '../src/timestamp-authority.js';

describe('verifyTimestampWithTime', () => {
  it('returns ok:true and the authoritative genTime for a valid token', async () => {
    const tsa = new LocalCaTimestampAuthority();
    const root = new Uint8Array(32).fill(11);
    const token = await tsa.timestamp(root);
    const r = verifyTimestampWithTime(root, token, [tsa.caCertDer]);
    expect(r.ok).toBe(true);
    expect(r.genTime instanceof Date).toBe(true);
    expect(verifyTimestamp(root, token, [tsa.caCertDer])).toBe(true); // wrapper agrees
  });
  it('returns ok:false and no genTime for an untrusted token', async () => {
    const tsa = new LocalCaTimestampAuthority();
    const root = new Uint8Array(32).fill(11);
    const token = await tsa.timestamp(root);
    const r = verifyTimestampWithTime(root, token, []); // no trust anchor
    expect(r.ok).toBe(false);
    expect(r.genTime).toBeUndefined();
  });
});
