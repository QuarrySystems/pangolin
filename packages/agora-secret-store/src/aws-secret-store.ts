// AWS Secrets Manager adapter for the SecretStore (ENVStore) contract.
//
// Consolidates the staging logic previously split across the client's
// `InlineSecretStager` and `mintCallbackHmac`, and the resolution logic in
// the worker's `SecretResolver`, behind the single `SecretStore` interface
// from agora-core. `ttlSeconds` is recorded as the `agora:ttlSeconds` tag
// (Secrets Manager has no native TTL); a sweeper or the client's
// `cleanupByTag` reclaims staged secrets, with the tag as the audit record.

import {
  SecretsManagerClient,
  CreateSecretCommand,
  GetSecretValueCommand,
  DeleteSecretCommand,
  ListSecretsCommand,
} from "@aws-sdk/client-secrets-manager";
import type {
  SecretStore,
  StageSecretArgs,
  StagedSecret,
} from "@quarry-systems/agora-core";

export interface AwsSecretStoreOpts {
  /**
   * Inject a pre-configured client. When omitted a default client is
   * constructed (region/credentials from the ambient AWS provider chain).
   */
  client?: SecretsManagerClient;
}

export class AwsSecretStore implements SecretStore {
  readonly name = "aws-secrets-manager";
  private readonly client: SecretsManagerClient;

  constructor(opts: AwsSecretStoreOpts = {}) {
    this.client = opts.client ?? new SecretsManagerClient({});
  }

  async stage(args: StageSecretArgs): Promise<StagedSecret> {
    const tags = [
      ...Object.entries(args.tags ?? {}).map(([Key, Value]) => ({ Key, Value })),
      { Key: "agora:ttlSeconds", Value: String(args.ttlSeconds) },
    ];
    const res = await this.client.send(
      new CreateSecretCommand({
        Name: args.name,
        SecretString: args.value,
        Tags: tags,
      }),
    );
    if (!res.ARN) {
      throw new Error(`AwsSecretStore: CreateSecret returned no ARN for ${args.name}`);
    }
    return { ref: res.ARN, ttlSeconds: args.ttlSeconds };
  }

  async resolve(ref: string): Promise<string> {
    const res = await this.client.send(
      new GetSecretValueCommand({ SecretId: ref }),
    );
    if (res.SecretString === undefined) {
      throw new Error(
        `AwsSecretStore: SecretString is empty for ${ref} (binary secret unsupported)`,
      );
    }
    return res.SecretString;
  }

  async cleanupByTag(tagKey: string, tagValue: string): Promise<void> {
    let nextToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListSecretsCommand({
          Filters: [
            { Key: "tag-key", Values: [tagKey] },
            { Key: "tag-value", Values: [tagValue] },
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
