// @quarry-systems/pangolin-providers-aws-creds
//
// Thin wrapper around the AWS SDK's default credential chain that
// implements `CredentialProvider` (§5.2). `resolve()` invokes the
// underlying chain and returns a `ResolvedCredentials` discriminated
// with `kind: 'aws'`. No caching beyond what the default chain itself
// performs; integrators wanting cross-process caching wire their own
// resolver via `providerOverride`.

import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { CredentialProvider, ResolvedCredentials } from '@quarry-systems/pangolin-core';

export interface AwsCredentialProviderOpts {
  /**
   * Override the default provider chain. Used for testing or for integrators
   * that need a custom credential source (e.g., assume-role flows that don't
   * fit the default chain).
   */
  providerOverride?: () => Promise<{
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  }>;
}

export class AwsCredentialProvider implements CredentialProvider {
  readonly name = 'aws';
  private readonly resolver: () => Promise<{
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  }>;

  constructor(opts: AwsCredentialProviderOpts = {}) {
    // Construction is side-effect-free: `fromNodeProviderChain()` is invoked
    // lazily on each `resolve()` call rather than eagerly here, so that any
    // I/O the SDK might perform happens at resolution time.
    this.resolver = opts.providerOverride ?? (() => fromNodeProviderChain()());
  }

  async resolve(): Promise<ResolvedCredentials> {
    const c = await this.resolver();
    return {
      kind: 'aws',
      accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey,
      sessionToken: c.sessionToken,
    };
  }
}
