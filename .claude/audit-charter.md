# Audit charter — pangolin

Grown from audit records, not authored up front. Each entry earned its place by
appearing in a real audit; each cites code. **Where an entry and the code
disagree, the code wins** — and the stale entry is itself a finding worth
reporting.

Sections absent from this file (hard invariants, named reference
implementations, frozen decisions) have not been earned yet. Add them when an
audit produces one, not before.

---

## Enforcement map

What is actually enforced, and by what. A lens grades an unenforced convention
as DEFERRED, so getting this wrong changes verdicts.

| Rule | Enforced by | Consequence if violated |
|---|---|---|
| `src` type safety | `.github/workflows/typecheck.yml:49` — `pnpm -r typecheck`, every package | CI failure |
| **`test` type safety** | `.github/workflows/typecheck.yml:57` — `pnpm -r typecheck:test`, **opt-in per package** | **In the 10 packages without `tsconfig.test.json`, nothing. The gate passes green.** |
| Test-file lint | every package's `lint` script is `eslint src test --ext .ts`; CI at `.github/workflows/ci.yml:56` | CI failure |
| MCP tool surface | CI allowlist check per ADR-0005 | CI failure on any added tool name |
| Undeclared deps in built output | `pnpm run check:deps` (`ci.yml:53`) → `scripts/check-declared-deps.mjs` — a static scan asserting every bare specifier in built `dist/` is a Node builtin or a declared dep | CI failure |
| Workspace dep **cycles** | **nothing.** `check:deps` is not a cycle detector — it contains no graph traversal | drift only; surfaces as a `pnpm -r build` ordering failure on clean CI |
| Type safety of root `test/` and `examples/manifest/` | **nothing** — and they are not merely unchecked, they are outside the workspace. `pnpm-workspace.yaml` globs `packages/*`, `examples/*`, `deploy/*`, `docs-site`; root `test/` matches none of them, and `examples/manifest/` has no `package.json` so pnpm skips it despite the glob. Root `typecheck` is `pnpm -r run typecheck` (`package.json:15`), so both are invisible to it | none at type level. Root `test/` **is executed** by `pnpm test:e2e` (`.github/workflows/e2e.yml:60`), so it fails only on a runtime error — a type error there is undetectable by any gate |

**The `typecheck:test` opt-in is the highest-value row here.** Six packages have
`tsconfig.test.json` (`pangolin-product`, `pangolin-providers-aws-creds`,
`pangolin-secret-store`, `pangolin-signer-aws-kms`, `pangolin-storage-local`,
`pangolin-storage-s3`). Ten do not — including **`pangolin-cli`**, whose
`tsconfig.json:7` is `"include": ["src/**/*"]` with no test counterpart. `pnpm -r`
silently skips packages that do not define the script, so the gate reports success
having checked nothing in those ten. The remaining debt is 213 errors, tracked in
issue #99 and documented in `.eslintrc.cjs:51-54`.

Practical consequence for a lens: **in the ten opted-out packages, a type error in
a test file is not a build failure — it does not exist.** Any finding whose
detection story is "the compiler would catch it in the fixtures" is wrong there.
Check for `tsconfig.test.json` before grading such a finding DEFERRED.

`.eslintrc.cjs:44-61` relaxes `no-explicit-any` and `no-control-regex` in test
files. The config's own comment (`:51-54`) is explicit that this is a lint
relaxation only and confers no type safety — do not read the relaxation as
blessing untyped doubles.

---

## Recurring bug classes

Mistakes this repo has made more than once. The highest-value entries here,
because they are exactly what a generic auditor cannot know.

