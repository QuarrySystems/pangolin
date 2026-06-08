// E2E contract: §4.2 + §6.2 — multi-bundle `env` precedence.
//
// `client.dispatch({ env: [...] })` accepts an ordered list of env-bundle
// names. The pangolin-worker merges them left-to-right, so the LAST bundle
// wins on any key conflict. Keys that only appear in earlier bundles are
// preserved (the merge is a union, not a swap).
//
// This is a behavior contract on the worker — the merge happens inside
// the container after bundle download + integrity verify, not in the
// client. So we have to exercise it end-to-end through a real
// `LocalDockerProvider` + `LocalStorageProvider` pipeline; mocking the
// worker would test the wrong layer.
//
// Setup:
//   - register a capability whose `pangolin-setup.sh` echoes `LOG_LEVEL=$LOG_LEVEL`
//     and `BASE_ONLY=$BASE_ONLY` to stdout. Those are our observables for
//     the merge result.
//   - register two env bundles:
//       base:     { LOG_LEVEL: 'info',  BASE_ONLY: 'present' }
//       override: { LOG_LEVEL: 'debug' }
//   - dispatch with `env: ['base', 'override']` — `override` is second,
//     so it should win on `LOG_LEVEL`.
//
// Assertions:
//   - stdout contains `LOG_LEVEL=debug` — later-wins on conflict. If the
//     merge order were reversed (or only-last-bundle-applied), we'd see
//     `info` or empty.
//   - stdout contains `BASE_ONLY=present` — keys unique to the earlier
//     bundle survive the merge (union, not swap). If the later bundle
//     wholesale replaced the earlier one, we'd see empty.
//
// SKIP gracefully when the Docker daemon is unreachable — the assertion
// only fires inside the daemon, so there's nothing to verify without it.

import { describe, expect } from 'vitest';
import { makeClient } from './helpers/make-client.js';
import { probeDocker, itIfDocker } from './helpers/docker-skip.js';
import { useTempStorageRoot } from './helpers/temp-storage.js';
import { WORKER_IMAGE } from './helpers/worker-image.js';

probeDocker();
const storageRoot = useTempStorageRoot('e2e-envmerge');

describe('E2E: multiple env bundles merge later-wins', () => {
  itIfDocker(
    'second env bundle overrides a key from the first',
    async () => {
      const client = makeClient({
        namespace: 'envmerge',
        storageRoot: storageRoot(),
      });

      const cap = await client.capabilities.register({
        name: 'env-echo',
        files: {
          'pangolin-setup.sh':
            '#!/bin/sh\necho "LOG_LEVEL=$LOG_LEVEL"\necho "BASE_ONLY=$BASE_ONLY"\n',
        },
      });

      await client.subagent.register({
        name: 'env-echo-agent',
        systemPrompt: 'Just exit.',
        capabilities: [cap],
      });

      await client.env.register({
        name: 'base',
        values: { LOG_LEVEL: 'info', BASE_ONLY: 'present' },
      });
      await client.env.register({
        name: 'override',
        values: { LOG_LEVEL: 'debug' },
      });

      const result = await client.dispatch({
        subagent: 'env-echo-agent',
        env: ['base', 'override'],
        target: 'local',
        workerImage: WORKER_IMAGE,
      } as any);

      // `base` + `override` merged. `override` wins on LOG_LEVEL; keys
      // unique to `base` (e.g. BASE_ONLY) remain part of the worker's
      // process env.
      expect(result.stdout).toContain('LOG_LEVEL=debug');
      expect(result.stdout).toContain('BASE_ONLY=present');
    },
    120_000,
  );
});
