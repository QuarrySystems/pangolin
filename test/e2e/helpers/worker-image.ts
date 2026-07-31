// Pinned worker image reference shared by every Docker-using E2E test.
//
// Precedence:
//   1. `PANGOLIN_E2E_WORKER_IMAGE` env var (CI override — bump this when a newer
//      digest lands and the suite needs to retest against it without a code
//      change).
//   2. The pinned digest below — the immutable digest of the v0.5.0
//      tagged release of `ghcr.io/quarrysystems/pangolin-worker` (workflow run
//      30666626195, pushed 2026-07-31). Refresh when cutting a new tagged
//      release; the pangolin-worker-image workflow emits the digest in its
//      `Summary` step output for easy copy-paste.
//
//      This pin sat on the v0.1.0 digest (2026-05-22) through 0.2.0, 0.3.x and
//      0.4.0 — four releases during which these tests exercised a months-old
//      worker while worker code kept changing underneath them. The refresh is
//      now a numbered step in RELEASING.md; it is the difference between this
//      suite testing what we ship and testing what we shipped in May.
//
// Both forms must be digest-pinned (`name@sha256:<64-hex>`) per §7.4 — the
// `LocalDockerProvider` raises `UnpinnedImageError` otherwise. Passing a
// `:tag` instead of a digest is therefore a wiring bug, not a soft-fail.
export const WORKER_IMAGE =
  process.env.PANGOLIN_E2E_WORKER_IMAGE ??
  'ghcr.io/quarrysystems/pangolin-worker@sha256:48062d3f6ee90d773b0ee03437093c0c487c89caaf61c1a5c6460f427f303034';
