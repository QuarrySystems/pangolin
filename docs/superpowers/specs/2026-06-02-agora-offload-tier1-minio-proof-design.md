---
title: "Agora Offload — Tier-1 MinIO Proof (remote-stack validation for $0)"
date: 2026-06-02
status: draft
authors: [human:Brett, agent:claude-opus-4-8]
builds_on:
  - "[[docs/superpowers/specs/2026-05-28-agora-orchestrator-design.md]]"
  - "[[docs/superpowers/specs/2026-05-29-agora-offload-v1-design.md]]"
---

# Agora Offload — Tier-1 MinIO Proof

> **Goal:** prove the offload orchestrator can run as a remote-style service —
> submit over an S3 inbox with no inbound networking, dispatch across multiple
> named worker locations, escape patches, and produce a **genuinely
> tamper-evident** (`external-immutable`) audit bundle — using only free,
> S3-compatible substitutes (MinIO + local Docker). No AWS spend, near-zero
> Anthropic spend.
>
> This is **Tier 1** of the two-tier plan agreed in the 2026-06-01/02 design
> conversation. Tier 2 (the real Fargate + S3 parity run) becomes a pure
> endpoint/config swap once this passes — it is explicitly out of scope here.

---

## 0. Why this exists

The Offload V1 spec ([2026-05-29](./2026-05-29-agora-offload-v1-design.md))
shipped `serve`, the submission transport, patch escape, and the Merkle/anchor
audit layer — but its one operator-deferred acceptance item is the **Fargate + S3
parity run**, and the V1 `offload-fanout` demo only exercises the *local* stack
(`LocalStorageProvider`, `LocalDirMailbox`, `LocalAnchor` = `tamper-detecting`).

Two things were never validated end-to-end:

1. The **S3 submission/transport model** — submit via an object store, `serve`
   polls it, no inbound networking. (V1 ships **only** `LocalDirMailbox`; there is
   no S3-backed `MailboxStore` yet.)
2. The **`external-immutable` audit tier** — `S3ObjectLockAnchor` exists but has
   never run against a real object-lock backend, nor has the "DB tampered, but the
   anchored root cannot be rewritten → verification fails" claim been demonstrated.

Both can be proven for $0 against MinIO (S3-compatible, supports object lock).
Doing so also *builds the two genuinely-missing production pieces* (an S3 mailbox
and a concrete S3-lock client), so Tier-2 Fargate is a config swap, not new code.

## 0.1 What this proves vs. defers

**Proves (Tier 1):**
- `serve` as a remote-style service: client and service communicate **only**
  through the object-store mailbox (no direct connection).
- Multiple worker locations via **routing-by-executor-name** (two registered
  dispatch executors; per-`WorkItem` selection).
- Patch escape → `result_ref` against S3-backed content-addressed storage.
- `external-immutable` audit tier against MinIO Object Lock, **including the
  DB-tamper-fails-verification** test.
- `serve` runs **as a container with no published port** — reachable only through
  the MinIO mailbox. The strongest available demonstration of the
  no-inbound-networking / "lives outside local env" model short of a remote host.
- **Maximum fidelity:** every edit runs the **real `claude-code` adapter** (the exact
  path `offload-fanout` proves green) on a one-line rename — nothing about the worker
  is faked. Cost is ~pennies of tokens per run (infra is free).

**Defers (explicitly out of scope):**
- Real AWS (Fargate compute, real S3, EFS volume, KMS signer) — Tier 2.
- Genuine cross-*machine* dispatch (second physical box via `DOCKER_HOST=ssh`).
  Tier-1 routes to two executors that both target the *local* Docker daemon; this
  proves the routing seam. Cross-machine is a target-string change later. (`serve`
  *is* containerized in Tier 1 — see §5 — but it dispatches to the **local** host
  daemon via the mounted socket, not a remote one.)
- Everything already deferred by the V1 spec (Intent/interpreter, `dev` pack,
  budgets, `cron`, RBAC, BYOK).

## 0.2 Representativeness boundary — what a green Tier-1 actually means

A passing Tier-1 must not be over-read. This section pins exactly what the green
checkmark does and does not cover, so neither a future reader nor a marketing
claim mistakes it for a Fargate proof.

**The worker is not faked anywhere.** Every edit runs the real `claude-code`
adapter through the full worker pipeline — the exact path `offload-fanout` already
proves green:

```
boot → resolve secrets → agora-setup.sh → captureBaseline (git write-tree)
   → RuntimeAdapter.invoke()   ← the REAL claude-code adapter spawns the claude CLI
   → computeWorkspacePatch (git diff) → upload patch artifact
   → write .agora/output.json → emit lifecycle events
```

