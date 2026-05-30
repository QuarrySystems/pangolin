/**
 * Inline-secret lifecycle wrapper around AWS Secrets Manager.
 *
 * Implements the staging side of §7.6 of the agora design: an inline secret
 * value supplied at `env.register()` or `dispatch()` time is staged in AWS
 * Secrets Manager so the runtime can mount it like any other ARN-referenced
 * secret. TTL defaults to `(dispatch.timeoutSeconds ?? 7200) + 300` so the
 * secret outlives the longest plausible dispatch by a small grace window,
 * then is force-deleted (no recovery window) by `cleanup()`.
 */

import {
  SecretsManagerClient,
  CreateSecretCommand,
  DeleteSecretCommand,
  ListSecretsCommand,
} from '@aws-sdk/client-secrets-manager';
import type { InlineSecret } from '@quarry-systems/agora-core';
import { computeInlineSecretTtl } from './secret-ttl.js';

export { computeInlineSecretTtl } from './secret-ttl.js';

export interface InlineSecretStagerOpts {
  client?: SecretsManagerClient;
  /** Prefix for staged secret names (defaults to 'agora/inline'). */
  namePrefix?: string;
}

export interface StageInlineSecretArgs {
  dispatchId: string;
  envName: string;
  inline: InlineSecret;
  /** Used to compute auto-TTL when `inline.ttlSeconds` is unset. */
  dispatchTimeoutSeconds?: number;
}

export interface StageInlineSecretResult {
  arn: string;
  ttlSeconds: number;
}

export class InlineSecretStager {
  private readonly client: SecretsManagerClient;
  private readonly namePrefix: string;

  constructor(opts: InlineSecretStagerOpts = {}) {
    this.client = opts.client ?? new SecretsManagerClient({});
    this.namePrefix = opts.namePrefix ?? 'agora/inline';
  }

  /**
   * Stage an inline secret value as a fresh AWS Secrets Manager secret.
   * Returns the ARN (used to populate the runtime's `secrets` mount) plus
   * the computed TTL (recorded as a tag for downstream sweepers).
   */
  async stage(args: StageInlineSecretArgs): Promise<StageInlineSecretResult> {
    const ttlSeconds = computeInlineSecretTtl({
      explicit: args.inline.ttlSeconds,
      dispatchTimeoutSeconds: args.dispatchTimeoutSeconds,
    });
    const name = `${this.namePrefix}/${args.dispatchId}/${args.envName}`;
    const res = await this.client.send(
      new CreateSecretCommand({
        Name: name,
        SecretString: args.inline.inline,
        Tags: [
          { Key: 'agora:dispatchId', Value: args.dispatchId },
          { Key: 'agora:ttlSeconds', Value: String(ttlSeconds) },
        ],
      }),
    );
    if (!res.ARN) {
      throw new Error(`CreateSecret returned no ARN for ${name}`);
    }
    return { arn: res.ARN, ttlSeconds };
  }

  /**
   * Delete every secret tagged `agora:dispatchId=<dispatchId>`. Uses
   * `ForceDeleteWithoutRecovery` because staged inline secrets are
   * short-lived by contract — there is no recovery scenario.
   */
  async cleanup(dispatchId: string): Promise<void> {
    let nextToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListSecretsCommand({
          Filters: [
            { Key: 'tag-key', Values: ['agora:dispatchId'] },
            { Key: 'tag-value', Values: [dispatchId] },
          ],
          NextToken: nextToken,
        }),
      );
      for (const entry of page.SecretList ?? []) {
        if (!entry.ARN) continue;
        await this.client.send(
          new DeleteSecretCommand({
            SecretId: entry.ARN,
            ForceDeleteWithoutRecovery: true,
          }),
        );
      }
      nextToken = page.NextToken;
    } while (nextToken);
  }
}
