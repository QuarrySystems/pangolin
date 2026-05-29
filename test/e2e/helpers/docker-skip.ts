// Docker-availability gate for E2E tests.
//
// Many E2E suites dispatch a real worker container via the local-docker
// provider, which additionally requires the pinned worker image to be
// pulled and (for the claude-code adapter) a working runtime. Those
// preconditions don't hold on a vanilla CI runner — ubuntu-latest HAS a
// Docker daemon but not the image — so the suites are GATED behind an
// explicit opt-in (mirrors the AGORA_E2E_AWS_* gating):
//
//   - run them with `AGORA_E2E_DOCKER=1 pnpm test:e2e` once the worker image
//     is pulled locally;
//   - without the flag (CI default, plain local runs) they PASS-as-skipped.
//
// Usage:
//   probeDocker();                        // call ONCE at file top level
//   itIfDocker('round-trips', async () => {
//     // ... real assertions; only runs when opted-in AND the daemon answers
//   });
//
// `probeDocker()` registers a `beforeAll` that checks the opt-in flag and
// pings the daemon, flipping a module-level flag. `itIfDocker` registers a
// real vitest `it` whose body reads the flag at test-execution time (not at
// registration time) — that's why we wrap the user fn rather than swapping
// in `it.skip` up front.

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
    // Opt-in: container E2E runs only when AGORA_E2E_DOCKER=1. A reachable
    // daemon alone isn't enough (the pinned worker image must also be pulled),
    // so CI — which sets neither — passes these suites as skipped.
    if (process.env.AGORA_E2E_DOCKER !== '1') {
      dockerAvailable = false;
      return;
    }
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
