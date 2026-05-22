import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

/**
 * Thrown when a secret reference cannot be resolved via AWS Secrets Manager.
 *
 * Per spec §6.2, the worker entrypoint converts this into a `reason: 'fetch-failed'`
 * failure when reporting back to the dispatcher.
 */
export class SecretResolutionError extends Error {
  constructor(
    public readonly ref: string,
    public readonly detail: string,
  ) {
    super(`secret resolution failed for ${ref}: ${detail}`);
    this.name = "SecretResolutionError";
  }
}

export interface SecretResolverOpts {
  /**
   * Inject a pre-configured Secrets Manager client. When omitted, a default
   * client is constructed (region/credentials picked up from the environment
   * by the AWS SDK provider chain).
   */
  client?: SecretsManagerClient;
}

/**
 * Resolves a map of `envName -> secretArn` to a map of `envName -> secretValue`
 * by calling `GetSecretValue` against AWS Secrets Manager once per ARN.
 *
 * Used at worker boot (per §6.2 step 5) to materialize both env-bundle
 * secrets and per-dispatch secrets before the subagent runtime is started.
 */
export class SecretResolver {
  private readonly client: SecretsManagerClient;

  constructor(opts: SecretResolverOpts = {}) {
    this.client = opts.client ?? new SecretsManagerClient({});
  }

  async resolve(secretRefs: Record<string, string>): Promise<Record<string, string>> {
    const resolved: Record<string, string> = {};
    for (const [envName, arn] of Object.entries(secretRefs)) {
      try {
        const res = await this.client.send(
          new GetSecretValueCommand({ SecretId: arn }),
        );
        if (res.SecretString === undefined) {
          throw new SecretResolutionError(
            arn,
            "SecretString is empty (binary secret unsupported)",
          );
        }
        resolved[envName] = res.SecretString;
      } catch (err) {
        if (err instanceof SecretResolutionError) throw err;
        throw new SecretResolutionError(arn, (err as Error).message);
      }
    }
    return resolved;
  }
}
