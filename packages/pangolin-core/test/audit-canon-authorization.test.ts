import { describe, it, expect } from 'vitest';
import { canonEntry } from '../src/audit-canon.js';
import type { AuditEntry, Authorization } from '../src/audit.js';

const base: AuditEntry = { runId: 'r', seq: 3, kind: 'item.fired', itemId: 'a', at: 't' };

describe('canonEntry authorization', () => {
  it('an entry WITHOUT authorization is byte-identical to the legacy 9-field form', () => {
    expect(canonEntry(base)).toBe(
      JSON.stringify(['item.fired', 'r', 'a', null, null, null, null, 't', 3]),
    );
  });
  it('an item.denied entry WITH authorization appends a 10th element', () => {
    const authz: Authorization = {
      verdict: 'deny',
      principal: 'op:policy',
      policyRef: 'sha256:p',
      effectClass: 'write-impure',
      reason: 'blocked',
      at: 't2',
    };
    const denied: AuditEntry = { ...base, kind: 'item.denied', authorization: authz };
    const s = canonEntry(denied);
    expect(s).not.toBe(canonEntry({ ...denied, authorization: undefined }));
    expect(JSON.parse(s).length).toBe(10);
  });
  it('the appended element is stable under key reordering (canonicalized)', () => {
    const a1: Authorization = {
      verdict: 'deny',
      principal: 'p',
      policyRef: 'r',
      effectClass: 'pure',
      at: 't',
    };
    const a2 = {
      at: 't',
      effectClass: 'pure',
      policyRef: 'r',
      principal: 'p',
      verdict: 'deny',
    } as Authorization;
    expect(canonEntry({ ...base, authorization: a1 })).toBe(
      canonEntry({ ...base, authorization: a2 }),
    );
  });
});
