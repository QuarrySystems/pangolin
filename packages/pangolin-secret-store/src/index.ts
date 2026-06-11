// @quarry-systems/pangolin-secret-store
//
// SecretStore (ENVStore) adapters implementing the contract from
// @quarry-systems/pangolin-core. Two backends ship: AWS Secrets Manager
// (production) and a local file-backed store (dev / LocalDockerProvider).

export { AwsSecretStore, type AwsSecretStoreOpts } from "./aws-secret-store.js";
export {
  LocalSecretStore,
  type LocalSecretStoreOpts,
} from "./local-secret-store.js";
export {
  storeFromConfig,
  type SecretStoreKind,
  type SecretStoreConfig,
} from "./store-from-config.js";
