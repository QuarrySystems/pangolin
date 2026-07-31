---
title: Worker Environment-Block Exposure (/proc) — Finding and Candidate Mechanisms
date: 2026-07-23
status: draft — finding verified. **C1 AS DESCRIBED IS REFUTED (2026-07-31); C1′ VERIFIED CLOSED.** C1-alt, C3, C2a FALSIFIED; C2b and C4 both converge on C1′. C1 half 2 PASSED (injected + refreshing credentials work; the missing seam is confirmed by experiment). Remaining before design — gate §5 items 2 and 3.
branch: security/worker-credential-custody
authors: [human:Brett, agent:claude-opus-4-8, agent:claude-opus-5]
severity: high (the env firewall's stated mitigation does not hold)
related:
  - ./2026-07-23-patch-capture-env-scoping-design.md # the sibling path, which IS ready
  - ../../../packages/pangolin-worker/src/runtime-env-filter.ts # the control this finding falsifies
---

# Worker Environment-Block Exposure (`/proc`) — Finding and Candidate Mechanisms

> **One line:** A sandboxed agent reads the worker's credentials straight out of
> `/proc/<worker-pid>/environ` — same uid, no `hidepid`, no exploit — so `runtime-env-filter.ts` does not
> achieve what it exists to do. **The finding is verified twice. No fix is designed yet, and the obvious
> one has already been falsified.** This document exists so the next attempt starts from evidence.

---

## 1. The finding (reproduced twice, independently)

`runtime-env-filter.ts:5-8` states the threat it exists to prevent:

> Handing that wholesale to the AI runtime would let a **prompt-injected sub-agent** read the callback
> HMAC key reference and — worse — **assume the worker's task role to fetch other tenants'
> bundles/secrets**.

It is a correct default-deny allow-list over the **child's** environment. But the agent and the worker
run as the same uid (`Dockerfile:71`, `:102`), `/proc/[pid]/environ` is mode 0400 owned by the process
uid, and nothing restricts it: Docker sets no `hidepid`, and `pangolin-providers-local-docker` sets only
`HostConfig.ExtraHosts` and `HostConfig.Binds` (`src/index.ts:131-133`) — no `securityOpt`, no `CapDrop`,
no `ReadonlyRootfs`, no user override.

Reproduced in `debian:bookworm-slim` and again in `node:20-slim` (the literal base per `Dockerfile:59`)
as uid 1000, with the reader started under `env -i` — an environment strictly cleaner than
`filterRuntimeEnv` produces:

```
=== what the AGENT sees (env -i) ===
HOME=/tmp
PATH=/usr/bin:/bin

=== agent reading PID 1 (the worker) via /proc ===
AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=…/v2/credentials/SECRET-TASK-ROLE
PANGOLIN_CALLBACK_TOKEN_REF=secret-ref-abc
```

`/proc/1/environ` is `-r-------- 1 node node`. **Both named targets of the docstring were recovered by a
one-line `tr`.**

---

## 2. The obvious fix does not work — falsified before it was built

An earlier draft proposed: resolve credentials at startup, hold them in the heap, then
`delete process.env.X` before spawning the agent. **That does not change `/proc/<pid>/environ`.**
Verified in `node:20-slim` with node as PID 1:

```
before proc: ["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=/v2/credentials/SECRET-TASK-ROLE"]
after env:   undefined
after proc:  ["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=/v2/credentials/SECRET-TASK-ROLE"]
```

`/proc/<pid>/environ` exposes the kernel's `[mm->env_start, mm->env_end)` stack region, **fixed at
`execve`**. `delete process.env.X` reaches glibc `unsetenv` through libuv, which unlinks the pointer from
the `environ` array; the original bytes remain on the stack and remain readable.

**The lesson this document is built around:** that design was reasoned carefully — about `ptrace_scope`,
about heap-versus-environment — and was wrong about the one fact everything rested on, which a
thirty-second container run would have settled. §5 therefore requires a falsification test *before* any
mechanism is written up as a design.

---

## 3. Constraints any mechanism must satisfy

Established while auditing the falsified draft. These are what make this hard.

1. **The env block is immutable after `execve`.** Only a new `execve` — or never putting the values there
   — changes it.
2. **There is no credentials seam on the storage provider.** `S3StorageProvider` builds its client in its
   own constructor (`packages/pangolin-storage-s3/src/index.ts`), reached from `bundle-fetcher.ts:79-83`.
   `S3StorageProviderOpts` has **no `credentials` field**; the only injection point is `client?: S3Client`,
   and supplying it makes `endpoint`/`forcePathStyle`/`region` ignored.
   `providers-local-docker/src/index.ts:79-81` says it outright: env at boot is *"the only point the
   worker can configure its own S3 client"*.
3. **The worker declares no credential-provider dependency.** `packages/pangolin-worker/package.json`
   declares only `@aws-sdk/client-secrets-manager`. `pnpm check:deps` scans built `dist` and fails on
   undeclared bare specifiers, so adding one is a real packaging change.
4. **Two credential shapes, not one.** Fargate supplies `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` — a
   *pointer* to a refreshing endpoint. local-docker supplies static `AWS_*` keys via `extraEnv`
   (`providers-local-docker/src/index.ts:75-83`). These need different provider constructions with
   different refresh semantics. On Fargate the task definition's `secrets:[]` entries also arrive
   ambiently, so the exposed set is **not** just `AWS_*`/`PANGOLIN_*` and must be enumerated, not guessed.
5. **There is no window between "agent done" and "upload".** The agent runs *inside* the same
   `runPipeline` call that later performs the writes — `pipeline-runner.ts:282` (`capturePatch`), `:316`
   (`captureOutputs`), `:455` (`writeSentinel`). Any design premised on an entrypoint-level window is
   wrong.
6. **A naive scrub degrades badly, not loudly.** `remoteProvider(init)` re-reads
   `process.env[ENV_CMDS_RELATIVE_URI]` on every chain invocation, and the chain re-runs when
   `expiration - Date.now() < 300000`. Post-scrub it does not fail fast — it walks fromEnv → SSO → Ini →
   Process → TokenFile → `fromInstanceMetadata`, i.e. an **IMDS timeout with retries**, on the
   post-agent upload path.
7. **`runWorker(env = process.env, …)`** (`entrypoint.ts:124`) threads `env` throughout (`:134`, `:407`),
   and every existing test passes a synthetic object, never `process.env`. Any mechanism must say
   explicitly which of the two it acts on, or its test will be vacuous.

---

## 4. Candidate mechanisms

None is chosen. Each carries the test that must pass before it may become a design.

### C1 — re-exec the worker with a clean `envp`

A thin launcher becomes the container entrypoint, reads the ambient credentials, `exec`s the real worker
with a minimal environment, and passes the credentials over an inherited fd. The worker's env block is
created fresh at that `execve` and never contains them.

- **Closes:** Path 1 fully — this is the only candidate that removes the exposure rather than restricting
  who can see it.
- **Cost:** a new entrypoint, fd plumbing, and constraint 2 — the credentials still have to reach the S3
  client, which today has no seam for them.
- **Falsification test:** exec a node process with a minimal `envp`, confirm `/proc/self/environ` contains
  no credential bytes, **and** confirm an `S3Client` constructed from fd-delivered credentials both works
  and refreshes. Both halves, or the mechanism is unproven.

**Half 1 — RUN 2026-07-23, PASSED.** In `node:20-slim` with the credentials present in the parent's
environment, a child spawned with `env: { PATH }` has a genuinely clean block:

```
parent leaks: [ 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=…', 'PANGOLIN_CALLBACK_TOKEN_REF=…' ]
  child env block: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"]
  child leaks: []
```

The premise holds: the block is built fresh at `execve` from the passed `envp`, so credentials never
enter it. **Half 2 remains unrun**, and it is the harder half — it is constraint 2, a missing seam rather
than an unknown behaviour, and no container test settles it.

> **REFUTED 2026-07-31 — and the refutation was already printed above.**
>
> Read half 1's own output again: `parent leaks: [ 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=…' ]`. That
> line sits next to `child leaks: []` and reads as an incidental control. **It is the answer.** C1 says
> the launcher "passes the credentials over an inherited fd" — an inherited fd requires a *live parent*,
> and Node cannot `execve`-replace its own process image. So the launcher survives as PID 1 with the
> credentials still in its env block, and the agent runs at the same uid.
>
> Run in `node:22-bookworm-slim` as uid 1000, with an "agent" that walks every readable
> `/proc/<pid>/environ`:
>
> ```
> LAUNCHER: credentials are in my environment (as the container delivers them)
>   launcher pid 1, own env has secret? "/v2/credentials/TOPSECRET-TASK-ROLE"
>
>   WORKER own env has secret? null
>   AGENT  own env has secret? null
>   AGENT found secret in 1 process(es):
>     - pid 1 (node c1-launcher-leak.mjs)
>   => STILL OPEN: the credential is readable from the listed process(es)
> ```
>
> The worker is clean and the agent is clean — and the credential is taken from the launcher anyway.
> **Building C1 as written would have shipped a new entrypoint, fd plumbing and a storage-API change, and
> closed nothing.** This is §2 happening a second time: a carefully reasoned design resting on one fact
> nobody ran.

### C1′ — shell entrypoint that `exec`s, credential handed over a file — **VERIFIED CLOSED 2026-07-31**

The fix for C1's defect is to leave *no surviving process* holding the credentials. A POSIX shell can do
what Node cannot: `exec` calls `execve()` and the kernel rebuilds the env region from the new `envp`, so
the entrypoint does not survive to be read.

The hand-off is a private file rather than an inherited pipe — **deliberately**, because a pipe needs a
live writer, which is exactly the process being removed. The worker reads it and `unlink`s it at startup,
before the agent exists.

```sh
# entrypoint.sh (container ENTRYPOINT)
umask 077; printf '%s' "$AWS_CONTAINER_CREDENTIALS_RELATIVE_URI" > "$CREDS_DIR/creds"
exec env -i PATH="$PATH" CREDS_FILE="$CREDS_DIR/creds" node worker.js
```

Same container, same uid, same agent sweep of all of `/proc`:

```
ENTRYPOINT (pid 1): credentials ambient; wrote them to /tmp/pangolin-creds/creds
ENTRYPOINT: exec'ing the worker with env -i — this REPLACES this process

  WORKER (pid 1): got credential over the file channel (len 35), unlinked it
  WORKER: own env block has secret? null

  AGENT: secret found in 0 process env block(s)
  AGENT: hand-off file still present? false
  => CLOSED: no process env block and no file leaks the credential
