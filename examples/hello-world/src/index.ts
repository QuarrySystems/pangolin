// examples/hello-world/src/index.ts
//
// The §4.4 Hello World worked example. End-to-end runnable demonstration
// of the AgoraClient against the local-docker + local-storage providers:
//
//   1. Construct AgoraClient with the local stack (no AWS deps).
//   2. Register a capability, a subagent, and an env bundle.
//   3. Dispatch the subagent.
//   4. Print the resolved bundle refs and the captured stdout.
//
// The README walks through swapping in the Fargate + S3 production
// providers; the substitution is constructor-only — every other line in
// this file is identical.
//
// IMPORTANT: `main()` is exported (not auto-invoked on import) so the
// test file can pull `buildClient` and `main` symbols in without the
// import side-effect spinning a Docker container. The CLI entrypoint
// guard at the bottom of this file runs `main()` only when the module is
// invoked directly (e.g. `tsx src/index.ts`).

import {
  AgoraClient,
  NoopCredentialProvider,
  StdoutResultSink,
} from '@quarry-systems/agora-client';
import { LocalStorageProvider } from '@quarry-systems/agora-storage-local';
import { LocalDockerProvider } from '@quarry-systems/agora-providers-local-docker';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Build the example's AgoraClient against a fresh tmp storage root.
 *
 * Returned `cleanup` MUST be invoked (in a try/finally) to avoid leaking
 * the mkdtemp'd directory across runs — see the REFINEMENT note in the
 * task body that motivated this shape.
 *
 * Exported so the test file can construct the client without invoking
 * `main()`.
 */
export async function buildClient(): Promise<{
  storageRoot: string;
  client: AgoraClient;
  cleanup: () => Promise<void>;
}> {
  const storageRoot = await mkdtemp(join(tmpdir(), 'agora-hello-'));
  const client = new AgoraClient({
    namespace: 'hello-world',
    // `allowUnpinnedImage: true` so the example can be re-run locally
    // against a freshly-built worker image without the user first
    // resolving the digest. PRODUCTION dispatches must always be
    // digest-pinned per §7.4 — see the README for the Fargate variant
    // where this flag is removed.
    compute: { 'local-docker': new LocalDockerProvider({ allowUnpinnedImage: true }) },
    credentials: { none: new NoopCredentialProvider() },
    storage: new LocalStorageProvider({ rootDir: storageRoot }),
    targets: { local: { compute: 'local-docker', credentials: 'none' } },
    resultSink: new StdoutResultSink(),
  });
  const cleanup = async (): Promise<void> => {
    await rm(storageRoot, { recursive: true, force: true });
  };
  return { storageRoot, client, cleanup };
}

/**
 * End-to-end runnable: build a client, register a capability + subagent +
 * env bundle, dispatch the subagent against the local-docker target, and
 * print the resolved refs and captured stdout.
 *
 * The mkdtemp'd storage root is removed in a `finally` block so repeated
 * runs do not accumulate temp directories (the REFINEMENT mandated in the
 * task body).
 */
export async function main(): Promise<void> {
  const { storageRoot, client, cleanup } = await buildClient();
  try {
    await client.capabilities.register({
      name: 'echo-cap',
      files: {
        'agora-setup.sh': '#!/bin/sh\necho "hello from agora-worker"\n',
      },
    });
    await client.subagent.register({
      name: 'echo',
      systemPrompt: 'Just exit.',
      capabilities: ['echo-cap'],
    });
    // Thread the host's ANTHROPIC_API_KEY into the dispatch when present, so
    // the stock `claude-code` runtime adapter can authenticate and the dispatch
    // can reach a clean `exitCode: 0`. Without it, the dispatch reports
    // `provider-failed` (see the README).
    //
    // DEMO-ONLY shortcut: a real deployment passes credentials as per-dispatch
    // secrets (`work.secrets`) or `secretRefs` resolved against a secrets
    // manager — NOT as plaintext env-bundle values. This is fine for a local
    // hello-world whose tmp storage root is cleaned up on exit.
    const apiKey = process.env.ANTHROPIC_API_KEY;
    await client.env.register({
      name: 'minimal',
      values: {
        LOG_LEVEL: 'info',
        ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
      },
    });

    // The worker image MUST be available to the local Docker daemon for
    // this to succeed end-to-end. The placeholder `:latest` tag works
    // when you have built and tagged the worker locally; in production
    // (Fargate variant) this is always a digest-pinned reference.
    const result = await client.dispatch({
      subagent: 'echo',
      env: 'minimal',
      target: 'local',
      workerImage: 'ghcr.io/quarrysystems/agora-worker:latest',
    });

    console.log('\n=== resolved ===\n' + JSON.stringify(result.resolved, null, 2));
    console.log('\n=== stdout ===\n' + result.stdout);

    // Surface the dispatch OUTCOME honestly. `result.stdout` above is the
    // worker's structured-log stream, and the bundled `agora-setup.sh` runs
    // (and prints its greeting) regardless of whether the *runtime adapter*
    // step then succeeds. So printing stdout alone is NOT evidence of success.
    // A non-zero `exitCode` — or an infrastructural `failure` block — means the
    // dispatch did not succeed, and we must not let the process exit 0 and read
    // as a clean run.
    if (result.exitCode !== 0 || result.failure) {
      console.error(
        '\n=== dispatch FAILED ===\n' +
          `exitCode: ${result.exitCode}\n` +
          (result.failure
            ? `reason:   ${result.failure.reason}\ndetail:   ${result.failure.detail}\n`
            : '') +
          (result.stderr ? `stderr:   ${result.stderr}\n` : '') +
          '\nThe stock worker image runs the `claude-code` runtime adapter, which\n' +
          'requires an ANTHROPIC_API_KEY. Without one the adapter exits non-zero and\n' +
          'the dispatch is reported as `provider-failed`. See this example’s README.',
      );
      throw new Error(
        `dispatch ${result.dispatchId} did not succeed (exitCode ${result.exitCode})`,
      );
    }

    console.log('\n=== dispatch OK ===');
    void storageRoot; // surfaced for readers / debugging; not used post-cleanup
  } finally {
    // REFINEMENT: rm the mkdtemp'd storage root so each run does not leak
    // a temp directory. Runs on both success and exception paths.
    await cleanup();
  }
}

// CLI entrypoint guard. We invoke `main()` only when this module is the
// actual entry point (e.g. `tsx src/index.ts`). Under vitest, the test
// file imports this module and the guard is false, so `main()` is not
// invoked as an import side-effect. We surface the resolved guard value
// as an export (`__mainInvokedOnImport`) so the test can pin this
// behavior directly — without that pin, a careless refactor could
// silently re-enable side-effectful invocation and the test would not
// catch it (the failed dispatch promise rejection happens after the
// test resolves).
const isDirectInvocation =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

export const __mainInvokedOnImport = isDirectInvocation;

if (isDirectInvocation) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
