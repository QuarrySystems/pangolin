#!/usr/bin/env node
// Container entrypoint for the stock pangolin-worker OCI image.
//
// The image places this file at /opt/pangolin/worker/bin/pangolin-worker-entry.mjs
// so that Node module resolution from this directory finds the deployed
// worker package at /opt/pangolin/worker/node_modules/. The worker reads its
// configuration from the PANGOLIN_* env vars documented in spec §6.1.
//
// Exit codes match runWorker()'s contract:
//   - 0 on `dispatch.finished` or a valid `dispatch.needs_input` sentinel
//   - the runtime's exit code on a non-zero runtime exit
//   - 1 on any worker-side failure (integrity, fetch, setup, sentinel parse)

import { runWorker } from '../dist/index.js';
import { restoreCredentials } from '../dist/credential-restore.js';

// C1'-restore, half two (spec §7.3). The container ENTRYPOINT `exec`ed us with a
// CLEAN environment and handed the real one over an inherited fd. Restore it
// into `process.env` BEFORE anything reads a credential.
//
// This is the ONLY call site that passes the real process environment — every
// `runWorker(...)` in tests passes a synthetic object, so no test at that level
// can prove this works. The container tripwire
// (`scripts/verify-proc-exposure.mjs`) is what actually gates it.
//
// Values written here live in the process heap and are invisible to
// /proc/<pid>/environ, which is fixed at execve. That asymmetry is the whole
// mechanism: the AWS SDK's credential chain sees them, a same-uid agent reading
// /proc does not.
//
// No fd means no hand-off — an image still running the old CMD directly behaves
// exactly as before. An unreadable fd THROWS rather than degrading: a silent
// fallback would walk the credential chain into an IMDS timeout on the
// post-agent upload path, losing work that is already done.
try {
  const restored = restoreCredentials(process.env);
  if (restored.length > 0) {
    // Names only, never values.
    console.error(`[pangolin-worker-entry] restored ${restored.length} env var(s) post-exec`);
  }
} catch (err) {
  console.error('[pangolin-worker-entry] credential restore failed:', err);
  process.exit(1);
}

const controller = new AbortController();
process.on('SIGTERM', () => controller.abort());

runWorker(process.env, { terminationSignal: controller.signal })
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[pangolin-worker-entry] uncaught:', err);
    process.exit(1);
  });
