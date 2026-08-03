---
title: Worker Environment-Block Exposure (/proc) — Finding and Candidate Mechanisms
date: 2026-07-23
status: **DESIGNED 2026-07-31 — see §7 (C1′-restore). Ready for a plan.** Finding verified. C1 as described REFUTED; C1′ verified closed and tightened (fd unlinked before `exec`). C1-alt, C3, C2a FALSIFIED; C2b and C4 converge. Gate §5 fully cleared: items 2 and 3 answered in §3a, item 4 is §7. The chosen mechanism dissolves constraints 2, 3, 4 and 6 rather than satisfying them, so §5's scope-note steps (a)/(c)/(d) are WITHDRAWN.
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
   worker can configure its own S3 client"*. **Still true, but no longer binding (§7.1):** the chosen
   mechanism gives the client its credentials through the environment it already reads, so it needs no
   seam.
3. **The worker declares no credential-provider dependency.** `packages/pangolin-worker/package.json`
   declares only `@aws-sdk/client-secrets-manager`. `pnpm check:deps` scans built `dist` and fails on
   undeclared bare specifiers, so adding one is a real packaging change.
4. **Two credential shapes, not one.** Fargate supplies `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` — a
   *pointer* to a refreshing endpoint. local-docker supplies static `AWS_*` keys via `extraEnv`
   (`providers-local-docker/src/index.ts:75-83`). These need different provider constructions with
   different refresh semantics. On Fargate the task definition's `secrets:[]` entries also arrive
   ambiently, so the exposed set is **not** just `AWS_*`/`PANGOLIN_*` and must be enumerated, not guessed.
   **Enumerated 2026-07-31 — §3a**, with the result that on Fargate it *cannot* be enumerated by us, so
   the mechanism must enumerate what it carries rather than what it drops.
5. **There is no window between "agent done" and "upload".** The agent runs *inside* the same
   `runPipeline` call that later performs the writes — `pipeline-runner.ts:282` (`capturePatch`), `:316`
   (`captureOutputs`), `:455` (`writeSentinel`). Any design premised on an entrypoint-level window is
   wrong.
6. **A naive scrub degrades badly, not loudly.** `remoteProvider(init)` re-reads
   `process.env[ENV_CMDS_RELATIVE_URI]` on every chain invocation, and the chain re-runs when
   `expiration - Date.now() < 300000`. Post-scrub it does not fail fast — it walks fromEnv → SSO → Ini →
   Process → TokenFile → `fromInstanceMetadata`, i.e. an **IMDS timeout with retries**, on the
   post-agent upload path. **Dissolved by §7.1** — nothing is scrubbed from `process.env`, so the chain
   never degrades. That same late re-read is what makes the restore work; §7.5 keeps the failure loud.
7. **`runWorker(env = process.env, …)`** (`entrypoint.ts:124`) threads `env` throughout (`:134`, `:407`),
   and every existing test passes a synthetic object, never `process.env`. Any mechanism must say
   explicitly which of the two it acts on, or its test will be vacuous. **Answered 2026-07-31 — §3a:**
   the real process environment, and it is forced rather than chosen — `bundle-fetcher.ts:78-81` and
   `patch-capture.ts:61` already bypass the threaded `env`, and the AWS SDK cannot be reached through it.

---

## 3a. Gate items 2 and 3 — measured answers (2026-07-31)

Scripts: [`./experiments/2026-07-31-proc-gate2-exposed-set/`](./experiments/2026-07-31-proc-gate2-exposed-set/).
Run in the **real worker image** (`ghcr.io/quarrysystems/pangolin-worker:main`), not read off the source,
because the image and the Docker daemon contribute vars that no reading of `dispatch.ts` surfaces.

### Gate item 2 — the exposed set

**Local-docker, measured.** 27 names in a 996-byte block, recovered by a child started with `env -i` —
the agent's real position: same uid, own environment already empty.

