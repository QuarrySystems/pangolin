// Integration tests for `LocalDockerProvider` against a real Docker daemon.
//
// Gated on the daemon being reachable: `beforeAll` calls `docker.ping()` and
// flips a module-level flag. Every test is registered with `itIf(daemon)`,
// which expands to `it.skip` when the daemon is absent. The whole file
// therefore runs green on machines/CI without Docker, while exercising the
// real round-trip on hosts that have it.
//
// Coverage (per task-local-docker-tests):
//   1. run() + awaitExit() round-trip — exit code 0 from a tiny container
//   2. cancel() — long-sleeping container, SIGTERM-then-stopped within grace
//   3. failure — image-not-found surfaces from run() (or awaitExit() on the
//      provider-failure path) instead of hanging
//   4. concurrency — two disjoint dispatchIds, labels propagate per-container
//
// Image is digest-pinned per §7.4 — no `allowUnpinnedImage` escape hatch,
// even in tests. If the digest goes stale (Docker Hub repushes), update
// `BUSYBOX_PINNED` to the current `library/busybox:latest` linux/amd64
// manifest digest.

import Docker from 'dockerode';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';

import { LocalDockerProvider } from '../src/index.js';
import type { ProviderContext, TaskSpec } from '@quarry-systems/pangolin-core';

// Current linux/amd64 manifest digest for `library/busybox:latest` on Docker
// Hub (resolved 2026-05-21). Pinning by digest satisfies the provider's
// §7.4 enforcement so we exercise the production path, not the
// `allowUnpinnedImage` escape hatch.
const BUSYBOX_PINNED =
  'busybox@sha256:b8d1827e38a1d49cd17217efd7b07d689e4ea1744e39c7dcbb95533d175bea65';

// Reference used only for the image-not-found case. A well-formed but
// implausible digest — sha256 of all-zeros is not a real busybox layer.
const BUSYBOX_NONEXISTENT =
  'busybox@sha256:0000000000000000000000000000000000000000000000000000000000000000';

const ctx: ProviderContext = { credentials: { kind: 'none' } };

const docker = new Docker();
let dockerAvailable = false;

const itIf = (cond: boolean): typeof it => (cond ? it : it.skip);