**Why all-real (spike finding, 2026-06-02).** An earlier draft proposed a no-model
adapter to drive token cost to $0. A spike found there is **no per-dispatch
runtime-adapter selection** in the codebase: `agora-client` hardcodes
`AGORA_RUNTIME_ADAPTER: 'claude-code'` (dispatch.ts:219), `DispatchWork` has no
`runtimeAdapter` field, and `work.env` is env-bundle *references* (not raw env). A
no-model adapter would therefore require a product change to `agora-client`. Since
the goal is a *true* pressure test, the better answer is to run the real adapter on
a trivial one-line rename — maximally faithful, zero product change, ~pennies/run.
(Per-dispatch runtime selection remains a legitimate future `agora-client` feature
for multi-runtime — Bedrock/Codex — but it is out of scope here.)

**Fully exercised (everything except the AWS-specific substitutions):** serve-over-S3
with no inbound networking, multi-executor routing, container boot + real secret
staging (`ANTHROPIC_API_KEY`), baseline, the **real** `claude` agent edit loop, the
git-diff patch escape → `result_ref`, S3-backed content-addressed storage, the Merkle
audit + object-lock anchor + verify, and the dispatch fire/reconcile + deps + locks +
retry engine.

**The only substitutions (legitimate endpoints, not mocks):**
- Storage / mailbox / anchor → **MinIO**. The real AWS SDK talks to MinIO over the
  real S3 protocol; the code can't tell. A substitute *endpoint*, not a mock.
- Compute → **local Docker** (`local-docker` provider) instead of Fargate.

**NOT covered by Tier-1 (these are Tier-2):**
- Fargate mechanics: ECS task launch, IAM task roles, EFS volume mount, the
  `agora-providers-fargate` compute path.
