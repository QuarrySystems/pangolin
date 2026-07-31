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
4. **Reinstall and build:** `pnpm install && pnpm -r run build`.
5. **Run the full gates — and check the test COUNT, not just the exit code:**

   ```sh
   pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e
   ```

   **`pnpm -r run test` aborts at the first failing package**
   (`ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`), so every package after it in the
   dependency order never runs. A release-time failure early in that order
   therefore looks like *one small assertion* while most of the suite silently
   did not execute.

   Cutting `0.5.0` produced exactly that: a single stale assertion in
   `pangolin-product` reported **175 tests passed against an expected 2298**, and
   fourteen packages had not run. Compare the total against the previous release
   before believing a green-ish run.

   That particular test hard-coded the release version, so it failed on *every*
   release; it now asserts lockstep against `pangolin-core` instead. If you ever
   add a version assertion, assert it **relatively** — a guard that must be
   hand-edited each release trains people to bump the number without asking what
   it protects.

6. **Sanity-check** what will publish without uploading:

   ```sh
   pnpm -r publish --dry-run --no-git-checks
   ```

   Check two things, in this order:

   - **Count the packages it lists — it must name every publishable package**
     (16 as of `0.5.0`):

     ```sh
     pnpm -r publish --dry-run --no-git-checks | grep -c '^+ @quarry-systems/'
     ```

     `pnpm -r publish` **silently skips any package whose version is already on
     the registry**, so a stale tree — wrong branch, or a bump that never landed —
     produces a dry-run that looks *successful* and is merely short. **If the
     count is lower than the number of publishable packages, STOP.** The bump is
     not in your working tree, and publishing would ship only whichever packages
     happen to be ahead of the registry, on their own.

     This is not hypothetical. Before `0.4.0`, `pangolin-product` sat at `0.4.0`
     and unpublished from the moment PR #97 added it, while the other fifteen
     were `0.3.1`. On any branch without the release commit, the dry-run printed
     exactly one package and no error. Publishing would have burned `0.4.0` on a
     lone package built from pre-release source, pinned (per step 2's rewrite) to
     `pangolin-core@0.3.1` — and npm versions are immutable, so the real release
     would have had to become `0.4.1`.

   - **Tarball contents** should be only `dist/`, `README.md`, `LICENSE`, and
     `package.json`.
7. **Publish to npm** (requires npm auth; the account has 2FA enforced on writes,
   so it prompts for a one-time code and reuses it across the batch):
   ```sh
   pnpm -r publish --access public
   ```
   `pnpm -r` resolves dependency order and is **resumable** — if a code expires
   mid-batch, re-run it and already-published versions are skipped.
8. **Tag and push** the annotated tag at the released commit:
   ```sh
   git tag -a vX.Y.Z -m "pangolin-scale vX.Y.Z"
   git push origin vX.Y.Z
   ```
9. **Create the GitHub release** from the tag (notes sourced from the changelog):
   ```sh
   gh release create vX.Y.Z --title "pangolin-scale vX.Y.Z" --notes-file <notes> --latest
   ```

## Notes

- **Publish with `pnpm`, never `npm`.** `pnpm publish` rewrites each
  `workspace:*` dependency to the concrete version being published
  (`"@quarry-systems/pangolin-core": "workspace:*"` becomes `"0.4.0"` in the
  tarball); `npm publish` ships the literal `workspace:*`, which no consumer can
  resolve. `pnpm -r` also publishes in dependency order, so no package is ever
  briefly on the registry pointing at a version that does not exist yet. This is
  the mechanism behind step 2's "they must match" — the rewrite targets whatever
  version each dep resolves to *at publish time*, so a mixed-version tree bakes a
  wrong pin into the tarball rather than failing loudly.
- The package set is private-to-publish-safe via `publishConfig.access: public`
  and a `files: ["dist", "README.md", "LICENSE"]` allowlist on every package.
- **The worker OCI image publishes itself — do not build or push it by hand.**
  `.github/workflows/pangolin-worker-image.yml` triggers on the `v*` tag push
  from step 8 and publishes `:latest`, `:X.Y.Z`, `:X.Y`, `:sha-…` and the
  immutable digest to `ghcr.io/quarrysystems/pangolin-worker`. (Note the GHCR
  namespace is the unhyphenated org slug, unlike the `@quarry-systems/*` npm
  scope.) It builds from **workspace source** — `COPY packages` then
  `pnpm install --frozen-lockfile` — not from the npm tarballs, so it does not
  depend on step 7 having completed. Watch it with
  `gh run list --workflow pangolin-worker-image.yml`; its **Summary** step prints
  the digest-pinned ref.

  Bumping the version does **not** dirty `pnpm-lock.yaml` (workspace importers
  record no version), so `--frozen-lockfile` stays valid across the bump. If that
  ever changes, the image build is where it will surface first.

- **Then refresh the E2E image pin.** `test/e2e/helpers/worker-image.ts` holds the
  digest every Docker-using E2E test runs against, and it does not update itself.
  It sat on the `v0.1.0` digest (2026-05-22) through `0.2.0`, `0.3.x` and `0.4.0`
  — four releases during which the suite tested a months-old worker while worker
  code kept changing. Paste the new digest from the workflow summary, re-run
  `pnpm test:e2e`, and open it as a normal PR: a failure there is a finding, not
  a chore.

## Future (not yet implemented)

Automate publish on a `v*` tag push via a GitHub Actions workflow using an npm
**automation token** (bypasses interactive 2FA), with the release notes generated
from the changelog. Until that lands, follow the manual steps above.
