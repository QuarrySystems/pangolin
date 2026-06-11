# Releasing

All packages are versioned **in lockstep** (one version for the whole workspace)
and published together. Releases are **manual today** — automation is planned but
not yet in place (see "Future" below).

## Cutting a release

1. **Land everything on `main`** and pull it locally.
2. **Bump the version** in every publishable `packages/*/package.json` to the new
   version (they must match so the `workspace:*` deps rewrite consistently on
   publish). Keep `pangolin-core` and its dependents in sync.
3. **Update [`CHANGELOG.md`](./CHANGELOG.md):** move the relevant notes from
   `[Unreleased]` into a new `## [x.y.z] - YYYY-MM-DD` section, and add the link
   references at the bottom.
4. **Build:** `pnpm -r run build`.
5. **Sanity-check** what will publish without uploading:
   `pnpm -r publish --dry-run --no-git-checks` (tarballs should contain only
   `dist/`, `README.md`, `LICENSE`, `package.json`).
6. **Publish to npm** (requires npm auth; the account has 2FA enforced on writes,
   so it prompts for a one-time code and reuses it across the batch):
   ```sh
   pnpm -r publish --access public
   ```
   `pnpm -r` resolves dependency order and is **resumable** — if a code expires
   mid-batch, re-run it and already-published versions are skipped.
7. **Tag and push** the annotated tag at the released commit:
   ```sh
   git tag -a vX.Y.Z -m "pangolin-scale vX.Y.Z"
   git push origin vX.Y.Z
   ```
8. **Create the GitHub release** from the tag (notes sourced from the changelog):
   ```sh
   gh release create vX.Y.Z --title "pangolin-scale vX.Y.Z" --notes-file <notes> --latest
   ```

## Notes

- The package set is private-to-publish-safe via `publishConfig.access: public`
  and a `files: ["dist", "README.md", "LICENSE"]` allowlist on every package.
- The worker OCI image is published separately to GHCR; make sure the image tag
  the docs/examples reference matches the released digest.

## Future (not yet implemented)

Automate publish on a `v*` tag push via a GitHub Actions workflow using an npm
**automation token** (bypasses interactive 2FA), with the release notes generated
from the changelog. Until that lands, follow the manual steps above.