- Real AWS S3 + real Object-Lock `COMPLIANCE` enforcement (vs MinIO's implementation).
- `KmsSigner` (Tier-1 uses the local ed25519 signer).
- Live egress to Anthropic from inside a *VPC-bound* task (Tier-1 egresses from the
  local worker container, which is real egress — just not VPC-constrained).

The architectural bet is that every NOT-covered item is a **seam swap** (target
string, endpoint, signer), not new code — so Tier-1 de-risks everything *up to* the
swap, and Tier-2 validates the AWS implementations *behind* the seams.

---

## 1. New components

Three building blocks, named for their **mechanism**, not the deployment they are
tested against (MinIO-ness lives only in config — see §6). The worker itself is the
**stock** `claude-code` image — no new adapter:

| Component | What it is | Home (Tier 1) |
|---|---|---|
| `S3Mailbox` | `MailboxStore` (`put/get/list/delete` over `/`-delimited keys) implemented against an **injected minimal S3 seam** — same injection pattern `S3ObjectLockAnchor` already uses, so `agora-orchestrator` gains **no** AWS-SDK dependency. | `agora-orchestrator/src/mailbox/s3.ts` (reusable logic) |
| `MailboxS3Client` | The tiny injected seam `S3Mailbox` depends on (object put/get/list/delete). Interface only. | `agora-orchestrator/src/contracts/mailbox.ts` |
| `AwsS3MailboxClient` | Concrete `MailboxS3Client` backed by `@aws-sdk/client-s3`; endpoint-configurable (MinIO now, real S3 later). | `examples/offload-minio/` for now |
| `AwsS3LockClient` | Concrete `S3LockClient` (the seam `S3ObjectLockAnchor` already declares): `PutObject` with object-lock `COMPLIANCE` retention + `GetObject`. Endpoint-configurable. | `examples/offload-minio/` for now |

**Trap-check / promotion (orchestrator spec §11):** the two `Aws*` concrete
clients stay example-local until a **second consumer** (Tier-2 Fargate) pulls
them; at that point they promote to `agora-storage-s3` (which already carries the
AWS SDK). The reusable `S3Mailbox` logic and its seam live in the orchestrator
now because that is where `MailboxStore` lives and the dependency direction stays
downhill (`orchestrator → storage-s3 → core`).

### 1.1 Dependency direction (must stay downhill)

`MailboxStore` and the new `MailboxS3Client` seam live in `agora-orchestrator`.
`S3Mailbox` (orchestrator) depends only on those interfaces. The concrete
`AwsS3MailboxClient` / `AwsS3LockClient` depend on `@aws-sdk/client-s3` and live
in the example, injected at construction — exactly mirroring how the example
already injects `LocalDirMailbox` into `MailboxSubmissionTransport` and how
`S3ObjectLockAnchor` takes an injected `S3LockClient`. No package gains an uphill
edge.

---

## 2. Infrastructure (all local, $0)

- **`examples/offload-minio/docker-compose.yml`** — a MinIO container with **two
  buckets** (the split is load-bearing, not cosmetic — see below):
  - **`agora-audit`** — created **with object lock enabled** (object lock can only
    be set at bucket creation), `COMPLIANCE` mode. Anchor roots **only**.
  - **`agora-data`** — a normal bucket (no lock) holding both the content-addressed
    storage and the mutable mailbox inbox/outbox (under distinct prefixes).
  - root credentials via compose env; surfaced to the example config.

  **Why two buckets:** object lock is a *bucket-level* setting and a `COMPLIANCE`
  bucket **rejects deletes/overwrites** before retention expires. The mailbox needs
  `delete` (consume inbox entries) and storage round-trips fine without lock, so
  both live in `agora-data`; only the WORM anchor roots go in `agora-audit`. Putting
  the mailbox in the locked bucket would break inbox consumption.
- **`serve` runs as its own container** in the compose stack (no published port):
  - mounts the **host Docker socket** (`/var/run/docker.sock`) so it launches
    worker containers as **siblings** on the host daemon (docker-out-of-docker).
    This is safe here precisely because storage is S3/MinIO, not host bind-mounts
    (the substrate-topology constraint — remote/containerized dispatch needs object
    storage). `LocalDockerProvider` reads the socket via `new Docker()` by default.
  - mounts a **named Docker volume** for the SQLite run-state DB (D4: persistent
    volume; the local analogue of EFS/EBS).
  - is the **only DB opener** and the only `tick()` caller. The client
    (`OperationsApi`) reaches it **only** through the MinIO mailbox — serve exposes
    no inbound port at all.
  - is also given `ANTHROPIC_API_KEY` (its executors stage it into the real worker)
    and `AGORA_S3_ENDPOINT=http://host.docker.internal:9000`.
  - **config loading:** the serve container needs the orchestrator constructed from
    `agora.config.mjs` (executors/anchor/transport). *Plan task:* confirm whether
    `agora orch serve` loads the example config directly, or a thin
    `serve-entrypoint.mjs` that imports the config and calls `serve()` is needed.
- **Workers** run in **local Docker** via `LocalDockerProvider` (started by serve
  on the host daemon), using the **stock** worker image with its built-in
  `claude-code` adapter — no derived image. The image is GHCR-private, so build it
  locally once:
  `docker build -t ghcr.io/quarrysystems/agora-worker:latest -f docker/agora-worker/Dockerfile .`

### 2.1 MinIO endpoint duality (a wiring nuance, easy to get wrong)

`LocalDockerProvider` sets **no `NetworkMode`** (confirmed in source — it only sets
`HostConfig.Binds`), so sibling worker containers land on the **default bridge**,
not the compose network. Consequently MinIO is published on the host and there are
**two endpoints for the same MinIO**:

| Caller | MinIO endpoint |
|---|---|
| Host client (`submit`/`watch`/`audit` via `OperationsApi`) | `http://localhost:9000` |
| In-container `serve` + sibling worker containers (on default bridge) | `http://host.docker.internal:9000` |

So the example config must use the in-container endpoint for the executor/worker
and serve paths, and the host endpoint for the client path. (On Linux without
Docker Desktop, `host.docker.internal` may need the `host-gateway` mapping; noted
as a plan portability detail.)

---

## 3. Worker: the stock claude-code adapter + per-item file selection

Every edit runs the **stock** `claude-code` adapter — the same one `offload-fanout`
proves. There is no custom adapter and no per-dispatch adapter selection (the spike
found `AGORA_RUNTIME_ADAPTER` is hardcoded in `agora-client`; §0.2). What *is*
per-item is the **file to edit**, passed via the structured input channel — verified
end-to-end in the spike:

```
WorkItem.inputs.workerInput  →  DispatchExecutor → work.input
   → AGORA_INPUT_JSON (dispatch.ts:218) → worker inputJson (env-parser.ts:94)
   → RuntimeInvocation.input → {{file}} substitution in the code-edit promptTemplate
```

So each edit item carries `workerInput: { file: "<name>.ts" }`, and the `code-edit`
subagent's `promptTemplate` references `{{file}}` (exactly the `offload-fanout`
pattern: "rename OLD_NAME → NEW_NAME in `{{file}}` only"). The agent makes a real
edit → real git diff → patch artifact → `result_ref`.

> **Note (deferred feature):** per-dispatch runtime-adapter selection — needed for a
> future multi-runtime story (Bedrock/Codex) or a genuine zero-token mode — would be
> a small `agora-client` change (`DispatchWork.runtimeAdapter` → the hardcoded
> `AGORA_RUNTIME_ADAPTER`). Out of scope for this proof; recorded so the option isn't
> lost.