- **Green tests, dead runnable artifact.** *Tell:* the entrypoint or wiring line
  that real invocation goes through is constructed differently by tests than by
  production, so no test executes the production path. *Check:* find the single
  real construction/invocation site and grep for a test that drives *it* — not a
  test that builds its own equivalent. *Why tests miss it:* the test imports the
  inner function directly and bypasses the guard entirely.
  - Instance 1 (PR #89): an example's CLI guard used `endsWith('src/index')`,
    which never matches under tsx's `src/index.ts` → silent exit-0 no-op. Passed
    three reviewers. The corrected idiom is now used repo-wide, e.g.
    `examples/dogfood-gated/src/index.ts:582`.
  - Instance 2 (2026-07-29 sync-provider-spi audit, findings B2/B3): a proposed
    third `CliContext` member would be unwired at
    `packages/pangolin-cli/src/index.ts:110` — the sole real construction site —
    while all 11 test fixtures inject their own context.
    `test/bin-entry.test.ts:5-7` builds a stub and never calls `parseAsync`; no
    test spawns the `pangolin` bin. **`:110` sits inside
    `if (typeof require !== 'undefined' && require.main === module)`
    (`index.ts:109`), so no vitest run can ever execute it.**
    - *Corrected 2026-07-30 (round 2).* The first version of this entry said
      "typecheck stays green." **Wrong, and the error propagated into a spec.**
      `:110` is in `src/`, which `tsconfig.json:7` does include, so a missing
      **required** member is TS2345 and fails `pnpm -r typecheck` and
      `pnpm -r build`. The compiler is the guard.
    - The real hazard is therefore narrower and sharper: **the compiler is the
      *only* guard**, so anything that weakens the type — declaring the member
      optional, or calling it with `?.` — removes all detection at once and
      restores a silent failure. When a red fixture pushes an implementer toward
      exactly that repair, the fix direction must be stated in the spec.

- **Sealed or generated artifacts caught in repo-wide edits.** *Tell:* a rename,
  substitution, or codemod whose scope includes committed build output, sealed
  bundles, or fixtures with embedded hashes. *Check:* does the change's file glob
  intersect anything content-addressed? *Why tests miss it:* the artifact is data,
  not code, so nothing compiles or lints it — verification fails only at
  `verify` time, if at all. Instance: PR #59's `agora://` → `pangolin://`
  substitution rewrote `examples/dogfood-gated/bundle.json` and broke its hash
  chain.

- **A required member is added to a widely-constructed context type, and the
  call sites that no longer satisfy it all sit in type-check-exempt zones.**
  *Tell:* a shared context/options interface gains a required field; existing
  construction sites pass a partial object literal and keep building.
  *Check:* enumerate every construction site, then ask **which tsconfig covers
  each one** — not whether the build passes. Three zones here are covered by
  none (see the enforcement map): `packages/*/test/` in the ten packages without
  `tsconfig.test.json`, root `test/`, and `examples/manifest/`.
  *Why tests miss it:* those sites are executed but never type-checked, so a
  partial literal fails only if the missing member is actually dereferenced at
  runtime. A site that never reaches the new code path stays green indefinitely.
  - Instance (2026-07-30, sync-provider SPI): `CliContext` went from two required
    members to three. Of ~46 construction sites, exactly one —
    `packages/pangolin-cli/test/cmd-subagent.test.ts` at the `--provider made-up`
    case — reached the new seam and went red. Fixed by widening the fixture.
  - The durable finding is the two that did **not** go red.
    `test/e2e/manifest-deploy.test.ts:189` and
    `examples/manifest/test/deploy.test.ts:145` both call `buildProgram` with
    `{ getClient }` alone. They were **already** missing the required
    `getOrchContext` before that change — type-invalid for some time, with
    nothing surfacing it. Both import by relative source path
    (`../../packages/pangolin-cli/src/index.js`), so the package's `exports` map
    does not reach them either.
  - Consequence for a lens: **"adding a required member is safe, the compiler
    will catch every call site" is false in this repo.** Verify per zone before
    relying on it. The converse holds too — a partial-literal call site that
    compiles today is not evidence the type is satisfied.

- **A task claims to mirror an existing field's route, without opening every file
  that route touches.** *Tell:* task prose says "exactly as `X` already is" or
  "mirroring `X` one-for-one", and its `files:` list is shorter than `X`'s actual
  path. *Check:* grep the mirrored symbol across `packages/*/src` and enumerate
  every file it appears in; compare that set to the task's `files:`. *Why review
  misses it:* each task reads correct in isolation, the DAG validates clean, and
  the omission is a file **nobody declared** — so file-disjointness checks, which
  compare declared sets, cannot see it.
  - Instance (2026-08-03, dependency-cache gate-2 audit): four blocking findings
    in one plan, all this shape. The plan mirrored `verify`'s route to the audit
    export and declared two of its five files. The missing three were
    `packages/pangolin-core/src/product.ts` (the actual home of `OutputSentinel`,
    which the plan placed in `pangolin-worker`),
    `packages/pangolin-orchestrator/src/contracts/types.ts` (`ItemState`), and —
    the one that would have made the whole feature inert —
    `packages/pangolin-product/src/sentinel-parse.ts`.
  - **`parseOutputSentinel` is an allowlist reconstructor.** It rebuilds
    `patchRef`, `summary`, `verify`, `outputs`, `usage`, `blocks` by hand from
    type-guarded reads and **discards every other field** (`sentinel-parse.ts:119-138`,
    per its own header rule). Any new sentinel field without a `build<Field>`
    counterpart is silently dropped on every orchestrator-side read, while the
    worker writes it correctly and every test on both sides passes.

---

## Named reference implementations

The file to mirror, per layer. A blanket "follow the existing pattern" is a
finding; so is pointing at the wrong one of several plausible candidates.

| Layer | Mirror this | Not this |
|---|---|---|
| Self-verifying container script | `scripts/verify-patch-capture-env.mjs` — carries the Arm-A positive control (the probe must *find* a planted value in the same run, or the run is void) | `scripts/verify-proc-exposure.mjs` — same family, but its arms are shaped for a security tripwire rather than a measurement |
| Sentinel field reconstructor | `buildVerify`, `packages/pangolin-product/src/sentinel-parse.ts:31-41` — per-field type guards, partial input yields `undefined` rather than a half-built object | a spread or `Object.assign` of the parsed input |
| Client env-emission test | the stub-`ComputeProvider` capturing `TaskSpec.env` from a real `fire()`, `packages/pangolin-client/test/dispatch-model.test.ts:100-159` | there is **no** `buildWorkerEnv` symbol in this repo (`grep` across `packages/**/*.ts` → 0); the dispatched env is only observable through a real `fire()` |
| Run-state migration test | a **file-backed** DB created with the pre-change schema via raw `better-sqlite3`, closed, then reopened through `SqliteRunStateStore` | `:memory:`, which cannot express a pre-existing schema and so cannot go red when a migration entry is missing |
| POSIX-only lifecycle test | the `itPosix` idiom at `packages/pangolin-worker/test/setup-script.test.ts:30` | a bare `it` that fails on Windows contributors' machines |

---

## Verification gotchas

Commands that can report success while having failed, and what to run instead.

- `pnpm -r typecheck:test` — passes for the ten packages that do not define the
  script, having checked nothing → confirm the package has a `tsconfig.test.json`
  before trusting it. See the enforcement map above.
- `pnpm -r test` + `pnpm -r lint` + `pnpm -r typecheck` all green — does not
  establish that the shipped binary or example runs. Nothing in `test/e2e/` spawns
  the `pangolin` bin (`packages/pangolin-mcp`'s surface test is the only bin
  spawn) → run the runnable artifact, not only its tests.
- A missing-export or stale-type failure after a worktree switch or branch sync —
  frequently a stale `dist/`, not a real defect → `pnpm install && pnpm -r build`
  before believing it.
- **A `grep -c` acceptance criterion.** It returns `0` **and exits 1** when there
  are no matches, so under `set -e` it aborts the surrounding script rather than
  reporting a clean result — and it is case-sensitive, so `grep -c binds` misses
  `Binds`. It is also frequently satisfied *before any work is done*, making it a
  criterion that cannot fail. → scope the grep to the new content
  (`grep -A6 '<anchor>'`) and name any pre-existing matches as expected and
  out of scope, or satisfying the criterion literally means deleting correct
  content. Instance: 2026-08-03 dependency-cache audit, findings B10 and M24.
- **A byte-level absence probe that reports nothing.** `grep -qP '\x00'` reported
  no NUL bytes in a file that contains two (`packages/pangolin-worker/src/overlay-engine.ts`,
  before #145) — `-P` is unavailable in some builds and the check fails silently
  rather than erroring. → confirm an absence result with a byte-level read
  (`node -e` over a `Buffer`) before believing it, and pair it with a positive
  control. Same lesson the `/proc` spec §3a records for `wc -c < /proc/self/environ`,
  which reads 0 bytes with the credential plainly present.
- **A green local run of a suite containing a `itPosix`/Docker-gated test.** On
  Windows those tests do not run, so a *newly authored* one has never executed
  anywhere — its first execution is its first CI run, with no prior green to
  regress from. Local output reports this honestly and it is easy to read past:
  `6 passed | 1 skipped` where the 1 was the only test covering the new path. →
  read the **skip count**, not just the pass count, and treat a nonzero skip in
  the suite you just wrote as "unverified", not "passed". Instance: 2026-08-03,
  #152's `entrypoint-context.test.ts` — the setup script it staged died with 127
  because the test's own env bundle replaces `PATH`, leaving bare `mkdir`/`chmod`
  unresolvable; the dispatch failed at step 9 and never reached the check under
  test. Reproducible in seconds under `docker run node:20`, which is the cheap
  move when the gated test cannot run locally. (Note the near-miss: the obvious
  fix — widening the bundle's `PATH` — also goes green while destroying the
  test, since a real `pnpm` on a system dir would then satisfy the `exec`
  requirement with the setup script having done nothing.)
