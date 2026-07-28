/**
 * Root ESLint configuration for the Pangolin Scale monorepo.
 *
 * Uses the legacy `.eslintrc.*` format (ESLint 8.x). Per-package configs
 * may extend this with package-specific rules.
 *
 * Scope note: every package's `lint` script is `eslint src test --ext .ts`.
 * Test files ARE linted — see the `overrides` block for the two rules that
 * are relaxed there and, more importantly, the one that is not.
 */
/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  rules: {
    // Honor the `_`-prefix convention the codebase already follows for
    // intentionally-unused params/vars/caught-errors (e.g. `_ctx`, `_client`,
    // `_event`). Non-prefixed unused identifiers still error.
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      },
    ],
  },
  env: {
    node: true,
    es2022: true,
  },
  overrides: [
    {
      // Test files are linted, but two rules from the recommended set describe
      // production code and misfire on test code. Both are relaxed here with a
      // stated reason; everything else — including `no-unused-vars` — still
      // errors, because a dead import in a test is the same rot it is anywhere.
      files: ['**/test/**/*.ts', '**/*.test.ts'],
      rules: {
        // Test doubles are hand-written partial objects cast at the boundary
        // (`as unknown as StorageProvider`). Requiring a precise type for a
        // deliberately-incomplete fake would mean either building a full
        // implementation per test or naming the shape twice.
        //
        // NOTE: this is a lint relaxation only. It does NOT make incomplete
        // doubles type-safe — `tsc` still rejects them, which is exactly the
        // 213-error debt tracked in issue #99 for the ten packages not yet on
        // `typecheck:test`. Do not read this rule as blessing the pattern.
        '@typescript-eslint/no-explicit-any': 'off',

        // CLI tests assert on rendered terminal output and must match or strip
        // ANSI escape sequences (`\x1b[...m`). The control characters are the
        // subject under test, not an accident.
        'no-control-regex': 'off',
      },
    },
  ],
  ignorePatterns: ['node_modules/', 'dist/', 'coverage/', '*.cjs'],
};