| Class | Names |
|---|---|
| **Credential or credential pointer** | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `PANGOLIN_CALLBACK_TOKEN_REF`, `PANGOLIN_CALLBACK_BEARER_REF`, `PANGOLIN_PER_DISPATCH_SECRET_REFS_JSON` |
| **Worker control plane** | `PANGOLIN_DISPATCH_ID`, `PANGOLIN_NAMESPACE`, `PANGOLIN_STORAGE_URI`, `PANGOLIN_BUNDLE_REFS_JSON`, `PANGOLIN_INPUT_JSON`, `PANGOLIN_CALLBACK_URL`, `PANGOLIN_SECRET_STORE_KIND`, `PANGOLIN_SECRET_STORE_DIR`, `PANGOLIN_RUNTIME_ADAPTER`, `PANGOLIN_MODEL`, `PANGOLIN_S3_ENDPOINT`, the three `*_TIMEOUT_SECONDS` |
| **Image / daemon / system** | `PATH`, `HOME`, `HOSTNAME`, `NODE_ENV`, `NODE_VERSION`, `YARN_VERSION`, `AWS_REGION` |

`HOSTNAME`, `NODE_VERSION` and `YARN_VERSION` are the point of running this in a container: none appear
anywhere in Pangolin's source. Also readable when the deploy sets them: `PANGOLIN_RUNTIME_ENV_ALLOW`,
`PANGOLIN_DISABLE_NEEDS_INPUT_HELPER`, `PANGOLIN_CLAUDE_PERMISSION_MODE`.

**Fargate — the set is not enumerable by Pangolin at all.** Three contributors, and we own only one:

1. `containerOverrides.environment` — the same `PANGOLIN_*` set (`providers-fargate/src/index.ts:156`).
2. The task definition's `environment:[]` and `secrets:[]` — **operator-authored, never seen by our
   code.** ECS resolves `secrets:[]` into the container environment as **plaintext values**, and the
   deploy guide instructs operators to put the Claude credential there
   (`docs-site/.../deploy-fargate-s3.mdx`, step 4.3) because `RunTask` cannot inject secrets and
   `assertSecretRefsHandledByTaskDefinition` (`:263-271`) *throws* on any dispatch carrying `secretRefs`.
   So on Fargate the exposed block holds a secret **value**, where local-docker exposes only a ref and
   stages the value as a bind-mounted file. **Fargate is the strictly worse path**, and the finding's
   §1 reproduction understates it.
3. ECS-injected vars, whose names are AWS's to change, not ours.

**This kills the drop-list framing, and that is the actionable result of gate item 2.** A mechanism that
enumerates what to *remove* cannot be correct, because sources 2 and 3 are open sets outside our
control — a new `secrets:[]` entry, or a new AWS-injected var, silently widens the exposure and no test
of ours fails. The enumeration a mechanism can rest on is the **carry-list**, which is closed and
derivable from our own source. C1′ already has the right polarity (`env -i` plus explicit carries); the
design must state that this is load-bearing rather than incidental.

**The closed carry-list** — every variable the worker itself reads:

- **Via the threaded `env`** (`parseWorkerEnv`): the 18 `PANGOLIN_*` names in `env-parser.ts:84-242`.
- **Via `process.env` directly**: `PANGOLIN_S3_ENDPOINT` and `AWS_REGION` (`bundle-fetcher.ts:78-81`),
  `PATH` (`patch-capture.ts:61`). See gate item 3 — these are not reachable through the threaded object.
- **Via the AWS SDK's own chain**, which reads `process.env` internally and is reachable through no seam
  at all. Measured against the installed SDK rather than recalled:
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_ACCOUNT_ID`,
  `AWS_CREDENTIAL_EXPIRATION`, `AWS_CREDENTIAL_SCOPE` (`credential-provider-env`);
  `AWS_PROFILE`, `AWS_EC2_METADATA_DISABLED` (`credential-provider-node`);
  `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, `AWS_CONTAINER_CREDENTIALS_FULL_URI`,
  `AWS_CONTAINER_AUTHORIZATION_TOKEN`, `AWS_EC2_METADATA_SERVICE_ENDPOINT[_MODE]`,
  `AWS_EC2_METADATA_TOKEN`, `AWS_EC2_METADATA_V1_DISABLED` (`@smithy/credential-provider-imds`).
  Six of those are not `AWS_ACCESS_*`-shaped and would be missed by anyone writing the list from memory,
  which is the argument for default-deny in one line.