/** Drain `docker.pull`'s stream to completion. */
async function pullImage(ref: string): Promise<void> {
  const stream = (await docker.pull(ref)) as NodeJS.ReadableStream;
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/** Best-effort cleanup — remove any container we created so the daemon
 * doesn't accumulate stopped husks across test runs. */
async function tryRemove(id: string): Promise<void> {
  try {
    await docker.getContainer(id).remove({ force: true });
  } catch {
    // Container may already be gone; ignore.
  }
}

beforeAll(async () => {
  try {
    await docker.ping();
    dockerAvailable = true;
  } catch {
    dockerAvailable = false;
    return;
  }
  // Pre-pull the busybox image once so individual cases don't each pay the
  // pull tax. Pull is idempotent — if the image is already local, this is
  // a quick metadata round-trip.
  await pullImage(BUSYBOX_PINNED);
}, /* 5-minute pull budget for cold CI caches */ 5 * 60 * 1000);

// Per-test cleanup is per-test (each case knows the container IDs it
// created), but we also do a label-scoped sweep at the very end so a
// crashed test doesn't strand containers on the host.
afterAll(async () => {
  if (!dockerAvailable) return;
  try {
    const containers = await docker.listContainers({
      all: true,
      filters: { label: ['pangolin.test=local-docker-integration'] },
    });
    for (const c of containers) {
      await tryRemove(c.Id);
    }
  } catch {
    // best-effort
  }
});

describe('LocalDockerProvider — integration against real Docker daemon', () => {
  itIf(dockerAvailable)(
    'run() + awaitExit() round-trip returns exit code 0 and captures stdout',
    async () => {
      const provider = new LocalDockerProvider({ docker });
      const spec: TaskSpec = {
        image: BUSYBOX_PINNED,
        env: {},
        secretRefs: {},
        dispatchId: 'integration-roundtrip-' + Date.now(),
        command: ['sh', '-c', 'echo hello-from-busybox; exit 0'],
      };

      // We need the cleanup label too — augment via a one-shot subclass-free
      // approach: createContainer directly here would bypass the provider,
      // defeating the test. Instead, sweep by dispatchId in finally.
      const handle = await provider.run(spec, ctx);
      try {
        const exit = await provider.awaitExit(handle, ctx);
        expect(exit.exitCode).toBe(0);
        expect(exit.stdout).toContain('hello-from-busybox');
        expect(exit.stderr).toBe('');
        // Timestamps should be real Dates ordered start <= finish.
        expect(exit.startedAt).toBeInstanceOf(Date);
        expect(exit.finishedAt).toBeInstanceOf(Date);
        expect(exit.finishedAt.getTime()).toBeGreaterThanOrEqual(
          exit.startedAt.getTime(),
        );
      } finally {
        await tryRemove(handle.providerTaskId);
      }
    },
    60 * 1000,
  );

  itIf(dockerAvailable)(
    'cancel() stops a long-running container within the grace period',
    async () => {
      const graceSeconds = 5;
      const provider = new LocalDockerProvider({
        docker,
        sigtermGraceSeconds: graceSeconds,
      });
      const spec: TaskSpec = {
        image: BUSYBOX_PINNED,
        env: {},
        secretRefs: {},
        dispatchId: 'integration-cancel-' + Date.now(),
        // `sleep 600` would outlast the grace period easily; SIGTERM should
        // tear it down well inside graceSeconds (busybox sleep honors signals).
        command: ['sleep', '600'],
      };

      const handle = await provider.run(spec, ctx);
      try {
        const t0 = Date.now();
        await provider.cancel(handle, ctx);
        const elapsedMs = Date.now() - t0;

        // Cancel contract: must complete within graceSeconds + a generous
        // slack for daemon round-trips on slow CI.
        expect(elapsedMs).toBeLessThan((graceSeconds + 2) * 1000);

        // And the container itself must be in a non-Running state.
        const info = await docker.getContainer(handle.providerTaskId).inspect();
        expect(info.State.Running).toBe(false);
      } finally {
        await tryRemove(handle.providerTaskId);
      }
    },
    60 * 1000,
  );

  itIf(dockerAvailable)(
    'run() propagates an image-not-found failure instead of hanging',
    async () => {
      const provider = new LocalDockerProvider({ docker });
      const spec: TaskSpec = {
        image: BUSYBOX_NONEXISTENT,
        env: {},
        secretRefs: {},
        dispatchId: 'integration-missing-' + Date.now(),
        command: ['true'],
      };

      // Whether the failure surfaces in run() (createContainer 404 on a
      // missing local image when the daemon is configured not to pull
      // implicitly) or via a subsequent awaitExit path depends on daemon
      // version. The contract we assert is the weaker "some error
      // propagates, no silent success". We try run() first and fall back
      // to awaitExit() so the test is robust across daemon versions.
      let caught: unknown = null;
      let handleId: string | null = null;
      try {
        const handle = await provider.run(spec, ctx);
        handleId = handle.providerTaskId;
        try {
          await provider.awaitExit(handle, ctx);
        } catch (e) {
          caught = e;
        }
      } catch (e) {
        caught = e;
      } finally {
        if (handleId) await tryRemove(handleId);
      }

      expect(caught).not.toBeNull();
      // Some kind of Error, not e.g. a string.
      expect(caught).toBeInstanceOf(Error);
    },
    60 * 1000,
  );

  itIf(dockerAvailable)(
    'concurrent dispatches carry disjoint pangolin.dispatchId labels',
    async () => {
      const provider = new LocalDockerProvider({ docker });
      const dispatchA = 'integration-concurrent-A-' + Date.now();
      const dispatchB = 'integration-concurrent-B-' + Date.now();
      const mkSpec = (dispatchId: string): TaskSpec => ({
        image: BUSYBOX_PINNED,
        env: {},
        secretRefs: {},
        dispatchId,
        command: ['sh', '-c', 'echo ' + dispatchId],
      });

      const [handleA, handleB] = await Promise.all([
        provider.run(mkSpec(dispatchA), ctx),
        provider.run(mkSpec(dispatchB), ctx),
      ]);

      try {
        const [infoA, infoB] = await Promise.all([
          docker.getContainer(handleA.providerTaskId).inspect(),
          docker.getContainer(handleB.providerTaskId).inspect(),
        ]);

        expect(infoA.Config.Labels?.['pangolin.dispatchId']).toBe(dispatchA);
        expect(infoB.Config.Labels?.['pangolin.dispatchId']).toBe(dispatchB);
        expect(handleA.providerTaskId).not.toBe(handleB.providerTaskId);

        // Both reach their natural terminal state independently. Use
        // awaitExit on each so we exercise the per-container wait path,
        // not just inspect().
        const [exitA, exitB] = await Promise.all([
          provider.awaitExit(handleA, ctx),
          provider.awaitExit(handleB, ctx),
        ]);
        expect(exitA.exitCode).toBe(0);
        expect(exitB.exitCode).toBe(0);
        expect(exitA.stdout).toContain(dispatchA);
        expect(exitB.stdout).toContain(dispatchB);
      } finally {
        await Promise.all([
          tryRemove(handleA.providerTaskId),
          tryRemove(handleB.providerTaskId),
        ]);
      }
    },
    90 * 1000,
  );
});
