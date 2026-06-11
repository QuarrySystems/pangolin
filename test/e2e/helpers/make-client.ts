// Canonical `PangolinClient` factory for E2E tests.
//
// Centralizing client construction means every Docker-using E2E suite is
// wired the same way: `LocalDockerProvider` on the `local-docker` slot,
// `NoopCredentialProvider` on the `none` slot, `LocalStorageProvider`
// rooted at a per-test scratch directory (see `useTempStorageRoot`), and
// a single `local` target binding the two. An `AwsSecretStore` is
// registered under the `'aws'` key and the `local` target's `secretStore`
// is set to `'aws'` so per-dispatch inline secrets and callback HMAC keys
// are staged to (and resolved from) AWS Secrets Manager automatically.
//
// `dockerOpts` is forwarded verbatim to `LocalDockerProvider` so individual
// tests can inject a stub Docker instance (`{ docker: fakeDocker }`) or
// opt into the `allowUnpinnedImage` escape hatch when exercising the
// digest-pinning contract negatively.
//
// `secretStore` overrides the default `AwsSecretStore` so tests that need
// to intercept secret staging can inject a mock without changing other
// construction details. Tests that do NOT exercise secrets call
// `makeClient()` unchanged; the wired store is present but only invoked
// when a dispatch actually stages inline secrets or a callback HMAC key.
//
// Workspace packages are not declared as dependencies of the repo-root
// manifest, so — matching the existing root-level E2E test — we import
// from each package's built `dist/` output via a relative path. Run
// `pnpm -r build` from the repo root before invoking the suite.

import {
  PangolinClient,
  NoopCredentialProvider,
  StdoutResultSink,
} from '../../../packages/pangolin-client/dist/index.js';
import { LocalStorageProvider } from '../../../packages/pangolin-storage-local/dist/index.js';
import {
  LocalDockerProvider,
  type LocalDockerProviderOpts,
} from '../../../packages/pangolin-providers-local-docker/dist/index.js';
import { AwsSecretStore } from '../../../packages/pangolin-secret-store/dist/index.js';
import type { SecretStore } from '../../../packages/pangolin-core/dist/index.js';

export interface MakeClientOpts {
  /** `PangolinClient.namespace` — keep distinct per suite to isolate storage. */
  namespace: string;
  /** Absolute path to the per-test scratch dir (see `useTempStorageRoot`). */
  storageRoot: string;
  /** Forwarded to `LocalDockerProvider`. Optional; defaults to `{}`. */
  dockerOpts?: LocalDockerProviderOpts;
  /**
   * Override the SecretStore registered under the `'aws'` key on the
   * `local` target. Defaults to `new AwsSecretStore()` (ambient credential
   * chain). Tests that need to intercept secret staging inject a mock here
   * so no real Secrets Manager calls are made.
   */
  secretStore?: SecretStore;
}

export function makeClient(opts: MakeClientOpts): PangolinClient {
  const store: SecretStore = opts.secretStore ?? new AwsSecretStore();
  return new PangolinClient({
    namespace: opts.namespace,
    compute: { 'local-docker': new LocalDockerProvider(opts.dockerOpts ?? {}) },
    credentials: { none: new NoopCredentialProvider() },
    storage: new LocalStorageProvider({ rootDir: opts.storageRoot }),
    targets: { local: { compute: 'local-docker', credentials: 'none', secretStore: 'aws' } },
    secretStores: { aws: store },
    resultSink: new StdoutResultSink(),
  });
}
