// Pinned worker image reference shared by every Docker-using E2E test.
//
// Precedence:
//   1. `AGORA_E2E_WORKER_IMAGE` env var (CI override — used when the worker
//      image is published to a registry and digest-pinned by the pipeline).
//   2. The all-zero placeholder constant below (local-dev default — the MVP
//      worker image is not yet published, so this constant is a deliberate
//      sentinel rather than a real digest).
//
// Both forms must be digest-pinned (`name@sha256:<64-hex>`) per §7.4 — the
// `LocalDockerProvider` raises `UnpinnedImageError` otherwise. Passing a
// `:tag` instead of a digest is therefore a wiring bug, not a soft-fail.
//
// When the worker image is finally published, update the constant below to
// the real digest and drop the comment about the all-zero placeholder.
export const WORKER_IMAGE =
  process.env.AGORA_E2E_WORKER_IMAGE ??
  'ghcr.io/quarry-systems/agora-worker@sha256:0000000000000000000000000000000000000000000000000000000000000000';
