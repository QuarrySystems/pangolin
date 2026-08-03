---
title: Dependency Cache and Sealed Dependency Evidence — Design
date: 2026-08-02
status: **DESIGNED — ready for a plan.** Scope agreed with the human partner over a brainstorming pass. Every load-bearing premise below was measured in the real worker image or read from the provider source; claims that were NOT measured are marked inline.
branch: spec/dependency-cache-and-evidence
authors: [human:Brett, agent:claude-opus-5]
severity: n/a (performance + audit surface; no existing control is falsified)
related:
  - ../../../deploy/serve-stack/KNOWN-ISSUES.md # issues 17, 17a, 17b, 19, 19a
  - ../../../docs-site/src/content/docs/explanation/decisions/0015-capability-size-cap.md # ADR-0015, which prescribes this shape
  - ../../../packages/pangolin-worker/src/setup-script.ts # the mechanism this builds on
  - ../../../packages/pangolin-worker/src/entrypoint.ts # step 9 / step 11 ordering
---

## 1. Problem

Two drivers, both from a real consumer (KNOWN-ISSUES 17):

1. **Gates cannot run.** A dispatched verifier receives a workspace with no
   toolchain, so it cannot execute `tsc` or a test suite. Two consecutive cycles
   passed verification and were then rejected by `tsc` on the consumer's machine
   — the class of failure a compiler catches instantly and a reviewer reading a
   patch does not.
2. **Installing per dispatch is slow.** Every dispatch gets a fresh container, so
   any dependency install starts from a cold store, every time.

Driver 1 already has an answer that works today (§2). Driver 2 does not, and is
what this design is for.

## 2. What is already true, and therefore not in scope

**Measured in `ghcr.io/quarrysystems/pangolin-worker:main` unless noted.**

- The image carries node v20.20.2, npm 10.8.2, git 2.39.5, bash 5.2.15, **no
  pnpm** — confirming the inventory in issue 17.
- **`pangolin-setup.sh` can install a toolchain at dispatch time.** Two traps,
  both measured, both avoidable:
  - The worker runs as **uid 1000 (`pangolin`)** and npm's global prefix is
    root-owned `/usr/local`, so a bare `npm i -g pnpm` fails with `EACCES` in
    about a second. Pointing `NPM_CONFIG_PREFIX` at `$HOME` (writable, as is
    `/workspace`) installs **pnpm 10.34.5 in 2 seconds**.
  - `pangolin-setup.sh` runs as a **separate process**, so its `export PATH` dies
    with it. After a setup script that exits 0 the binary is present but a later
    process with the inherited PATH gets `command not found`. The second half is
    an **env bundle** setting PATH, which wins because
    `baseEnv = filterRuntimeEnv(...)` is built first and bundles merge on top
    (`entrypoint.ts:474-478`, `env-merger.ts:27-31`).
- **Setup runs before the baseline is captured** — step 9 (`entrypoint.ts:487`)
  precedes `captureBaseline` (`:514`, "post-overlay, post-setup") — so anything
  installed is in the baseline and never appears in the captured patch.
- **Capture honours `.gitignore`.** Measured: an agent that adds a package
  mid-dispatch produces a **165-byte patch** containing the lockfile change, with
  no `node_modules` content. This is what makes §4's mid-dispatch case tractable.
- **Egress differs by provider.** local-docker sets no `NetworkMode` at all — its
  `HostConfig` is typed `{ Binds?, ExtraHosts? }`
  (`providers-local-docker/src/index.ts:131`) — so containers get the default
  bridge; DNS and installs were measured working. On Fargate, `assignPublicIp`
  **defaults to `'DISABLED'`** (`providers-fargate/src/index.ts:136-141`) and
  subnets/security groups are operator-supplied, so a private subnet with no NAT
  has no egress. *Not measured — read from the provider; there is no AWS access
  in this environment.*

Driver 1 therefore needs **documentation, not code**, and this design does not
address it beyond §7.

## 3. Shape, and why capabilities are the wrong vehicle

