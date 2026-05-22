// E2E §9 baseline: register + dispatch happy-path via local-docker + local storage.
//
// This is the canonical green-light test for the §9 pipeline. It registers a
// capability, a subagent that depends on it, and an env, then drives a
// `client.dispatch()` against `LocalDockerProvider` + `LocalStorageProvider`
// using a digest-pinned tiny worker image (see `WORKER_IMAGE`).
//
// The assertions exercise the entire chain:
//   storage write → worker boot → bundle fetch → integrity verify → overlay
//     → secret resolve → runtime invoke → result back with `resolved` block
//
// Concretely we assert:
//   - `result.exitCode === 0` (the worker ran to completion)
//   - `result.resolved.subagent.contentHash` matches the value `register()`
//     returned (the worker hashed the exact bytes we wrote)
//   - `result.resolved.capabilities[0].contentHash` matches the capability ref
//   - `result.stdout` contains the echo string the subagent's system prompt
//     told it to print
//
// The suite SKIPS gracefully when the Docker daemon isn't reachable (Windows
// dev box without Docker Desktop, CI runner without DinD, etc.) via the
// `probeDocker()` + `itIfDocker()` gate from `./helpers/docker-skip.ts`.
//
// Storage uses a fresh `mkdtemp` per test via `useTempStorageRoot` so the
// content-hash invariants aren't polluted by prior runs.

import { describe, expect } from 'vitest';
import { makeClient } from './helpers/make-client.js';
import { probeDocker, itIfDocker } from './helpers/docker-skip.js';
import { useTempStorageRoot } from './helpers/temp-storage.js';
import { WORKER_IMAGE } from './helpers/worker-image.js';

probeDocker();
const storageRoot = useTempStorageRoot('e2e-happy');

describe('E2E: register + dispatch via local-docker + local storage', () => {
  itIfDocker(
    'completes the full pipeline and returns a resolved block with exact content hashes',
    async () => {
      const client = makeClient({
        namespace: 'e2e-tests',
        storageRoot: storageRoot(),
      });

      const cap = await client.capabilities.register({
        name: 'noop-cap',
        files: { 'agora-setup.sh': '#!/bin/sh\necho "setup ran"\n' },
      });

      const sub = await client.subagent.register({
        name: 'echo-agent',
        systemPrompt:
          'You are an echo agent. Print exactly "hello from agora" and exit.',
        capabilities: [cap],
      });

      const env = await client.env.register({
        name: 'minimal',
        values: { LOG_LEVEL: 'info' },
      });

      const result = await client.dispatch({
        subagent: 'echo-agent',
        env: 'minimal',
        target: 'local',
        timeoutSeconds: 60,
        workerImage: WORKER_IMAGE,
      } as any);

      expect(result.exitCode).toBe(0);
      expect(result.resolved.subagent.contentHash).toBe(sub.contentHash);
      expect(result.resolved.capabilities[0].contentHash).toBe(cap.contentHash);
      expect(result.resolved.env![0].contentHash).toBe(env.contentHash);
      expect(result.stdout).toContain('hello from agora');
    },
    120_000,
  );
});
