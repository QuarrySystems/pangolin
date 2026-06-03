# dogfood-selftest — agora offloads work on agora

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

## Run it (LIVE — needs Docker + an Anthropic key)

```sh
# from this dir, with ../../.env containing ANTHROPIC_API_KEY
pnpm start:env
# or: export ANTHROPIC_API_KEY=sk-ant-... && pnpm start
```

Prerequisites:
- Docker reachable (local Desktop, or `DOCKER_HOST` → a remote daemon).
- `ghcr.io/quarrysystems/agora-worker:latest` pullable.
- `ANTHROPIC_API_KEY` set.

The run submits `plan.json`, fans out under concurrency 2, downloads each item's
patch to `./patches/<item>.patch`, and prints the audit bundle (`intact`, `claim`,
`guarantee`).

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
