// Canonical `AgoraClient` factory for E2E tests.
//
// Centralizing client construction means every Docker-using E2E suite is
// wired the same way: `LocalDockerProvider` on the `local-docker` slot,
// `NoopCredentialProvider` on the `none` slot, `LocalStorageProvider`
// rooted at a per-test scratch directory (see `useTempStorageRoot`), and
// a single `local` target binding the two.
//
// `dockerOpts` is forwarded verbatim to `LocalDockerProvider` so individual
// tests can inject a stub Docker instance (`{ docker: fakeDocker }`) or
// opt into the `allowUnpinnedImage` escape hatch when exercising the
// digest-pinning contract negatively.
//
// Workspace packages are not declared as dependencies of the repo-root
// manifest, so — matching the existing root-level E2E test — we import
// from each package's built `dist/` output via a relative path. Run
// `pnpm -r build` from the repo root before invoking the suite.

import {
  AgoraClient,
  NoopCredentialProvider,
  StdoutResultSink,
} from '../../../packages/agora-client/dist/index.js';
import { LocalStorageProvider } from '../../../packages/agora-storage-local/dist/index.js';
import {
  LocalDockerProvider,
  type LocalDockerProviderOpts,
} from '../../../packages/agora-providers-local-docker/dist/index.js';

export interface MakeClientOpts {
  /** `AgoraClient.namespace` — keep distinct per suite to isolate storage. */
  namespace: string;
  /** Absolute path to the per-test scratch dir (see `useTempStorageRoot`). */
  storageRoot: string;
  /** Forwarded to `LocalDockerProvider`. Optional; defaults to `{}`. */
  dockerOpts?: LocalDockerProviderOpts;
}

export function makeClient(opts: MakeClientOpts): AgoraClient {
  return new AgoraClient({
    namespace: opts.namespace,
    compute: { 'local-docker': new LocalDockerProvider(opts.dockerOpts ?? {}) },
    credentials: { none: new NoopCredentialProvider() },
    storage: new LocalStorageProvider({ rootDir: opts.storageRoot }),
    targets: { local: { compute: 'local-docker', credentials: 'none' } },
    resultSink: new StdoutResultSink(),
  });
}