**A second seam of the same shape, currently unnamed in §5.** Build order (a) adds `credentials` to
`S3StorageProviderOpts`, but the worker builds `new SecretsManagerClient({})` itself
(`entrypoint.ts:251`) and hands it to `storeFromConfig`. Once the entrypoint stops carrying the AWS
chain, that client loses its credentials exactly as the S3 client does. The difference is cost: it is
the worker's own code, so `new SecretsManagerClient({ credentials })` is a one-line change with **no
package-API decision** — unlike (a). §5's step (c) is about secret *values* riding the file channel; it
does not currently cover the SecretsManager *client's own* credentials. The design must say both.

### Gate item 3 — `process.env` or the threaded `env`?

**Both, and the split is itself a finding.** Constraint 7 frames this as a choice the mechanism must
declare. It is not a free choice:

- `runWorker(env = process.env, …)` threads `env`, and `parseWorkerEnv` reads only from it.
- **But `constructStorageProvider` ignores it.** `bundle-fetcher.ts:78-81` reads
  `process.env.PANGOLIN_S3_ENDPOINT` and `process.env.AWS_REGION` directly, and it is reached from
  `entrypoint.ts:307` on the ordinary dispatch path. `patch-capture.ts:61` reads `process.env.PATH` the
  same way.
- The AWS SDK reads `process.env` internally and cannot be reached through the threaded object at all.

So **C1′ acts on the real process environment, before `execve`** — the only thing that changes
`/proc/<pid>/environ`, and the only thing the SDK and those two direct readers observe. The threaded
`env` parameter is irrelevant to this exposure, and a test that manipulates it proves nothing about it.

**Confirmed, not assumed:** every `runWorker(...)` call site under `packages/pangolin-worker/test/` and
`test/e2e/` passes a synthetic object (`h.env` / `env`). Exactly one production call site passes the
real thing — `docker/pangolin-worker/bin/pangolin-worker-entry.mjs:19`. A mechanism-level test written
in the house style would therefore be **vacuous**, and would look exactly like the tests that pass today.

### A third trap that produces a false PASS — this one in the instrument

§3's `dumpable` trap and C1's surviving-launcher trap were both in the *setup*. This one is in the
*measurement*, and it bites the tripwire §5 asks for specifically, because that tripwire asserts a probe
finds **nothing**:

```
1. 0    <- $(wc -c < /proc/self/environ)   : FALSE EMPTY
2. 245  <- $(cat /proc/self/environ | wc -c)
3. 230  <- $(cat /proc/1/environ | wc -c)
5. 230  <- the same command as row 1, outside the substitution

positive control — the credential IS present the whole time:
SECRET=TOPSECRET-VALUE
```

Rows 1 and 5 are the same command; only the command substitution differs. **Any test asserting "the
probe found no credential" must carry a positive control** — a credential known to be present, in the
same run, which the probe must recover — or it passes on an instrument that can see nothing at all.
Only the behaviour above is established; the kernel path producing it is not, and must not be written up
as understood.

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
`endpoint`/`forcePathStyle`/`region` inert — an all-or-nothing seam. ~~**The package-API decision is
therefore: add `credentials` to `S3StorageProviderOpts` so it composes with the existing options.**~~

> **SUPERSEDED 2026-07-31 by §7.1.** That conclusion followed from the premise that credentials must be
> handed to the client *explicitly*, because the environment would be scrubbed. Measured: a credential
> restored into `process.env` after `execve` is invisible to `/proc` **and** is picked up by the SDK's
> own chain — on both credential shapes, even when the client was constructed first. So no credentials
> seam is required on any client. The missing `credentials` field is still a real API gap, but it is a
> product improvement carrying no security claim; §7.8 keeps it out of this work.

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
2. ~~Enumerate the actual exposed set on both providers (constraint 4).~~ **DONE 2026-07-31 — §3a.**
   Measured in the real image: 27 names on local-docker. On Fargate the set is **not enumerable by
   Pangolin at all**, and the `secrets:[]` lane puts a plaintext secret *value* in the block, so Fargate
   is the worse path. The result is not a list but a polarity: **the drop-list is open and the carry-list
   is closed**, so the entrypoint must be default-deny by construction.
