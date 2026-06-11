import { defineConfig } from 'vitest/config';

// Root-level E2E runner config. Scopes vitest to the repo-root `test/`
// directory (the cross-package end-to-end suite), which is NOT a workspace
// package and is therefore not covered by `pnpm -r test`.
//
// Named `vitest.e2e.config.ts` (not the auto-discovered `vitest.config.ts`)
// and passed explicitly via `--config` so per-package `vitest run` invocations
// never pick it up — they keep their own default discovery.
//
// Docker-dependent suites self-skip via `test/e2e/helpers/docker-skip.ts`
// when no daemon answers; the live-AWS suite self-skips unless its
// `PANGOLIN_E2E_AWS_*` env vars are set.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Cloud + container boots need far more than the 5s default.
    testTimeout: 900_000,
    hookTimeout: 120_000,
  },
});
