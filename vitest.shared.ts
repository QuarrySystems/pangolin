import { defineConfig } from 'vitest/config';

/**
 * Shared vitest defaults for every package in the monorepo.
 *
 * Each package runs its own `vitest run` (via `pnpm -r test`), so vitest reads
 * config from that package's directory — there is no implicit inheritance from
 * the repo root. Packages therefore carry a two-line `vitest.config.ts` that
 * merges this file, which keeps the values defined exactly once.
 *
 * ## Why 30s and not vitest's 5s default
 *
 * A number of suites here do REAL work rather than exercising pure functions:
 * `pangolin-worker` spawns `git` repeatedly (one test plants a `core.fsmonitor`
 * hook that spawns again), `pangolin-orchestrator` runs multi-tick pipelines
 * over SQLite and content-addressed storage on real timers, and several barrel
 * tests pay a large module-load cost before their first assertion.
 *
 * Each is comfortably fast in isolation — the worker's escape test runs in
 * ~337ms against the 5s default, a ~15x margin. That margin is not what it
 * looks like: under vitest's file-level concurrency on a loaded machine, a
 * full-repo run has been measured at `collect 59.66s` and `tests 122.03s`
 * inside a 29.77s wall-clock. Process spawn dominates and is markedly slower on
 * Windows. The result was `pnpm -r test` failing on a *different* test each run
 * while every one of them passed alone.
 *
 * 30s gives headroom under contention while still failing a genuinely hung
 * test. `pangolin-orchestrator` reached this conclusion independently before
 * this file existed; this generalizes it rather than repeating it per package.
 *
 * A timeout is a ceiling, not a target — it never slows a passing run. Prefer
 * fixing a slow test over raising this further. And note that a timeout cannot
 * fix a *race*: a test that waits on wall-clock time instead of a condition
 * needs a condition-waiter, not a bigger budget. See issue #101.
 */
export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
