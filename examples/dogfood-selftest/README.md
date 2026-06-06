# dogfood-selftest — agora offloads work on agora

## Run 2 (current): a DEPENDENT chain via the typed-product handoff

Run 1 (below) proved independent fan-out; its four patches landed as PR #36.
**Run 2 proves the new thing**: two tasks where B genuinely builds on A's edit,
wired by `needs` — the typed-product handoff (PRs #39/#40/#41) exercised LIVE
with real Claude Code workers on agora's own tree.

| Item | Target (locked) | What |
|---|---|---|
| `readme-handoff-section` | `README.md` | add a Typed-product handoff section under `## Offload` |
| `docs-handoff-page` | `docs-site/src/content/docs/explanation/typed-product-handoff.md` *(new)* | **needs A's patch** — applied to its workspace pre-run; writes the docs page consistent with A's actual wording |

What the run exercises end-to-end, live:

- `needs` declaration only (no hand-written `depends_on` on B) → submit-gate
  auto-union + whole-DAG validation.
- Resolve-at-fire → B's worker fetch-verifies A's patch and materializes it at
  `inputs/patch`.
- A capability-shipped `agora-setup.sh` (`git init -q && git apply inputs/patch`)
  applies it BEFORE the agent runs — so B's baseline contains A's edit and B's
  escaped patch is ONLY B's own work.
- Consumed/produced refs are sealed in the evidence; the driver re-verifies with
  `verifyBundle` and **exits non-zero unless `intact` AND `checks.handoff.ok` —
  the provenance-closure row, green on a real run, is the acceptance criterion.**

Worker image: `ghcr.io/quarrysystems/agora-worker:main` (carries the Wave A–C
worker code; `:latest` only rolls on v* tags and is still pre-handoff — do not
use it for this run).

```sh
# from this dir, with ../../.env containing ANTHROPIC_API_KEY
pnpm start:env
# or: export ANTHROPIC_API_KEY=sk-ant-... && pnpm start
```

Review afterwards, in order, from the repo root:

```sh
git apply --stat examples/dogfood-selftest/patches/readme-handoff-section.patch
git apply        examples/dogfood-selftest/patches/readme-handoff-section.patch
git apply --stat examples/dogfood-selftest/patches/docs-handoff-page.patch
git apply        examples/dogfood-selftest/patches/docs-handoff-page.patch
```

Run-1's plan is preserved at `plan-run1.json`; its raw (pre-review) worker
outputs live under `patches/raw-outputs/` — the reviewed versions merged as #36.

---

# Run 1 (history): independent 4-task fan-out

The first **dogfood run**: agora dispatches 4 real, file-disjoint maintenance
tasks on its **own source tree** to parallel Claude Code workers, escapes a
reviewable patch per task, and seals a tamper-detecting audit bundle.

This is the trunk — *"fire agent work off to remote compute, get reviewable
patches back, with an audit trail"* — pointed at agora itself.

## The 4 tasks (file-disjoint → clean fan-out under per-file locks)

| Item | Output file (locked) | What |
|---|---|---|
| `test-cli-sync` | `packages/agora-cli/test/sync.test.ts` *(new)* | unit-test `runSync()` |
| `test-client-errors` | `packages/agora-client/test/errors.test.ts` *(new)* | unit-test the error class |
| `tighten-dispatch-rooturi` | `packages/agora-client/src/dispatch.ts` | remove an `as unknown as` cast |
| `tighten-manifest-parser-casts` | `packages/agora-cli/src/manifest-parser.ts` | remove three `as unknown[]` casts |

## Tier 0 — what this run is and isn't

The stock worker image (`ghcr.io/quarrysystems/agora-worker`) bundles Claude Code
+ git, **not** the agora toolchain. So each worker's workspace is seeded with only
the source files its task needs (at real repo paths), the agent edits them **blind
to the build** — it cannot run `vitest`/`tsc` on its own work — and the patch
escapes. **You + CI are the verifier:** review each `patches/*.patch`, `git apply`
the good ones, and let CI confirm.

When hand-reviewing every patch becomes the bottleneck, that pain pulls **Gap A**
(a toolchain-capable worker image so the worker self-verifies). That is the *next*
build — pulled by felt pain, not pre-built.
*(Run-1 epilogue: Gap A indeed shipped next, as PR #37 — in-worker self-verify;
the full agora toolchain image remains unpulled.)*

## After the run

```sh
# from the repo root, inspect + apply a patch
git apply --stat examples/dogfood-selftest/patches/test-cli-sync.patch
git apply        examples/dogfood-selftest/patches/test-cli-sync.patch
pnpm --filter @quarry-systems/agora-cli test     # CI/you verify
```

Apply the patches you like, drop the ones you don't — the point of run 1 is to
feel the loop on real work and learn **which pain hits first** (review effort →
Gap A; hand-rolling prompts → the typed `dev` pack; applying by hand → the
autonomous-PR layer). That ordering is your earned V1.1 priority signal.