ADR-0015 already decided this, and names the case explicitly:

> **Wrong-shape packaging.** Capabilities that grow past tens of megabytes are
> almost always packaging the wrong thing: model weights, vendor binaries, **fat
> npm `node_modules` trees**, large datasets. Those belong somewhere else —
> fetched at runtime from object storage, installed from a package registry,
> mounted as a volume — not baked into a content-hashed capability bundle that
> every dispatch re-fetches.

The 50 MiB cap is the **total** of all files in one `register()` call
(`capabilities-register.ts:80`), enforced synchronously before upload. Sharding a
dependency tree across several capabilities to clear it would be routing around a
control that exists precisely to prevent this, and is rejected here.

ADR-0015 also names the escape hatch — a small capability shipping a setup script
that fetches the heavy payload at dispatch time — which is what §4 builds on.

**The split this design preserves:** capabilities remain the *audited, provable
input surface* (the lockfile, a few kB, is a legitimate capability). The
dependency bytes travel over a path built for bulk transfer and carry **no trust
weight** (§5).

## 4. Design

Pangolin adds exactly two things. Both are generic; Pangolin learns no package
manager and owns no mount abstraction.

### 4.1 A path, not a mount

`depCacheDir?: string` on target config, surfaced to the dispatch as
`PANGOLIN_DEP_CACHE_DIR`.

Pangolin tells the dispatch **where** the cache is and does nothing else.

This is forced rather than chosen. `LocalDockerProviderOpts` exposes
`extraHosts` but **no binds option** — binds are constructed internally for
secret staging only. And on Fargate, Pangolin **cannot create a mount at dispatch
time**: the provider already records that RunTask can override neither the image
nor `secrets:[]` entries — *"both are locked"*
(`providers-fargate/src/index.ts:149`). Volumes are task-definition-owned, the
same class of constraint. *The volume limitation specifically is an AWS platform
constraint and was NOT measured here.*

A design in which Pangolin owns mount creation would therefore be a local-only
feature wearing a provider-agnostic interface — the same trap issue 17 records
for `secrets:[]`.

**The operator provisions and mounts it out-of-band**: a Docker bind locally, an
EFS access point in the task definition on Fargate. This is not a limitation; it
is what makes §5's two residuals close for free.

A `binds?: string[]` option on `LocalDockerProviderOpts` is in scope for
local/dev parity, so a developer can exercise the path without hand-running
containers. **This is a passthrough, not an abstraction, and the distinction is
the point:** it hands raw bind strings to the one provider that accepts them, and
deliberately has *no* provider-agnostic counterpart on `TaskSpec`. If it were
lifted to `TaskSpec` it would immediately be a contract Fargate cannot honour —
exactly the shape §6 rejects. Pangolin still never creates or manages a mount.

### 4.2 An evidence sentinel

`.pangolin/deps.json`, joining the established `.pangolin/` convention
(`output.json`, `needs_input.json`, the verify sentinel):

```json
{
  "ecosystem": "pnpm",
  "lockfileHash": "sha256:…",
  "resolvedSetDigest": "sha256:…",
  "verified": true,
  "verifier": "pnpm install --verify-store-integrity",
  "packageCount": 1432
}
```

The worker reads it **twice** — after setup (step 9) and after the agent block
(step 11) — content-hashes each, and emits both on the **output sentinel**:

```ts
deps?: {
  atSetup: string;   // sha256 of the canonicalised sentinel after setup
  atFinish: string;  // sha256 after the agent block
  tier: 'recorded';
};
```

**It travels as a fourth sibling of `patchRef` / `verify` / `outputs`, not on
`DispatchExecutorManifest`.** This correction was made during DAG authoring and
matters: the executor manifest is built at **fire time**
(`executors/dispatch.ts:141`), immediately after `client.dispatch.fire()` and
sealing `firedAt` plus the pre-fire resolution — a moment at which the worker has
not run setup or the agent, so dependency evidence provably cannot exist yet.
Sealing it there would have been unimplementable.

The reconcile path already carries exactly this shape of post-run evidence:

- worker writes it into `.pangolin/output.json` (`output-sentinel.ts`);
- `readSentinel` (`executors/dispatch.ts:225`) surfaces it alongside `patchRef` /
  `verify` / `outputs`;
- `reconcile` returns it, `tick` stores it, `item.reconciled` seals it, and
  `getAuditExport` exports it — the same route `verify` took in #144.

Reusing that path is the whole reason this design stays small: no new storage,
no new audit entry kind, no new export shape.

**Two entries rather than one is load-bearing.** An agent may add a package
mid-plan; a single setup-time seal would then describe a dependency set the
dispatch did not actually run against — an audit record that is precisely wrong
in the case that matters most. When the two differ, the manifest records that the
dispatch changed its own dependency set.

Absent sentinel ⇒ absent `deps` key, following the conditional-spread posture of
its neighbours (`resultRef`, `outputRefs`, and `verify` as of #144).

### 4.3 Division of responsibility

| Party | Owns |
|---|---|
| **Pangolin** | one config field, one env var, one sentinel read + seal |
| **Operator** | provisioning, mounting, read-only flags, per-target scoping |
| **Consumer** | pointing the package manager at `$PANGOLIN_DEP_CACHE_DIR`, running the ecosystem's verify, writing the sentinel |

The result works unchanged for pip, cargo, nuget and go, because Pangolin treats
the sentinel exactly as it already treats `executorManifest`:
"executor-defined, content-hashed, OPAQUE here".

## 5. Security analysis

### 5.1 Cache poisoning is defeated, not mitigated

**Measured:** a pnpm store is pure CAS — every entry under `files/` is
hash-named, including the `<hash>-index.json` metadata. There is no mutable
top-level state.

Combined with lockfile-pinned `integrity` hashes, a dispatch only ever reads
hashes its **own lockfile names**, and content matching a hash is by definition
the correct content. An attacker writing malicious bytes into a shared store
creates an entry nobody requests. Compromising the outcome requires compromising
the victim's lockfile, which is upstream of Pangolin entirely.

This is the same argument that makes `bundle-fetcher`'s content verification
sound, applied to a different byte source.

### 5.2 Residual: a shared writable mount is a covert channel

Even with pure CAS, dispatch A writes content with hash H and dispatch B reads H.
Two dispatches at different trust levels sharing a mount can signal one another,
which cuts against grant-scoped, operator-controlled isolation.

**Closed by §4.1:** the operator keys the mount per target/trust boundary, so
dispatches from different domains never share one. Kernel-enforced, zero Pangolin
code.

### 5.3 Residual: unbounded growth is a denial of service

A hostile dispatch can fill the host disk; CAS does not help, since every
distinct blob is a new entry.

**Closed by §4.1:** the common path mounts **read-only**, populated out-of-band
by a trusted warm-up job. Cost: a mid-plan `pnpm add` falls back to the registry
— slower, still correct (§2 confirms the resulting patch stays clean), and rare.

Read-only is the operator's mount flag, not an honour-system check in our code.

### 5.4 The evidence is `recorded`, never `attested`

`.pangolin/deps.json` is written inside the workspace, in the same environment
the agent runs in. **An agent can forge it.** The worker seals whatever it reads.

This is the identical lesson the authorizer seam already carries — it "proves a
decision was sealed, NOT that `actor` was authenticated" — and the same trust
level as `VerifyOutcome`, which KNOWN-ISSUES 15 describes as "no more trustworthy
than the rest of the untrusted export rows".

The codebase already has vocabulary for this:

```ts
export type AuthzTier = 'none' | 'recorded' | 'authority-attested';
export type TimeTier  = 'asserted' | 'tsa-attested';
```

The dependency evidence ships as **`recorded`** and must never be described as
attested, in the type, the docs, or the threat model. Reaching an attested tier
would require the *worker* to run ecosystem-specific verification itself, which
§4 deliberately excludes; that is a legitimate future tier, not a gap here.

The governing rule is the threat-model page's own: **overclaiming is the one
thing an audit tool cannot afford.**

## 6. Deliberately not built

- **A package manager, registry, or artifact system.** pip/npm/nuget exist, and a
  pull-through cache is a solved problem. The consumer's original question was
  whether Pangolin needs one; it does not.
- **Capability transport for dependency trees**, including the tarball-in-a-
  capability variant and multi-capability sharding. §3.
- **Pangolin-side ecosystem verification.** §4.3; it is the durable maintenance
  surface this design exists to avoid.
- **A `bundle-fetcher` content-hash cache.** Genuinely worthwhile — bundles are
  content-addressed and therefore trivially safe to cache — but it speeds up
  capability transfer, not dependency installs, because under §3 dependencies do
  not travel as capabilities. **Separate work; should not be bundled into this.**
- **Mount creation by Pangolin.** §4.1 — impossible on Fargate.

## 7. Documentation obligations

These are part of "done", not follow-ups:

1. A recipe in `how-to/worker-file-layout` covering both halves of the toolchain
   install (NPM_CONFIG_PREFIX into `$HOME`, **and** the env-bundle PATH), because
   either alone silently yields a worker with no usable toolchain — one failing
   loudly at setup, the other as `command not found` at agent time.
2. The `depCacheDir` contract, stating plainly that the mount is untrusted, that
   read-only + per-target scoping are the operator's responsibility, and why.
3. A threat-model entry for the `recorded` tier that does not overclaim.

## 8. Open risks

- **`PANGOLIN_SETUP_TIMEOUT_SECONDS` defaults to 120** (`env-parser.ts:200-202`)
  and a non-zero exit or timeout fails the dispatch with `worker-failed`.
  Installing the pnpm binary is 2 s. A **cold `pnpm install` over a real lockfile
  was NOT measured** and is the real risk; sizing it is the first task of any
  plan, before the cache is assumed to help.
- **`pangolin-setup.sh` is single-slot**, last-write-wins on that exact filename.
  A second bound capability shipping one makes the others silently disappear.
  Consumers combining a dependency-install script with any other setup step hit
  this immediately.
- **Concurrent store access** from parallel dispatches sharing one mount. pnpm is
  designed for concurrent store use, but this was **not measured** under Pangolin's
  dispatch concurrency.
- **No measurement yet exists** that the cache is faster than a warm in-VPC
  registry. §8's first bullet is the gate on the whole design.

## 9. Acceptance criteria

1. `depCacheDir` on a target surfaces as `PANGOLIN_DEP_CACHE_DIR` inside the
   dispatch, and is absent from the environment when unset.
2. `PANGOLIN_DEP_CACHE_DIR` reaches the *setup script*, which runs before
   `captureBaseline` — asserted through a real `runWorker` lifecycle, not on a
   synthetic env object, since every existing test passes a synthetic one and a
   test written the usual way would be vacuous.
3. A dispatch with no `.pangolin/deps.json` emits **no** `deps` key on the output
   sentinel — absent, not `undefined` — and `getAuditExport` carries no `deps`
   for that item.
4. A dispatch whose sentinel is unchanged across the agent block reports
   `atSetup === atFinish`.
5. A dispatch whose agent rewrites the sentinel reports `atSetup !== atFinish`,
   and the captured patch still contains the lockfile change and **no**
   `node_modules` content.
6. A malformed, unreadable or oversized sentinel is treated **exactly as absent**
   — no `deps` key is sealed, the dispatch proceeds, and the worker emits a
   structured log line recording that evidence was present but unusable.
   Dependency evidence is informational and must never become a new way for a
   dispatch to die. (Contrast the setup script itself, which is a hard failure by
   design, and the `needs_input` sentinel, where malformed *is* `worker-failed` —
   this deliberately differs from both, because neither the run's success nor its
   correctness depends on the evidence.)
7. The sealed tier is the literal `'recorded'`, and no code path or document
   describes it as attested.
8. `pnpm -r lint` and `pnpm -r typecheck` clean; the worker and orchestrator
   suites green.