```

Note the worker is **pid 1** — `exec` replaced the image rather than forking, so there is no second
process. Both lanes are shut: no env block carries the credential, and the file is gone before the agent
runs.

**Open question this raises for the design:** the file exists on disk between the entrypoint write and
the worker's `unlink`. Nothing in the container should be running as the agent during that window, but
that is currently an argument rather than an enforced property, and the design should say which.

### C1 half 2 — the credentials seam — **RUN 2026-07-31. Behaviour PASSES; the missing seam is CONFIRMED.**

The half the frontmatter called "a package-API decision, not an experiment". The API half is indeed a
decision, but the *behavioural* half was testable and is now measured, against MinIO:

| probe | result |
|---|---|
| `S3Client({ credentials: <static> })`, nothing in `process.env` | request **signed**, `NoSuchKey` |
| `S3Client({ credentials: <async provider> })` | request **signed** |
| provider re-invoked after `expiration` elapses | **yes — 3 → 5 invocations** |
| `S3StorageProvider({ credentials })` | **`InvalidAccessKeyId` — silently ignored** |

The refresh result is the one that mattered: Fargate hands a *pointer* to a refreshing endpoint
(constraint 4), so a one-shot hand-off that could not refresh would break a long dispatch. It refreshes.

The last row confirms constraint 2 **by experiment** rather than by reading: `S3StorageProviderOpts` has
no `credentials` field, so the value is accepted by TypeScript's structural typing at the call site and
then dropped on the floor. Today the only injection point is `client?: S3Client`, which makes
`endpoint`/`forcePathStyle`/`region` inert — an all-or-nothing seam. **The package-API decision is
therefore: add `credentials` to `S3StorageProviderOpts` so it composes with the existing options.**

### C1-alt — overwrite the env block in place via `process.title` — **FALSIFIED 2026-07-23**

Node writes `process.title` into the argv/env memory region on Linux, so a large title assignment might
plausibly have clobbered the block in place — no launcher, no fd plumbing, a two-line fix. **It does
not.** With an 8 KiB title write in the same container:

```
before: [ 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=…', 'PANGOLIN_CALLBACK_TOKEN_REF=…' ]
after:  [ 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=…', 'PANGOLIN_CALLBACK_TOKEN_REF=…' ]
```

Recorded so the idea is not re-proposed. It is the same shape as the falsified `delete process.env`
mechanism in §2: an in-process mutation cannot reach a region the kernel snapshotted at `execve`.

### C2 — run the agent as a different uid — **SPLIT 2026-07-23: C2a falsified, C2b is an architecture change**

`/proc/<pid>/environ` is `-r--------` owned by the process uid, so a different uid cannot read it. The
question is whether Pangolin can arrange one.

**C2a — same container, worker spawns the agent as another uid: FALSIFIED.** A non-root worker cannot do
it. In `node:20-slim` as uid 1000:

```
running as uid 1000
spawn{uid:1001} FAILED: EPERM
```

Making it work means granting `CAP_SETUID` or root **to the process that holds the credentials** — the
opposite of the goal. Closed.

**C2b — the agent in a separate container: supported by the platform, blocked by our execution model.**

Supported: ECS `containerDefinitions` is an array, `ContainerDefinition` carries `user`, `essential`, and
`dependsOn`, and `pidMode` exists at the task level. Containers do **not** share a PID namespace by
default — evidenced throughout this document's experiments, where each container's own entrypoint is
PID 1 — so an agent container simply cannot see the worker's `/proc`. That closes Path 1 completely, and
more thoroughly than a uid split.

The blockers are ours, not the platform's:

- **The worker spawns the agent as a subprocess** (`claude-spawn.ts`, `spawn` with `cwd: workspaceDir`).
  Across containers that is impossible. It needs a shared volume for the workspace, a mechanism to start
  the agent container and collect its exit code, and a changed runtime-adapter contract.
- **Neither provider builds a two-container unit today.** `pangolin-providers-local-docker` calls
  `createContainer` once per run (`src/index.ts:134`). `pangolin-providers-fargate` does not construct
  task definitions at all — it issues `RunTaskCommand` against an existing `taskDefinitionFamily` with
  `overrides` (`src/index.ts:101-112`), so the container topology is **operator deployment
  configuration**, outside Pangolin's code.

That second point cuts both ways: on Fargate a two-container task definition could in principle be
configured today with no provider change — but only once the coordination problem above is solved, and
that is the whole of the work.

**Therefore C2b is not a separate candidate.** It is the same architecture change §4 of the sibling spec
already names as the durable fix for this class — running capture and the agent in different containers.
Track it there rather than as a mechanism to pick between; it competes with C1 on cost, not on kind.

### C3 — `hidepid=2` on `/proc` — **FALSIFIED 2026-07-23, on three independent grounds**

The apparent cheap platform-layer answer. It is not an answer at all.

**1. ECS cannot express it.** `LinuxParameters` in `@aws-sdk/client-ecs` has exactly seven members —
`capabilities`, `devices`, `initProcessEnabled`, `sharedMemorySize`, `tmpfs`, `maxSwap`, `swappiness`.
The models file contains **zero** occurrences of `hidepid` or `procMount`. Not a Fargate restriction —
the ECS API has no such field on any launch type.

**2. Docker refuses the remount without `CAP_SYS_ADMIN`**, which is dropped by default:
`mount: /proc: permission denied`. Granting it to the container that holds the credentials, in order to
protect those credentials, is a trade nobody should take — `CAP_SYS_ADMIN` is close to root.

**3. And with `hidepid` genuinely active it changes nothing here.** With `--cap-add SYS_ADMIN` the
remount succeeds — `/proc/mounts` shows `hidepid=invisible` — and the agent reads the secret anyway:

```
REMOUNT OK
proc /proc proc rw,nosuid,nodev,noexec,relatime,hidepid=invisible
-- worker pid 11, environ ownership: -r-------- 1 node node
-- agent (uid 1000, clean env) reading it:
SECRET_WORKER=TOPSECRET-TASK-ROLE
```

**`hidepid` is a *user* boundary, and there is no user boundary between the worker and the agent.** It
hides other users' processes; these are the same user.

This also makes C3 **redundant with C2** rather than an alternative to it. The `-r--------` mode owned by
the process uid is already the entire boundary — if the uids differ, ownership alone blocks the read and
`hidepid` adds nothing; if they match, `hidepid` cannot help. Any future proposal to "just set `hidepid`"
should be closed by pointing here.

> **Testing note — a trap that produces a false PASS.** A first attempt at this test had the worker
> `setuid()` from root to 1000, and *appeared* to show the read blocked (`EACCES`) even without
> `hidepid`. That is the kernel's `dumpable` flag: changing credentials clears it and reassigns
> `/proc/<pid>/*` to root. The real worker **starts** as uid 1000 (`USER pangolin`) and never setuids, so
> `dumpable` is 1 and the files are owned by uid 1000. Anyone re-running this must drop privileges via
> `exec` (`setpriv … env … <cmd>`), which resets `dumpable`, or they will conclude the exposure does not
> exist.

### C4 — the worker never holds ambient credentials

The orchestrator resolves everything the worker needs — pre-signed URLs for bundle reads and artifact
writes, secrets pre-staged — so there is no task role in the container to steal.

- **Closes:** the whole class, including anything reachable through the filesystem or a future third path.
- **Cost:** the largest change, and it moves work to the orchestrator.
- **Falsification test:** confirm every credentialed operation the worker performs can be expressed as a
  pre-signed or pre-staged artifact — the sentinel write and artifact uploads are the ones to check first.

**RUN 2026-07-23 — PARTIALLY FALSIFIED. C4 cannot stand alone.** The worker's credentialed operations
enumerate completely, and they do not all pre-sign:

| Operation | Key knowable at dispatch time? |
|---|---|
| `storage.get` ×4 — capability, subagent, env, pipeline bundles (`bundle-fetcher.ts:112, :140, :162, :190`) | **Yes** — pinned refs already carried on `DispatchWork` |
| `storage.put` — the sentinel (`output-sentinel.ts:237`) | **Yes** — fixed path `dispatches/<id>/output.json` |
| `storage.put` — patch (`:112`) and outputs (`:188`) | **No** |
| `secretStore.resolve` ×3 — callback HMAC key, env-bundle and per-dispatch secrets (`entrypoint.ts:262, :355, :386`) | **No** |

**Artifact writes are content-addressed.** The key is `artifact/<dispatchId>/<sha256>` where the hash is
of bytes the agent has not produced yet (`output-sentinel.ts:110-111`, `:186-187`), so a presigned PUT is
impossible *in principle*, not merely unimplemented. A presigned **POST** with a `starts-with` key-prefix
condition could express it, but that is a different HTTP shape from the `PutObjectCommand` the provider
uses (`pangolin-storage-s3` issues only `GetObjectCommand` ×3 and `PutObjectCommand` ×3), so
`S3StorageProvider.put` would need a second code path. Neither `@aws-sdk/s3-request-presigner` nor
`@aws-sdk/s3-presigned-post` is installed.

**Secrets cannot be presigned at all** — the AWS JS SDK ships a presigner for S3 only. The alternative is
pre-staging the *values*, which returns the callback HMAC key to somewhere the agent can read: the
exposure this document exists to close.

**Verdict:** the read side and the sentinel write are genuinely pre-signable; the artifact writes need
presigned POST; and the secret lane needs a delivery channel that is not the environment — i.e. **C1's
fd**. Like C2b, C4 converges with C1 rather than competing with it. There is no candidate that closes
Path 1 without either a new process boundary (C1/C2b) or a credential channel outside the environment.

---

## 5. Gate before this becomes a plan

1. ~~Pick a candidate and **run its falsification test first**, in a container, and record the output in
   this document.~~ **DONE 2026-07-31.** C1 refuted, C1′ verified closed, half 2 measured — all output
   recorded in §4. The candidate is **C1′**.
2. **TODO — enumerate the actual exposed set on both providers** (constraint 4) rather than assuming
   `AWS_*`/`PANGOLIN_*`. On Fargate the task definition's `secrets:[]` entries arrive ambiently too, so
   the entrypoint must know precisely what to carry across and what to drop. This is the next task.
3. **TODO — state which of `process.env` or the threaded `env` parameter the mechanism acts on**
   (constraint 7). Note C1′ makes this sharper, not moot: the shell entrypoint acts on the *real* process
   environment before `execve`, whereas every existing test passes a synthetic `env` object to
   `runWorker`, so a test written the usual way would be vacuous. Say so explicitly in the design.
4. Only then write the design section and hand it to a plan.

**Scope note for whoever picks this up.** C1′ closes the exposure; it does not by itself deliver
credentials to the two consumers that need them. Sequenced smallest-first:

- **(a)** `credentials` on `S3StorageProviderOpts` — contained, independently useful, unblocks everything
  else. No security change on its own.
- **(b)** the shell entrypoint + file hand-off + `unlink`, per C1′.
- **(c)** the secret lane. Per C4's verdict, secrets cannot be presigned at all (the AWS JS SDK presigns
  S3 only), so they must ride the same fd/file channel.
- **(d)** provider changes: `pangolin-providers-local-docker` supplies static `AWS_*` via `extraEnv`;
  Fargate supplies the refreshing pointer. Different shapes, different refresh semantics (constraint 4).

Also unresolved: constraint 3 — the worker declares no credential-provider dependency, and
`pnpm check:deps` fails on undeclared bare specifiers, so adding one is a real packaging change.

---

## 6. Documentation this finding falsifies

`docs-site/src/content/docs/explanation/threat-model.md` publishes the claim this finding disproves. The
*Identity theft* row gives the mitigation as *"the worker→runtime env firewall is default-DENY … every
`PANGOLIN_*` var and the whole AWS credential chain are dropped"*, with an Honest-limit column mentioning
only the `PANGOLIN_RUNTIME_ENV_ALLOW` footgun. The agent need not run `env`/`printenv`; it reads
`/proc/1/environ`. The claim recurs in the diagram (`:48`) and at `:97`.

**That correction does not wait for this document.** It is a statement of current fact and ships with the
sibling spec (`2026-07-23-patch-capture-env-scoping-design.md` §6), which is ready now.
