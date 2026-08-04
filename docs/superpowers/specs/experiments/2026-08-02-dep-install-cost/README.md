# Dependency install cost — the decision gate for the transport half

Discharges `task-measure-install-cost` in
[`../../../plans/2026-08-02-dependency-cache-and-evidence-dag.md`](../../../plans/2026-08-02-dependency-cache-and-evidence-dag.md),
which gates the transport tasks of
[`../../2026-08-02-dependency-cache-and-evidence-design.md`](../../2026-08-02-dependency-cache-and-evidence-design.md).

Spec §8 recorded the reason this runs first: *"a cold `pnpm install` over a real
lockfile was NOT measured and is the real risk; sizing it is the first task of
any plan, before the cache is assumed to help."*

## Verdict

**`cache-not-justified`** — comparing the **full arm's 14 s** against the 120 s
`PANGOLIN_SETUP_TIMEOUT_SECONDS` default (`env-parser.ts:202`, verified literal).

A cold, complete, dev-inclusive install of this repo's own lockfile finishes in
roughly **one eighth** of the setup budget. Installing per dispatch is already
viable, so the *latency* argument for `depCacheDir` does not survive contact with
a measurement. See "What this does not establish" before treating that as a
decision about the whole design.

## Numbers

Measured 2026-08-03 against `ghcr.io/quarrysystems/pangolin-worker:main`,
image id `sha256:31b6684fbba59fb05f4711e9ccbc2e836793cc65bc67be3b18dd886f3372d49d`.

| Arm | `elapsed_seconds` | Notes |
|---|---|---|
| `--arm=toolchain` | **2–3** | `npm i -g pnpm` into `$HOME`. Two runs gave 3 s and 2 s. Spec §2 hand-measured 2 s; the AC treats >30 s as evidence the arm measures the wrong thing. |
| `--arm=full` | **14** | Cold `pnpm install --frozen-lockfile --prod=false`, 70 manifests, 931 package dirs, store empty at start. Earlier prod-only runs gave 12–13 s (see the `NODE_ENV` finding). |

Both arms report whole seconds, and repeated runs vary by ~1 s. Nothing here
turns on that precision: the verdict compares 14 against 120, and a margin of
that size is not sensitive to a second either way.

Supporting counts: `installed_packages:931`, `lockfile_resolutions:1052`,
`manifests_copied:70`.

`931 < 1052` is expected and not a partial install — the lockfile carries
platform-specific optional binaries (rollup/esbuild/swc variants for
darwin/win32/musl) that a linux-x64 install correctly skips. An early version of
this harness gated on a 0.9 ratio between those two numbers and failed a
perfectly healthy install; the completeness signal is named packages instead.

## Finding: `NODE_ENV=production` silently drops devDependencies

**This was not in the spec, and it is the most consequential thing the
measurement turned up.**

The worker image bakes `NODE_ENV=production` (`docker image inspect … Config.Env`).
`NODE_ENV` is on the runtime env firewall's `BUILTIN_ALLOW`
(`runtime-env-filter.ts:78`), so it survives filtering, rides in `mergedEnv`, and
reaches `pangolin-setup.sh`, which is spawned with `env: mergedEnv`
(`entrypoint.ts:492`). Every link in that chain was verified.

Consequence: a consumer whose setup script runs a bare
`pnpm install --frozen-lockfile` gets a **production-only tree**. Measured here:
**802 packages instead of 931**, with `vitest` absent. The install **exits 0**.
Their `tsc` or test-suite gate then fails for a reason that looks nothing like
the cause.

That is spec §1's driver 1 — *"a dispatched verifier receives a workspace with no
toolchain, so it cannot execute `tsc` or a test suite"* — recurring one layer
deeper, past the two traps §2 already documents. It is a **third** required half
of the toolchain recipe, alongside `NPM_CONFIG_PREFIX` and the env-bundle `PATH`:

```sh
pnpm install --frozen-lockfile --prod=false   # or export NODE_ENV=development
```

Spec §7's documentation obligation and the DAG's `task-document-toolchain-recipe`
are both written as a *two*-half recipe. Both need a third.

## What this does not establish

The gate answers exactly one question — does a cold install fit inside the setup
timeout — and the answer is yes, comfortably. It does **not** retire the other
arguments for `depCacheDir`, and none of the following were measured:

- **Egress-less environments.** On Fargate `assignPublicIp` defaults to
  `'DISABLED'` (`providers-fargate/src/index.ts:136-141`); a private subnet with
  no NAT has *no* registry reachability, so the install does not get slower, it
  fails outright. A mounted cache is a correctness mechanism there, not a speed
  one. This is a different justification than the one the gate tests, and it
  survives the verdict above.
- **A warm cache versus this 14 s.** No arm measures the cached case, so the
  cache's actual saving is unquantified. Spec §8's "no measurement yet exists
  that the cache is faster than a warm in-VPC registry" remains true.
- **Other consumers' lockfiles.** One repo, 1052 resolutions. A substantially
  larger tree could approach 120 s.
- **A developer-workstation network.** Measured over a fast public link to the
  npm CDN, with ~10 unrelated containers competing for CPU. In-VPC or
  rate-limited conditions were not tested.
- **Concurrent store access** from parallel dispatches sharing one mount
  (spec §8, still unmeasured).

## Running it

```sh
node docs/superpowers/specs/experiments/2026-08-02-dep-install-cost/measure.mjs --arm=toolchain
node docs/superpowers/specs/experiments/2026-08-02-dep-install-cost/measure.mjs --arm=full
```

`PANGOLIN_WORKER_IMAGE` overrides the image. The image must be present locally —
it is not anonymously pullable.

The harness is framework-free and self-verifying, mirroring
`scripts/verify-patch-capture-env.mjs`; vitest is not in the image. It **fails
loudly rather than skipping**, which is the property the AC cares about most: a
measurement harness that can silently report nothing is the failure this gate
exists to prevent. Verified negative controls — each exits non-zero:

| Control | Result |
|---|---|
| no `--arm` | `FAIL: usage:` |
| `PANGOLIN_WORKER_IMAGE` set to a nonexistent image | `FAIL: … not available locally` |
| `docker` absent from `PATH` | `FAIL: docker is not available — this measurement must never skip` |
| mount missing, so `/w` is absent | `FAIL: … a failed install is NOT a measurement` (caught a real bug in this harness) |
| a package expected after install is absent | `FAIL: … partial install, not a measurement` (caught the `NODE_ENV` finding) |

Both of the last two fired against real defects during authoring rather than
being hypothetical.

**Cold is load-bearing.** The repo is mounted read-only and only the manifests
are copied in; the arm asserts `node_modules` is absent *before* it starts
timing. The plan's original snippet did `cp -r /w /build`, which would have
carried the worktree's existing ~800 MB `node_modules` into the build dir —
`pnpm install` would have found the tree already satisfied and reported a
fast number that measured nothing.
