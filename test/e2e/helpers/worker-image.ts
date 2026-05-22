// Pinned worker image reference shared by every Docker-using E2E test.
//
// Precedence:
//   1. `AGORA_E2E_WORKER_IMAGE` env var (CI override — bump this when a newer
//      digest lands and the suite needs to retest against it without a code
//      change).
//   2. The pinned digest below — the immutable digest of the first published
//      `ghcr.io/quarrysystems/agora-worker:main` (workflow run 26311773642,
//      pushed 2026-05-22). Refresh when the worker bundle materially
//      changes; the agora-worker-image workflow emits the digest in its
//      `Summary` step output for easy copy-paste.
//
// Both forms must be digest-pinned (`name@sha256:<64-hex>`) per §7.4 — the
// `LocalDockerProvider` raises `UnpinnedImageError` otherwise. Passing a
// `:tag` instead of a digest is therefore a wiring bug, not a soft-fail.
export const WORKER_IMAGE =
  process.env.AGORA_E2E_WORKER_IMAGE ??
  'ghcr.io/quarrysystems/agora-worker@sha256:d694af83cfd4f2f5c4d22fcbfea6b8c39e981e8eaca1348c4c08f4d3823aee96';