---

## 4. Configuration (`examples/offload-minio/agora.config.mjs`)

Modeled on `examples/offload-fanout/agora.config.mjs`, with these swaps:

The MinIO endpoint is **read from an env var** (`AGORA_S3_ENDPOINT`), *not*
hardcoded — because the same config file is imported by both the in-container serve
path (`host.docker.internal:9000`) and the host client path (`localhost:9000`) per
§2.1. Compose sets it for the serve container; the host driver sets it for the
client.

- **storage** → `S3StorageProvider` with an injected `S3Client`
  (`endpoint: $AGORA_S3_ENDPOINT`, `forcePathStyle: true`, region/creds from
  compose env), bucket `agora-data` (storage prefix).
- **transport** → `new MailboxSubmissionTransport(new S3Mailbox(new AwsS3MailboxClient({ endpoint: $AGORA_S3_ENDPOINT, bucket: 'agora-data', prefix: 'mailbox/', ... })))`.
- **anchor** → `new S3ObjectLockAnchor(new AwsS3LockClient({ endpoint: $AGORA_S3_ENDPOINT, bucket: 'agora-audit', ... }), 'agora-audit')`
  (replaces `LocalAnchor`; the object-lock bucket).
- **executors** → **two** dispatch executors, both `target: 'local'`, the **stock**
  `workerImage` (`ghcr.io/quarrysystems/agora-worker:latest`), keyed `dispatch-a`
  and `dispatch-b`. Each carries
  `secrets: { ANTHROPIC_API_KEY: { inline: process.env.ANTHROPIC_API_KEY } }` so the
  real worker can run (matching `offload-fanout`). The worker env carries
  `AGORA_S3_ENDPOINT=host.docker.internal:9000` (sibling containers are on the
  default bridge, §2.1).
- **signer** → `createLocalSigner()` (ed25519) — unchanged; `KmsSigner` is Tier-2.

All MinIO-specific values (endpoint, bucket names, `forcePathStyle`, credentials)
live in config/env — **not** in any class name (§1).

---

## 5. Run shape (`examples/offload-minio/plan.json` + driver)

A single submitted `Run` that exercises every claim at once. **All four edits run
the real `code-edit` subagent** (stock `claude-code` adapter); each carries
`workerInput: { file }`:

- **`edit-alpha` / `edit-beta`** — disjoint per-file `resourceLock`s, one on
  `dispatch-a` and one on `dispatch-b` → **fan out** concurrently.
- **`edit-shared-1` / `edit-shared-2`** — both lock `shared.ts` → **serialize**
  (the rename is idempotent, so order is irrelevant and both produce a valid patch).
  This is the resource-lock contention demonstration, proven not just claimed.
- **`verify` gate** that `depends_on` all four edits — proves DAG ordering.

Unlike `offload-fanout` (which runs serve and the client in one process), Tier-1
**splits the two roles** because serve is containerized (§2):

- **Service side** — the serve container constructs orchestrator + `S3Mailbox`
  transport + anchor from the config and runs the `serve()` loop. It holds the
  executors (and thus the staged `ANTHROPIC_API_KEY`). No client code, no published port.
- **Client driver** (`examples/offload-minio/src/index.ts`, host process) — registers
  the `code-edit`/`verify` subagents + the fixture capability **into shared MinIO
  storage** (content-addressed, not a serve connection), then builds only an
  `OperationsApi` over the **same** `S3Mailbox` transport (host endpoint) and
  `submit → watch → status → audit`. It never holds the `orchestrator`/`store` —
  it reaches the service purely through MinIO, and needs **no** API key itself.

`docker compose up` starts MinIO (+ bucket init) and serve (with `ANTHROPIC_API_KEY`
from `../../.env`); the host driver is then run against the same MinIO.

---

## 6. Acceptance criteria (the proof passes iff)

1. `submit` returns a run id and does not block.
2. `watch` shows waves advancing with blocking reasons (lock/dep), driven entirely
   through the **MinIO** mailbox (no direct client↔serve channel).
3. Every edit item (all four run the real `claude-code` worker) exposes a
   `result_ref`; fetching it from MinIO yields a reviewable patch. `edit-shared-1`
   and `edit-shared-2` are observed to serialize via their shared lock.
4. `audit <run-id>` produces a bundle whose `report.intact === true` and
   **`report.guarantee === 'external-immutable'`** and `report.claim` reads
   *tamper-evident* (not merely *tamper-detecting*), with `anchorId` naming the
   MinIO object-lock anchor.