3. ~~State which of `process.env` or the threaded `env` parameter the mechanism acts on
   (constraint 7).~~ **DONE 2026-07-31 — §3a.** It acts on the **real process environment before
   `execve`**, and this is forced, not chosen: `bundle-fetcher.ts:78-81` and `patch-capture.ts:61`
   already bypass the threaded `env`, and the AWS SDK cannot be reached through it. Every existing test
   passes a synthetic object, so a mechanism-level test in the house style would be vacuous.
4. ~~Only then write the design section and hand it to a plan.~~ **DONE 2026-07-31 — see §7**, whose
   premises were each run in the real image before it was written. Next is the plan.

**Scope note for whoever picks this up.** — **SUPERSEDED 2026-07-31 by §7.8.** Steps (a), (c) and (d)
below are **withdrawn**: they exist because this note assumed credentials must be injected explicitly
through new API seams, and §7.1 measured that they need not be. Restoring into `process.env` after
`execve` is invisible to `/proc` and is read by the SDK's own chain, which dissolves constraints 2, 3, 4
and 6. Kept for the reasoning trail, not as a plan.

C1′ closes the exposure; it does not by itself deliver credentials to the two consumers that need them.
Sequenced smallest-first:

- **(a)** `credentials` on `S3StorageProviderOpts` — contained, independently useful, unblocks everything
  else. No security change on its own.
- **(b)** the shell entrypoint + file hand-off + `unlink`, per C1′.
- **(c)** the secret lane. Per C4's verdict, secrets cannot be presigned at all (the AWS JS SDK presigns
  S3 only), so they must ride the same fd/file channel. **Two distinct things live under this bullet**
  (§3a): the secret *values*, and the credentials the `SecretsManagerClient` itself needs. The second is
  cheaper than (a) — the worker constructs that client at `entrypoint.ts:251`, so injecting credentials
  is a one-line change with no package-API decision.
- **(d)** provider changes: `pangolin-providers-local-docker` supplies static `AWS_*` via `extraEnv`;
  Fargate supplies the refreshing pointer. Different shapes, different refresh semantics (constraint 4).

### A tripwire, and where NOT to put it

**Nothing in the test suite currently asserts anything about this exposure.** It is described in the
threat model and in `0.5.0`'s release notes, and that is all. A finding that lives only in prose can
quietly persist across releases — and, worse, can be *partially* fixed without anyone noticing the rest
is still open.

So the design should land an executable acceptance criterion **written before the mechanism**, expressing
the property C1′ is verified to deliver:

> Given a container holding a credential in the entrypoint's environment, no process in the PID namespace
> exposes that credential via `/proc/<pid>/environ`, and no hand-off artifact survives into the agent's
> lifetime.

Write it now as a **skipped/expected-fail** test (vitest `it.skip`, or `it.fails` so a surprise pass is
itself loud), pointing at this document. Un-skipping it becomes the definition of done, rather than a
judgement call made at the end by whoever is tired.

**And give it a positive control.** The assertion is that a probe finds *nothing*, which is the one shape
that passes when the probe is broken — §3a records a `/proc` read returning 0 bytes with the credential
plainly present. The test must recover a known-present credential in the same run that asserts the
protected one is absent, or it certifies only that the instrument is blind.

