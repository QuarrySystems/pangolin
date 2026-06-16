import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  Authorization,
  AuthorizationContext,
  Authorizer,
  AuthorizationVerdict,
  AuthzTier,
  DispatchManifest,
  AuditEntry,
  AuditEntryKind,
  VerificationReport,
} from '../src/audit.js';

describe('authorization type surface', () => {
  it('Authorization has the sealed-evidence shape', () => {
    const a: Authorization = {
      verdict: 'allow',
      principal: 'op:policy',
      policyRef: 'sha256:x',
      effectClass: 'pure',
      at: '2026-06-16T00:00:00Z',
    };
    expect(a.verdict).toBe('allow');
  });
  it('manifest + entry carry optional authorization; item.denied is a kind', () => {
    const k: AuditEntryKind = 'item.denied';
    expect(k).toBe('item.denied');
    expectTypeOf<DispatchManifest['authorization']>().toEqualTypeOf<Authorization | undefined>();
    expectTypeOf<AuditEntry['authorization']>().toEqualTypeOf<Authorization | undefined>();
  });
  it('report gains optional authzTier and a manifest failure variant', () => {
    const t: AuthzTier = 'recorded';
    expect(t).toBe('recorded');
    expectTypeOf<VerificationReport['authzTier']>().toEqualTypeOf<AuthzTier | undefined>();
    const f: NonNullable<VerificationReport['failure']> = 'manifest';
    expect(f).toBe('manifest');
  });
  it('Authorizer is an async (ctx) => Authorization', () => {
    const _a: Authorizer = {
      async authorize(_c: AuthorizationContext) {
        return {
          verdict: 'not-evaluated' as AuthorizationVerdict,
          principal: 'none',
          policyRef: 'none',
          effectClass: 'pure',
          at: '',
        };
      },
    };
    expect(typeof _a.authorize).toBe('function');
  });
});
