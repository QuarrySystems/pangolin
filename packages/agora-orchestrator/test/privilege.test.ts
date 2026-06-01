import { PRIVILEGE, isMcpEligible } from '../src/contracts/privilege.js';
import { it, expect, describe } from 'vitest';

describe('PRIVILEGE registry', () => {
  it('contains entries for exactly submit|status|watch|cancel|audit|serve|tick', () => {
    const expectedMethods = ['submit', 'status', 'watch', 'cancel', 'audit', 'serve', 'tick'];
    const actualMethods = Object.keys(PRIVILEGE).sort();
    expect(actualMethods).toEqual(expectedMethods.sort());
  });

  it('keeps privileged and service methods off the MCP surface', () => {
    expect(isMcpEligible('submit')).toBe(true);
    expect(isMcpEligible('cancel')).toBe(false); // privileged
    expect(isMcpEligible('serve')).toBe(false);  // service
    expect(isMcpEligible('audit')).toBe(false);  // client but CLI-only
  });

  it('returns true only for submit|status|watch', () => {
    expect(isMcpEligible('submit')).toBe(true);
    expect(isMcpEligible('status')).toBe(true);
    expect(isMcpEligible('watch')).toBe(true);
    expect(isMcpEligible('cancel')).toBe(false);
    expect(isMcpEligible('audit')).toBe(false);
    expect(isMcpEligible('serve')).toBe(false);
    expect(isMcpEligible('tick')).toBe(false);
  });

  it('mcp:true holds iff tag===client AND method is not audit', () => {
    for (const [method, policy] of Object.entries(PRIVILEGE)) {
      const expectedMcp = policy.tag === 'client' && method !== 'audit';
      expect(policy.mcp).toBe(expectedMcp);
    }
  });

  it('returns false for unknown methods', () => {
    expect(isMcpEligible('unknown')).toBe(false);
  });
});
