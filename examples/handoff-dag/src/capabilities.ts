// Shared capability file contents for the handoff-dag example.
//
// Exporting these as named constants allows the test suite to assert on their
// content without importing src/index.ts (which has a live-run API key guard).

/**
 * agora-setup.sh for the apply-patch capability.
 *
 * The worker workspace is a fresh mkdtemp'd directory — it is NOT a git
 * repository when setup runs (captureBaseline's `git init` happens after
 * agora-setup.sh in the worker lifecycle).  We therefore initialise the
 * repo ourselves before calling `git apply`.
 */
export const APPLY_PATCH_SETUP_SH =
  '#!/bin/sh\nset -e\ngit init -q\ngit apply inputs/patch.diff\n';
