// The staged-secret naming contract (KNOWN-ISSUES 10).
//
// These names were an undeclared internal convention. They are now public, so
// a caller can build a least-privilege per-dispatch IAM policy against a shape
// it has a promise about. That promise is only worth anything if the dispatch
// path actually stages under these names — the last test pins exactly that, so
// the contract cannot drift away from the behaviour it describes.

import { describe, it, expect, vi } from 'vitest';
import {
  CALLBACK_HMAC_NAME_PREFIX,
  dispatchSecretName,
  callbackHmacSecretName,
  dispatchSecretPolicyPatterns,
} from '../src/secret-names.js';
import { mintCallbackHmac } from '../src/callback-hmac.js';
import type { SecretStore } from '@quarry-systems/pangolin-core';

describe('staged-secret naming contract', () => {
  it('names an inline dispatch secret <dispatchId>/<envName>', () => {
    expect(dispatchSecretName('d1', 'GH_TOKEN')).toBe('d1/GH_TOKEN');
  });

  it('names the callback HMAC key pangolin/callback-hmac/<dispatchId>', () => {
    expect(callbackHmacSecretName('d1')).toBe('pangolin/callback-hmac/d1');
    expect(CALLBACK_HMAC_NAME_PREFIX).toBe('pangolin/callback-hmac');
  });

  it('honours a custom callback prefix', () => {
    expect(callbackHmacSecretName('d1', 'acme/keys')).toBe('acme/keys/d1');
  });

  it('is deterministic given dispatchId — the property least privilege needs', () => {
    // Nothing random enters the name, so a caller that supplies its own
    // dispatchId can author the policy BEFORE the dispatch exists.
    expect(dispatchSecretName('d1', 'K')).toBe(dispatchSecretName('d1', 'K'));
    expect(callbackHmacSecretName('d1')).toBe(callbackHmacSecretName('d1'));
  });

  describe('dispatchSecretPolicyPatterns', () => {
    it('bounds a grant to exactly one dispatch', () => {
      expect(dispatchSecretPolicyPatterns('d1')).toEqual(['d1/*', 'pangolin/callback-hmac/d1-*']);
    });

    it('does not match another dispatch — the whole point of the pair', () => {
      const [inline, hmac] = dispatchSecretPolicyPatterns('d1');
      const matches = (pattern: string, name: string) =>
        new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(
          name,
        );

      expect(matches(inline, dispatchSecretName('d1', 'K'))).toBe(true);
      expect(matches(inline, dispatchSecretName('d2', 'K'))).toBe(false);
      // The callback key is the credential that authenticates a dispatch's
      // callbacks, so reaching another run's is the consequence that matters.
      expect(matches(hmac, `${callbackHmacSecretName('d1')}-AbCdEf`)).toBe(true);
      expect(matches(hmac, `${callbackHmacSecretName('d2')}-AbCdEf`)).toBe(false);
    });

    it("absorbs Secrets Manager's random six-character ARN suffix", () => {
      // The suffix was never what blocked scoping — a wildcard covers it.
      const [, hmac] = dispatchSecretPolicyPatterns('d1');
      expect(hmac.endsWith('-*')).toBe(true);
    });
  });

  it('mintCallbackHmac stages under exactly the declared name', async () => {
    const staged: string[] = [];
    const store: SecretStore = {
      name: 's',
      stage: vi.fn(async (args: { name: string }) => {
        staged.push(args.name);
        return { ref: 'ref://x', ttlSeconds: 1 };
      }),
      resolve: async () => '',
      cleanupByTag: async () => {},
    } as unknown as SecretStore;

    await mintCallbackHmac({ store, dispatchId: 'd-abc' });
    expect(staged).toEqual([callbackHmacSecretName('d-abc')]);
  });
});