**The caveat is where it goes, and it is not a detail.** The natural home — the Docker E2E lane — is
gated behind `PANGOLIN_E2E_DOCKER=1` and **passes-as-skipped** without it
(`test/e2e/helpers/docker-skip.ts`). CI sets neither the flag nor pulls the image. That is precisely how
the pinned worker digest in `test/e2e/helpers/worker-image.ts` stayed *dangling* — not merely stale, the
digest no longer resolved — across four releases while `pnpm test:e2e` reported a clean 77 passed
(fixed 2026-07-31, see that file's header). **A security tripwire parked in a lane that passes-as-skipped
is theatre.**

Split it, then:

- the **container-level proof** stays as the scripts in `./experiments/2026-07-31-proc-c1/` and
  `./experiments/2026-07-31-proc-gate2-exposed-set/`, run deliberately, and wired to a dedicated CI job
  if it is to be trusted between releases — not to a suite that skips silently;
- the **mechanism-level assertions** belong in the default suite, where they cannot be skipped: that the
  entrypoint `exec`s rather than spawns, and that the process `runWorker` runs in carries no credential
  variable. Those are cheap, run everywhere, and would catch a regression that reintroduces a surviving
  launcher — which is exactly the shape C1 got wrong.

~~Also unresolved: constraint 3~~ — **resolved 2026-07-31 by §7.1.** The worker declares no
credential-provider dependency and `pnpm check:deps` fails on undeclared bare specifiers, so adding one
would have been a real packaging change. The chosen mechanism adds none: it restores the credential to
the environment the SDK already reads, so no provider is ever constructed by our code.

---

## 6. Documentation this finding falsifies

`docs-site/src/content/docs/explanation/threat-model.md` publishes the claim this finding disproves. The
*Identity theft* row gives the mitigation as *"the worker→runtime env firewall is default-DENY … every
`PANGOLIN_*` var and the whole AWS credential chain are dropped"*, with an Honest-limit column mentioning
only the `PANGOLIN_RUNTIME_ENV_ALLOW` footgun. The agent need not run `env`/`printenv`; it reads
`/proc/1/environ`. The claim recurs in the diagram (`:48`) and at `:97`.

**That correction does not wait for this document.** It is a statement of current fact and ships with the
sibling spec (`2026-07-23-patch-capture-env-scoping-design.md` §6), which is ready now.

Once §7 ships, the *Identity theft* honest limit and the *Over-broad environment* limit both need a
second edit — this time to say the exposure is closed and by what. Neither may be written before the
mechanism lands: "overclaiming is the one thing an audit tool can't afford" is that page's own rule.

---

## 7. The design — C1′-restore

**Chosen 2026-07-31.** Every premise below was run in the real worker image before this section was
written; evidence is in [`./experiments/2026-07-31-proc-c1-prime-restore/`](./experiments/2026-07-31-proc-c1-prime-restore/).
That ordering is the whole point of §2 and §5.

> **One line:** the entrypoint `exec`s the worker with a clean environment, hands the captured
> environment over an inherited fd whose file is already unlinked, and the worker restores it into its
> own `process.env` — which is not the region `/proc` exposes.

### 7.1 Why this closes the finding

The exposure is the kernel's `[env_start, env_end)` snapshot, fixed at `execve` (§2). Two facts, both
measured, make the mechanism work:

1. **`exec` from a POSIX shell replaces the process image**, so nothing survives holding the credential.
   This is exactly what C1 got wrong: Node cannot `execve`-replace itself, so its launcher stayed alive
   as pid 1 with the credential in its own block.
2. **`process.env` mutation is invisible to `/proc`.** `setenv` reaches a heap-allocated `environ` array;
   the stack region the kernel exposes is never rewritten. §2 discovered this as the reason `delete
   process.env.X` fails to hide anything. It runs the other way too — and that is the load-bearing fact
   this design rests on:

   ```
   WORKER: env block before restore  clean
   WORKER: process.env after restore HAS SECRET (as intended)
   WORKER: env block after restore   clean
   AGENT : secret found in 0 process env block(s)
   AGENT : positive control visible? yes — instrument works
   ```

Because the credential is restored to the place the AWS SDK already reads, **no client needs a
credentials seam**. Measured on both credential shapes (constraint 4), in the harder ordering where the
client is constructed *before* the restore:

| lane | result |
|---|---|
| static `AWS_ACCESS_KEY_ID` / `SECRET_ACCESS_KEY` / `SESSION_TOKEN` | resolves — `AKIA-RESTORED-AFTER-START` |
| container pointer (Fargate shape) | resolves — endpoint hit twice, see the experiment README |

This **dissolves constraints 2, 3, 4 and 6** rather than satisfying them: no `credentials` field on
`S3StorageProviderOpts`, no `SecretsManagerClient({ credentials })`, no new package dependency for
`pnpm check:deps`, no per-shape refresh logic, and no scrubbed chain degrading into an IMDS timeout on
the post-agent upload path.

### 7.2 The hand-off channel

A file, opened and then **unlinked before the `exec`** — so the payload has no directory entry at any
moment the agent could exist. This is a deliberate tightening of C1′ as written in §4, whose open
question was the window between the entrypoint's write and the worker's `unlink`. That window is not a
new question: the threat model's *Secret at rest* row already concedes mode-`0600` "doesn't protect
against root or a same-uid process", and the agent **is** a same-uid process. A window defended by a
documented contract is not worth taking when the fd costs nothing.

A pipe is still wrong for the reason §4 gives — it needs a live writer, which is the process being
removed.

### 7.3 What crosses the boundary

The payload carries the **entire captured environment**, and `envp` carries only what a POSIX process
needs to run (`PATH`, `HOME`). Not just the AWS chain: `PANGOLIN_CALLBACK_TOKEN_REF` and
`PANGOLIN_PER_DISPATCH_SECRET_REFS_JSON` are named targets of the very docstring this finding falsifies,
and any scheme that classifies each `PANGOLIN_*` var as sensitive-or-not is a list that will drift.

This is gate item 2's polarity result enforced by construction. §3a establishes that the **drop-list is
open** — the Fargate task definition's `secrets:[]` is operator-authored and invisible to us, and
ECS-injected names are AWS's to change — while the **carry-list is closed**. `env -i` plus explicit
carries means an unknown ambient variable is dropped because nobody listed it, which is the only
polarity that survives a deploy we do not control.

**Payload format: NUL-separated `KEY=VALUE`.** `PANGOLIN_BUNDLE_REFS_JSON` is arbitrary JSON, so
newline framing would corrupt it. This is the same framing `/proc/<pid>/environ` itself uses.

### 7.4 The hard-deny in `filterRuntimeEnv`

The restore puts credentials back into the object that production passes as `runWorker`'s `env`
(`pangolin-worker-entry.mjs:19`), and step 8 builds the agent's base env from it. Default-deny already
drops them — but `PANGOLIN_RUNTIME_ENV_ALLOW` can re-open the filter, and a bare `*` re-opens
everything. The threat model lists that as **"documented, not prevented."**

So `filterRuntimeEnv` gains a `HARD_DENY` set consulted **before** the allow-list, which no operator
entry can override:

- prefix `AWS_CONTAINER_CREDENTIALS_`
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`
- `PANGOLIN_CALLBACK_TOKEN_REF`, `PANGOLIN_CALLBACK_BEARER_REF`
- `PANGOLIN_PER_DISPATCH_SECRET_REFS_JSON`

`AWS_REGION` / `AWS_DEFAULT_REGION` stay allowed — non-credential, and the runtime needs them.

The module already has this shape: its docstring forbids extending `BUILTIN_ALLOW_ADAPTER_CONFIG` by a
`PANGOLIN_` prefix rule *precisely* so `PANGOLIN_CALLBACK_TOKEN_REF` cannot be re-exposed, and a test
pins it. `HARD_DENY` makes that reasoning enforceable instead of advisory.

**This is independently valuable and should land first.** It closes the `*` footgun against the
credentials that are ambient in the worker *today*, with no entrypoint machinery — real security value
that does not wait on the rest of §7.

### 7.5 Failure modes

- **`CRED_FD` set but unreadable, or the payload malformed → fail the boot loudly**, non-zero, with a
  `worker.boot.failed` log. The one behaviour this must never have is quiet degradation. Constraint 6
  records exactly that shape: a scrubbed chain does not fail fast, it walks fromEnv → SSO → Ini →
  Process → TokenFile → `fromInstanceMetadata`, i.e. an IMDS timeout with retries, on the post-agent
  upload path where the work is already done and about to be lost.
- **`CRED_FD` absent → skip the restore** and use the ambient environment, i.e. today's behaviour
  exactly. This keeps the existing `CMD`, local iteration, and every current test working.
- **The restore must run before anything constructs a client** — first statement of the entry stub,
  ahead of `runWorker`. `bundle-fetcher.ts:78-81` reads `process.env` directly at storage construction
  (§3a, gate item 3), so a late restore would silently produce a mis-configured S3 client rather than an
  error.

### 7.6 Testing

Gate item 3 governs what can be asserted where. `runWorker`'s `env` parameter is **not** where this
lives: the mechanism acts on the real process environment before `execve`, and every existing test
passes a synthetic object, so a test written in the house style would be **vacuous and would look
exactly like the tests that pass today.**

- **Default suite, unskippable** — cheap, runs everywhere:
  - `HARD_DENY` resists an allow-list containing `*`, the matching `PREFIX_*`, and the exact name.
  - the restore parses a NUL payload into `process.env`, and rejects a malformed one non-zero.
  - the entrypoint script `exec`s rather than spawns — the regression that would silently reintroduce
    C1's surviving launcher.
- **Container level** — the three experiment sets, wired to a **dedicated CI job**. Explicitly **not**
  the `PANGOLIN_E2E_DOCKER` lane: it passes-as-skipped without the flag, which is how a *dangling*
  worker digest survived four releases while `pnpm test:e2e` reported 77 passed. A security tripwire in
  a lane that skips silently is theatre.
- **The tripwire lands first**, as `it.fails`, per §5 — **with a positive control**. Its assertion is
  that a probe finds nothing, and §3a records a `/proc` read returning 0 bytes with the credential
  plainly present. Without a known-present credential recovered in the same run, the test certifies
  only that the instrument is blind.

### 7.7 Honest limits

Stated here so they reach the threat model rather than being discovered later.

- **The credential is heap-resident.** `/proc/<worker>/mem` read back `EACCES` from the agent's
  position, but that is a host yama `ptrace_scope` setting Pangolin does not control — the same class of
  ambient dependency that falsified C3. It is a limit, not a mitigation, and no alternative mechanism
  improves it: every option ends with the credential in the worker's heap.
- **The relative-URI form is unverified on real Fargate.** The pointer lane was proved via
  `AWS_CONTAINER_CREDENTIALS_FULL_URI`, because a relative URI is hardwired to `169.254.170.2` and
  cannot be pointed anywhere reachable. Same provider, so the inference is strong — but it is an
  inference, and Fargate+S3 parity is already the one maintainer-deferred item.
- **The property is enforced by the image's `ENTRYPOINT`, not by the worker.** Running the worker
  directly (as today's `CMD` does) yields today's exposure. The worker cannot defend itself here; only
  a process that `exec`s can.
- **This closes Path 1 only.** The filesystem and any future third path are untouched; C2b (separate
  containers) remains the durable architectural answer for the class, tracked in the sibling spec.

### 7.8 Build order

Smallest-first, each independently landable:

1. **`HARD_DENY` in `filterRuntimeEnv`** — no dependencies, closes the `*` footgun for today's ambient
   credentials on its own.
2. **The tripwire**, `it.fails`, with its positive control.
3. **`entrypoint.sh` + the restore** — the mechanism. Un-skips the tripwire.
4. **Dockerfile**: `ENTRYPOINT` to the new script. Note the base image already ships a
   `docker-entrypoint.sh` that `exec "$@"`s, so the exec chain is unchanged in kind.
5. **Threat-model correction** (§6) — only now, when the claim is true.

The §5 scope note's steps (a), (c) and (d) are **withdrawn**: §7.1 dissolves them. `credentials` on
`S3StorageProviderOpts` remains a real API gap — the only injection point is `client?: S3Client`, which
makes `endpoint`/`forcePathStyle`/`region` inert — but it is a product improvement with no security
claim attached, and it should not be bundled with this work.
