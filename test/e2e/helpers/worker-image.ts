// Pinned worker image reference shared by every Docker-using E2E test.
//
// Precedence:
//   1. `PANGOLIN_E2E_WORKER_IMAGE` env var (CI override — bump this when a newer
//      digest lands and the suite needs to retest against it without a code
//      change).
//   2. The pinned digest below — the immutable digest of the v0.1.0
//      tagged release of `ghcr.io/quarrysystems/pangolin-worker` (workflow run
//      26312255859, pushed 2026-05-22). Refresh when cutting a new tagged
//      release; the pangolin-worker-image workflow emits the digest in its
//      `Summary` step output for easy copy-paste.
//
// Both forms must be digest-pinned (`name@sha256:<64-hex>`) per §7.4 — the
// `LocalDockerProvider` raises `UnpinnedImageError` otherwise. Passing a
// `:tag` instead of a digest is therefore a wiring bug, not a soft-fail.
export const WORKER_IMAGE =
  process.env.PANGOLIN_E2E_WORKER_IMAGE ??
  'ghcr.io/quarrysystems/pangolin-worker@sha256:ef7d6e014609f93ac45cb64911f700b1cb936df03c52f73f2b4e2594d45142e2';
