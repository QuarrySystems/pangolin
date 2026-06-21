import { defineConfig } from 'vitest/config';

// Default unit + integration test run (`pnpm test` → `vitest run`).
//
// A handful of integration/pressure tests (e.g. data-mapreduce.int, pressure-runner,
// the inproc-worker-executor fixture) do REAL multi-tick pipeline execution — SQLite,
// content-addressed storage, timers — and take several seconds each in isolation. Under
// vitest's default file-level concurrency on a loaded machine they can exceed the 5s
// DEFAULT testTimeout and flake with "Test timed out in 5000ms" (they pass cleanly when
// run alone). Raising the timeout to 30s gives them headroom under contention while still
// failing a genuinely hung test. Matches the cross-process config's 30s convention.
//
// `include` is left at the vitest default (`**/*.test.ts`), so the cross-process
// `*.xproc.ts` files stay excluded here — they run via `test:xproc` + vitest.xproc.config.ts.
export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