5. **DB-tamper test:** mutate a persisted audit entry in the SQLite store, leave
   the MinIO-anchored root untouched, re-run verification → it **fails** (root
   mismatch against the un-rewritable anchored root). This is the compliance edge,
   demonstrated for free.
6. The exported bundle contains **no secret values** (refs only).

## 7. Testing

- **Unit (against the MinIO container):** `S3Mailbox` round-trips
  (put/get/list/delete, prefix-scoped list, absent→null); `AwsS3LockClient`
  writes an object under `COMPLIANCE` retention and a delete/overwrite before
  retention is rejected; `AwsS3MailboxClient` parity with `LocalDirMailbox`
  behavior.
- **e2e (live):** the §5 run, asserting the §6 criteria — green run + a separate
  asserted-failure tamper case.
- **CI smoke (no Docker / no MinIO / no key):** mirror `offload-fanout`'s fake-
  executor test — assert `plan.json` shape (executor routing + locks + verify
  `depends_on`) and that a fake-executor `AgoraOrchestrator` drives it to
  completion. `S3Mailbox` logic unit-tested against an in-memory `MailboxS3Client`
  fake so its logic has coverage without a container.

## 8. Risks & open details

- **Subagent registration must reach shared MinIO storage before run** — the host
  driver registers `code-edit`/`verify` + the fixture capability via the
  `AgoraClient` (storage = `agora-data`). The serve-launched workers fetch them from
  the same bucket. This is storage I/O, not a serve connection, so it doesn't weaken
  the no-inbound-networking claim — but the driver's `AgoraClient` and serve's
  executors must point at the **same** `agora-data` bucket/namespace or workers 404.
- **Docker-out-of-docker from the serve container** — serve must reach the host
  daemon via the mounted socket. On Docker Desktop/Windows the socket path and
  permissions differ from native Linux; the plan must confirm the mount works on
  the dev host (this machine). Sibling workers (not children) keep isolation intact.
- **MinIO endpoint duality + worker networking** (§2.1) — the two-endpoint setup is
  the most error-prone wiring. The plan must verify sibling worker containers on the
  default bridge can actually reach `host.docker.internal:9000` (and add the
  `host-gateway` mapping on non-Desktop Linux). A worker that can't reach MinIO
  fails the escape/storage step.
- **serve container config loading** (§2) — confirm `agora orch serve` can load the
  example `agora.config.mjs`, else add a thin `serve-entrypoint.mjs`.
- **MinIO object-lock semantics** — bucket must be created with object lock
  *enabled* up front; `COMPLIANCE` mode + a short retention for the test. Verify
  the AWS SDK `PutObject` object-lock params (`ObjectLockMode`,
  `ObjectLockRetainUntilDate`) are honored by the MinIO version pinned in compose.
- **No-inbound-networking honesty** — the claim rests on the client using *only*
  the mailbox. Containerizing serve with no published port enforces this
  structurally (the host driver *cannot* reach serve directly), which is stronger
  than the single-process `offload-fanout`; keep it that way (don't add a debug
  port).
- **Storage vs mailbox vs anchor buckets** — content-addressed artifacts
  (`S3StorageProvider`) and the mutable inbox/outbox (`S3Mailbox`) share the
  unlocked `agora-data` bucket under distinct prefixes; the WORM anchor roots
  (`AwsS3LockClient`) **must** be the separate object-lock `agora-audit` bucket
  (§2). They are distinct seams; do not conflate, and never point the mailbox at a
  locked bucket (deletes would fail).

## 9. Tier-2 handoff (what this buys)

Tier-1 already containerizes serve, runs on object storage, and exercises the
object-lock anchor — so Tier 2 is mostly substitution. When a paying reason
justifies the real run:
1. Promote `AwsS3MailboxClient` / `AwsS3LockClient` to `agora-storage-s3`
   (now a second consumer exists).
2. Drop the `AGORA_S3_ENDPOINT` override so the SDK targets real S3; swap
   `createLocalSigner` → `KmsSigner`.
3. Move the **already-containerized** serve from compose onto Fargate with an
   EFS/EBS volume for SQLite (D4). Compute changes from the local socket-mounted
   daemon to a real `fargate` dispatch target — the executor map's `target` string,
   not new code.
4. Re-run the same `plan.json`. The §6 criteria should hold unchanged — that
   equivalence *is* the local→prod parity the V1 spec §7 calls for.

Cost discipline for Tier 2 (from the design conversation): billing alarm at $1,
**no NAT gateway** (the #1 surprise-bill trap — use a public subnet or VPC
endpoints), tear down same-day.

---

End of spec.
