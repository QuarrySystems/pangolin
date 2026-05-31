import { defineConfig } from 'vitest/config';

// Cross-process integration tests (real OS processes sharing the filesystem mailbox).
// They spawn child processes that import the BUILT dist, so `test:xproc` runs `tsc`
// first and uses this config to include the `*.xproc.ts` files — which the default
// `vitest run` (include `*.test.ts`) deliberately skips so the unit loop stays fast.
export default defineConfig({
  test: {
    include: ['test/cross-process/**/*.xproc.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
