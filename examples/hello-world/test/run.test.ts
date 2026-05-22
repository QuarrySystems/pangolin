// `examples/hello-world/test/run.test.ts`
//
// Minimum-viable smoke test for the §4.4 worked Hello World example.
//
// The acceptance bar for this test is intentionally narrow: prove the
// example is wired correctly enough that a downstream user could trust
// `pnpm -F hello-world-example build` as their on-ramp signal. Specifically:
//
//   1. The module imports without side-effects. The runnable's `main()`
//      function MUST NOT execute on import — otherwise pulling the example
//      into a test harness would try to talk to the local Docker daemon.
//   2. The module exposes a `main` function that exists and is callable
//      (the body itself is exercised end-to-end only when Docker is
//      available, which we don't assume in CI).
//   3. The module wires up an `AgoraClient` whose construction doesn't
//      throw — this is the smallest possible "did the imports resolve and
//      the option shape validate" check and is what proves the build.
//
// We do NOT here attempt to dispatch — that requires Docker and a real
// worker image, both out of scope for a unit test.

import { describe, it, expect } from 'vitest';

describe('hello-world example', () => {
  it('exports a callable `main` from src/index.ts', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.main).toBe('function');
  });

  it('does not invoke main() as a side-effect of import', async () => {
    // The module exports a `__mainInvokedOnImport` constant computed from
    // the CLI entrypoint guard. Under vitest, the guard is false because
    // the test runner — not this module — is the actual entrypoint. This
    // assertion pins that behavior so a refactor that drops the guard
    // would fail loudly here, instead of silently kicking off Docker
    // calls on every test run.
    const mod = await import('../src/index.js');
    expect(mod.__mainInvokedOnImport).toBe(false);
  });

  it('buildClient() constructs an AgoraClient against fakes without throwing', async () => {
    const { buildClient } = await import('../src/index.js');
    const { storageRoot, client, cleanup } = await buildClient();
    try {
      expect(client).toBeDefined();
      expect(typeof storageRoot).toBe('string');
      expect(storageRoot.length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });
});
