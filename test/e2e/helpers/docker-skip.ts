// Docker-availability gate for E2E tests.
//
// Many E2E suites require a reachable Docker daemon (the local-docker
// compute provider talks to `/var/run/docker.sock` on Unix or the
// `//./pipe/docker_engine` named pipe on Windows). On CI runners or dev
// machines without Docker we want the suite to PASS-as-skipped, not fail.
//
// Usage:
//   probeDocker();                        // call ONCE at file top level
//   itIfDocker('round-trips', async () => {
//     // ... real assertions; only runs if the daemon answered ping
//   });
//
// `probeDocker()` registers a `beforeAll` that pings the daemon and flips
// a module-level flag. `itIfDocker` registers a real vitest `it` whose body
// reads the flag at test-execution time (not at registration time) — that's
// why we wrap the user fn rather than swapping in `it.skip` up front.

import Docker from 'dockerode';
import { beforeAll, it } from 'vitest';

let dockerAvailable = false;

/**
 * Register a `beforeAll` that probes the local Docker daemon. Sets the
 * module-level `dockerAvailable` flag based on `docker.ping()`. Safe to
 * call multiple times in the same file (only the last `beforeAll` wins
 * semantically, and all set the same flag).
 */
export function probeDocker(): void {
  beforeAll(async () => {
    try {
      await new Docker().ping();
      dockerAvailable = true;
    } catch {
      dockerAvailable = false;
    }
  });
}

/**
 * Variant of vitest's `it()` that skips the body when the Docker daemon
 * is unreachable. The probe result is read inside the test function (not
 * at registration time), so `probeDocker`'s `beforeAll` has a chance to
 * run first.
 */
export function itIfDocker(
  name: string,
  fn: () => Promise<void> | void,
  timeout?: number,
): void {
  it(
    name,
    async () => {
      if (!dockerAvailable) return;
      await fn();
    },
    timeout,
  );
}
