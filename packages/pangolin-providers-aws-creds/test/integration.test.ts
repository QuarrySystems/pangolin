// Integration tests for `AwsCredentialProvider`.
//
// These tests verify the provider's contract against an injected fake
// credential source. No live AWS calls are made: the integrator's local
// AWS chain may or may not be configured in CI, and the provider's
// contract is the AWS-SDK-shape contract, not the live-chain contract.
//
// Note: there is some overlap with `smoke.test.ts` (which already covers
// sessionToken propagation and error propagation). The spec for this
// integration suite is the contract, so the spec's three cases are
// reproduced here verbatim — duplication with smoke is intentional.

import { AwsCredentialProvider } from '../src/index.js';
import { it, describe, expect } from 'vitest';

describe('AwsCredentialProvider', () => {
  it('propagates sessionToken when the underlying provider returns one', async () => {
    const provider = new AwsCredentialProvider({
      providerOverride: async () => ({
        accessKeyId: 'AKIA-test',
        secretAccessKey: 'secret-test',
        sessionToken: 'session-test',
      }),
    });
    const resolved = await provider.resolve();
    expect(resolved.sessionToken).toBe('session-test');
  });

  it('propagates errors from the underlying provider', async () => {
    const provider = new AwsCredentialProvider({
      providerOverride: async () => {
        throw new Error('chain not configured');
      },
    });
    await expect(provider.resolve()).rejects.toThrow('chain not configured');
  });

  it('wires the default chain when no override is supplied', () => {
    // Construction with no override should not throw even if the local
    // environment has no AWS chain configured — the provider wires
    // `fromNodeProviderChain()` lazily (invoked on `resolve()`), not as
    // a synchronous resolution call at construction time.
    expect(() => new AwsCredentialProvider()).not.toThrow();
  });
});
