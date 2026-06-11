import type { SecretStore } from "@quarry-systems/pangolin-core";
import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { AwsSecretStore } from "./aws-secret-store.js";
import { LocalSecretStore } from "./local-secret-store.js";

export type SecretStoreKind = "aws-secrets-manager" | "local-file";

export interface SecretStoreConfig {
  kind: SecretStoreKind;
  /** Required when kind === "local-file": the per-secret file directory. */
  dir?: string;
  /** Optional Secrets Manager client for the AWS kind (test seam). Ignored for local-file. */
  client?: SecretsManagerClient;
}

export function storeFromConfig(cfg: SecretStoreConfig): SecretStore {
  switch (cfg.kind) {
    case "aws-secrets-manager":
      return new AwsSecretStore({ client: cfg.client });
    case "local-file":
      if (!cfg.dir) throw new Error("storeFromConfig: local-file requires dir");
      return new LocalSecretStore({ dir: cfg.dir });
    default:
      throw new Error(`storeFromConfig: unknown kind ${(cfg as { kind: string }).kind}`);
  }
}
