import { describe, it, expect } from 'vitest';
import { NoneAuthorizer, createConfigAuthorizer } from '../../src/audit/authorizer.js';
import type { AuthorizationContext } from '@quarry-systems/pangolin-core';

const ctx = (over: Partial<AuthorizationContext> = {}): AuthorizationContext =>
  ({
    phase: 'fire',
    actor: 'agent:x',
    shapeId: 'dev.code-edit',
    effectClass: 'write-impure',
    at: '',
    ...over,
  }) as AuthorizationContext;

describe('NoneAuthorizer', () => {
  it('never blocks; verdict not-evaluated; echoes effectClass', async () => {
    const d = await NoneAuthorizer.authorize(ctx());
    expect(d.verdict).toBe('not-evaluated');
    expect(d.principal).toBe('none');
    expect(d.policyRef).toBe('none');
    expect(d.effectClass).toBe('write-impure');
  });
});

describe('createConfigAuthorizer', () => {
  const authz = createConfigAuthorizer({
    principal: 'op:acme',
    policyRef: 'sha256:rules',
    rules: [
      {
        deny: { effectClass: 'write-impure', actor: 'agent:untrusted' },
        reason: 'untrusted may not write',
      },
    ],
  });
  it('denies a matching rule with the matched effectClass + reason', async () => {
    const d = await authz.authorize(ctx({ actor: 'agent:untrusted' }));
    expect(d.verdict).toBe('deny');
    expect(d.effectClass).toBe('write-impure');
    expect(d.reason).toMatch(/untrusted/);
  });
  it('allows when no rule matches', async () => {
    expect((await authz.authorize(ctx({ actor: 'agent:trusted' }))).verdict).toBe('allow');
  });
});
