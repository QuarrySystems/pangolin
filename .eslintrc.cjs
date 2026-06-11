/**
 * Root ESLint configuration for the Pangolin Scale monorepo.
 *
 * Uses the legacy `.eslintrc.*` format (ESLint 8.x). Per-package configs
 * may extend this with package-specific rules.
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
    // The namespaced sub-API installers in pangolin-client deliberately capture
    // `const client = this` inside prototype getters (one inner factory is a
    // non-arrow function that needs the explicit reference). Permit that one
    // alias name; any other `this` alias still errors.
    '@typescript-eslint/no-this-alias': ['error', { allowedNames: ['client'] }],
  },
  env: {
    node: true,
    es2022: true,
  },
  rules: {
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      },
    ],
  },
  ignorePatterns: ['node_modules/', 'dist/', 'coverage/', '*.cjs'],
};
