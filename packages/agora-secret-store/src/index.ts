// @quarry-systems/agora-secret-store
//
// SecretStore (ENVStore) adapters implementing the contract from
// @quarry-systems/agora-core. Two backends ship: AWS Secrets Manager
// (production) and a local file-backed store (dev / LocalDockerProvider).

export { AwsSecretStore, type AwsSecretStoreOpts } from "./aws-secret-store.js";
export {
  LocalSecretStore,
  type LocalSecretStoreOpts,
} from "./local-secret-store.js";
