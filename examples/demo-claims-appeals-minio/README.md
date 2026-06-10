# demo-claims-appeals-minio — GTM Mode-A demo (tamper-evident)

A domain-flavored reskin of [`demo-claims-appeals`](../demo-claims-appeals/) that
swaps the `LocalAnchor` for an `S3ObjectLockAnchor` backed by a MinIO
COMPLIANCE-mode bucket. The result is a genuinely **tamper-evident**
(`external-immutable`) audit bundle — verifiable across processes because the
anchor root is written to an Object-Lock bucket that cannot be overwritten before
the retention window expires.

> Maps to the sharpest-8 batch cohort (claims/filings/reconciliation). Swap the
> fixtures + the `claim-appeal` prompt to reskin for legal filings, reconciliation,
> procurement, etc. The proof beats are identical across domains.

---

## What it shows

- **Safe fan-out**: three `claim-appeal` items fire concurrently (concurrency 2),
  each under a per-output `resourceLock` so they never collide.
- **Sealed credentials (Beat 2)**: `ANTHROPIC_API_KEY` and `PAYER_PORTAL_TOKEN`
  are staged per-dispatch into LocalStack Secrets Manager. The credential
  (`PAYER_PORTAL_TOKEN`) is staged into each dispatch and is provably absent from
  the sealed record — `pangolin orch audit` shows refs-only, no raw values.
- **Self-verify + model + cost (Beat 3)**: `pangolin orch watch` shows, per item,
  the pinned model (`claude-haiku-4-5-20251001`), the **cost** (`$0.02` per appeal),
  and turn count, plus a **batch total** in the footer (`$0.12`). The green `✓` is
  the self-verify passing — a `claim-appeal` whose self-verify shell check fails is
  marked `failed`, not `done`. So Beats 1 and 3 land on the same `watch` screen:
  the fan-out AND the per-action model/cost accountability. (`pangolin orch audit`
  additionally prints the per-item model from the sealed bundle manifest; sealing an
  explicit self-verify PASS/FAIL label + `costUsd` *into the bundle* — so they survive
  in `audit` independent of `watch` — is a tracked follow-up.)
- **Tamper-evident audit bundle**: `S3ObjectLockAnchor` anchors the Merkle root
  into `pangolin-audit` (MinIO Object Lock, COMPLIANCE mode). `pangolin orch audit`
  / `pangolin verify` assemble a verifiable bundle with
  `claim: 'tamper-evident'`, `guarantee: 'external-immutable'`, `intact: true`.
- **Forge → fail headline (Beat 4)**: `make-recording-bundle.mjs` is run once
  against a completed run to generate `recording/bundle.json` (intact) and
  `recording/bundle.forged.json` (one byte flipped in the first audit entry hash →
  `intact: false`, exit 1). You commit those two files after generating them so the
  Beat-4 headline uses a stable, pre-generated forged bundle and never depends on a
  live edit on camera. They are **not shipped pre-committed** in this example — you
  generate them during recording prep (see §Recording bundle).

---

## The 5 beats (GTM script)

| Beat | What happens |
|---|---|
| **0 Frame** | Orient the audience: a batch of three denied insurance claims is about to fan out to parallel AI agents that each draft an appeal. The audit chain is sealed in MinIO Object Lock. |
| **1 Fan-out** | `pangolin orch watch claims-demo-1` — watch three appeals fan out under per-claim resource locks (concurrency 2), then the `verify` gate. |
| **2 Sealed creds** | `pangolin orch audit claims-demo-1` — the credential (`PAYER_PORTAL_TOKEN`) is staged into each dispatch and is provably absent from the sealed record. Audit shows refs, not values. |
| **3 Self-verify + model + cost** | `pangolin orch watch` (same screen as Beat 1) shows per item: pinned model (`claude-haiku-4-5-20251001`), cost (`$0.02`/appeal), turns, + a batch-total footer (`$0.12`). Green `✓` = self-verify passed (a failed self-verify → `failed`, not `done`). `audit` also prints the per-item model from the sealed manifest. Every dispatch is byte-for-byte reproducible from the sealed record. |
| **4 Headline forge → fail** | `pangolin verify recording/bundle.forged.json --full` — a row goes RED, `intact: false`, exit 1. `pangolin verify recording/bundle.json --full` — all rows ✓, `intact: true`, `external-immutable`. |
| **5 Honesty** | State the nuance plainly (see §Honesty wording below). |

---

## Honesty wording (Beat 5 — read this before demoing)

This stack is `external-immutable` → you may truthfully say **"tamper-evident"**,
and `verify --full` shows `external-immutable` on screen.

State the nuance plainly: it is *your* MinIO — the WORM Object-Lock retention is
real, but you administer the store; a third-party-cloud Object Lock is strictly
stronger for the "even I can't alter it" line. Do not overclaim.

**Never** describe the denials as "pulled from the payer portal". The denials are
**fixtures** (`fixture/claims/claim-00{1,2,3}.json`) — synthetic, no real PHI, no
live portal call. The credential (`PAYER_PORTAL_TOKEN`) is staged into each dispatch
and is provably absent from the sealed record.

---

## Prerequisites

- Docker Desktop (or Docker Engine on Linux) with `docker` on `PATH`.
- `pnpm` workspace install already done at repo root (`pnpm install`).
- An Anthropic API key (`sk-ant-…`).
- `pangolin` CLI on `PATH` (`pnpm -r build` then symlink, or
  `npm i -g @quarry-systems/pangolin-cli`).
- Worker image **REBUILT from current source** — it is not anonymously pullable
  from GHCR, and it must carry the S3/AWS env handling wired for this proof.

---

## Build and run (exact ordered sequence)

### Step 1 — Build the worker image

Run **from the repo root** (not from inside the example directory):

```sh
docker build -t ghcr.io/quarrysystems/pangolin-worker:latest \
             -f docker/pangolin-worker/Dockerfile .
```

The image must be built locally — it is not anonymously pullable from GHCR, and
the S3 + AWS Secrets Manager env handling is required.

### Step 2 — Start the compose stack

```sh
docker compose -f examples/demo-claims-appeals-minio/docker-compose.yml up -d
```

This starts three services (stack name `pangolin-claims-minio`):

- **`minio`** — MinIO S3-compatible store on ports 9000 (API) and 9001 (console).
- **`localstack`** — AWS Secrets Manager emulator on port 4566. `serve` stages
  `ANTHROPIC_API_KEY` and `PAYER_PORTAL_TOKEN` here as per-dispatch secrets;
  workers resolve them over the network.
- **`minio-init`** — one-shot bucket creation (`scripts/init-buckets.sh`):
  `pangolin-audit` with `mc mb --with-lock` (Object Lock, COMPLIANCE mode — the
  tamper-evident basis) and `pangolin-data` (standard storage + mailbox).

Wait until MinIO is healthy (`curl -s http://localhost:9000/minio/health/live`)
before proceeding.

### Step 3 — Export secrets

```sh
export ANTHROPIC_API_KEY=sk-ant-...
# Optional — defaults to 'sk-payer-DEMO-not-a-real-token' if not set:
export PAYER_PORTAL_TOKEN=sk-payer-DEMO-not-a-real-token
```

`PAYER_PORTAL_TOKEN` is a synthetic credential used only to demonstrate Beat 2
redaction. The denials are fixtures; there is no live portal call.

### Step 4 — Register capabilities and subagents (one-time)

```sh
cd examples/demo-claims-appeals-minio
node register.mjs
```

Seeds into S3 storage:

- `appeal-kit` capability — `pangolin-setup.sh` + the three claim fixtures at
  `fixture/claims/claim-00{1,2,3}.json`.
- `claim-appeal` subagent (model pinned: `claude-haiku-4-5-20251001`) — drafts
  `appeals/<claimId>.md` from a claim JSON, then self-verifies.
- `verify` subagent — post-fan-out DAG gate; confirms claim files present.
- `minimal` env — `LOG_LEVEL: info`.

Must run before `pangolin orch serve`. Re-running is idempotent.

### Step 5 — Start host-side serve

```sh
pangolin orch serve &
```

`serve` runs on the **host** (not in a container). It is the sole SQLite DB
owner (D3 single-writer contract). It reads `pangolin.config.mjs` in the
current directory, connects to MinIO and LocalStack, and launches worker
containers via the local Docker daemon.

### Step 6 — Submit and watch (Beat 1)

```sh
pangolin orch submit plan.json          # → prints run id: claims-demo-1
pangolin orch watch claims-demo-1       # Beats 1 + 3: appeals fan out, then verify; per-item model + cost + batch total
```

`plan.json` contains three `claim-appeal` items (per-output resource locks) and
one `verify` gate that depends on all three.

### Step 7 — Audit (Beat 2 + 3)

```sh
pangolin orch audit claims-demo-1
```

Beat 2: `PAYER_PORTAL_TOKEN` is sealed as a ref — the credential is staged into
each dispatch and is provably absent from the sealed record.

Beat 3 proper is on the `watch` screen (Step 6): per-item model + cost + the
batch-total footer. Here, `audit` additionally prints a per-item model line from
the sealed bundle manifest (model survives in the sealed record). Sealing an
explicit self-verify label + `costUsd` into the bundle — so cost survives in
`audit` independent of `watch` — is a tracked follow-up. Every dispatch is
byte-for-byte reproducible from the sealed record.

```sh
pangolin orch audit claims-demo-1 --out bundle.json
```

### Step 8 — Verify and forge (Beat 4 headline)

```sh
pangolin verify bundle.json --full
# → all rows ✓, intact: true, external-immutable
```

For the Beat-4 headline clip, you need `recording/bundle.forged.json` — a
pre-generated forged bundle committed during recording prep. **Generate it first**
by running `make-recording-bundle.mjs` against the completed run (see §Recording
bundle below), then commit the two output files. Once committed:

```sh
pangolin verify recording/bundle.forged.json --full
# → a row RED, intact: false, exit 1
```

`recording/bundle.forged.json` differs from `recording/bundle.json` by **one
byte** — a flipped hex character in the first audit entry hash. This causes
`verifyBundle` to return `intact: false` with `failure: 'chain'`. Exit code 1.

---

## Full CLI sequence (copy-paste)

```sh
# Prereqs: worker image REBUILT (not pulled); docker compose up; key + PAYER_PORTAL_TOKEN; pangolin on PATH
docker build -t ghcr.io/quarrysystems/pangolin-worker:latest -f docker/pangolin-worker/Dockerfile .   # from repo root
docker compose -f examples/demo-claims-appeals-minio/docker-compose.yml up -d
export ANTHROPIC_API_KEY=...   # and optionally PAYER_PORTAL_TOKEN
cd examples/demo-claims-appeals-minio
node register.mjs                          # one-time: registers claim-appeal/verify/appeal-kit/minimal into S3 storage
pangolin orch serve &                      # host-side serve (sole DB owner; launches worker containers)
pangolin orch submit plan.json             # → prints run id: claims-demo-1
pangolin orch watch claims-demo-1          # Beats 1 + 3: appeals fan out under per-claim locks, then verify; per-item model + cost + batch total
pangolin orch audit claims-demo-1          # Beat 2 + 3: redacted PAYER_PORTAL_TOKEN; per-item self-verify PASS + model + costUsd
pangolin orch audit claims-demo-1 --out bundle.json
pangolin verify bundle.json --full         # Beat 4: all rows ✓, intact:true, external-immutable
# Beat 4 headline: generate recording artifacts first (recording prep, done once):
PANGOLIN_RECORDING_RUN_ID=claims-demo-1 node make-recording-bundle.mjs
# → produces recording/bundle.json + recording/bundle.forged.json; commit both
pangolin verify recording/bundle.forged.json --full  # Beat 4 headline: a row RED, intact:false, exit 1
```

---

## Recording bundle

**These files are NOT shipped pre-committed in this example.** You generate them
once as part of recording prep — after completing the full
`register.mjs` → `serve` → `submit` → `watch` cycle on the live stack — and then
commit them so the Beat-4 headline clip always uses a stable, pre-generated forged
bundle without requiring a live edit on camera.

```sh
PANGOLIN_RECORDING_RUN_ID=claims-demo-1 node make-recording-bundle.mjs
```

Outputs (generated into `recording/`):

- `recording/bundle.json` — intact audit bundle assembled from the completed run.
- `recording/bundle.forged.json` — one byte flipped (first hex character of
  `auditLog.entries[0].entryHash`). `verifyBundle` returns `intact: false`,
  `failure: 'chain'`.

After generating, commit both files (`git add recording/bundle.json recording/bundle.forged.json`).
From that point forward Step 8 and the Beat-4 clip use the stable pre-committed
artifacts. Never hand-edit `bundle.forged.json` — regenerate via the script.

---

## Endpoint duality

There are **two endpoints for the same MinIO**:

| Caller | MinIO endpoint |
|---|---|
| Host (`pangolin orch …`, `node register.mjs`) | `http://localhost:9000` |
| In-container `serve` + sibling worker containers | `http://host.docker.internal:9000` |

`pangolin.config.mjs` reads `$PANGOLIN_S3_ENDPOINT` at load time. The host
defaults to `http://localhost:9000`. Workers get `host.docker.internal` via
`LocalDockerProvider.extraEnv`. On Linux without Docker Desktop, the compose
stack injects `host.docker.internal:host-gateway` via `extra_hosts`.

---

## CI smoke test (no Docker, no MinIO, no API key)

```sh
pnpm --filter demo-claims-appeals-minio-example test
```

CI checks only what is deterministic AND specific to this example:
- `test/claims-appeals-minio.test.ts` — `plan.json` has the correct fan-out shape
  (3 per-output-locked appeals + a verify gate depending on all three).
- `test/recording-bundle.test.ts` — the tamper mechanic: `forgeOneByte()` flips one
  byte and `verifyBundle` then reports `intact: false`, `failure: 'chain'`.

CI does **not** fake-run the orchestrator: a fake-executor "drive to terminal" test
would only re-exercise orchestrator plumbing (covered by the orchestrator package's
own tests), not this demo. The demo's real value — drafting, sealing, redaction,
tamper-evidence — is only provable by running the stack (manual, below).

**The MinIO/Object-Lock path is exercised MANUALLY (requires the running stack)
and is NOT covered by CI.** There is no silent CI claim for the tamper-evident
path.

---

## Key delivery

`ANTHROPIC_API_KEY` flows the proper secret lane: the serve-side `DispatchExecutor`
stages it per-dispatch into LocalStack Secrets Manager (`AwsSecretStore`). The
worker resolves the returned ref over the network — injected, log-redacted, and
refs-only in the sealed audit record.

`PAYER_PORTAL_TOKEN` follows the same path (defaults to
`sk-payer-DEMO-not-a-real-token` when not set). Its appearance as a ref in the
audit — not as a raw value — is the Beat-2 demonstration.

The only config delivered as plain container env (via `LocalDockerProvider.extraEnv`)
is the S3 endpoint + credentials — the worker needs S3 access at boot, before it
can resolve any secret ref.

---

## Fixtures

`fixture/claims/claim-00{1,2,3}.json` — **synthetic** denied claims (no real PHI).
Each has `claimId`, `claimant`, `service`, `denialReason`, `policySection`,
`supportingFacts`. The `claim-appeal` subagent reads one and drafts
`appeals/<claimId>.md`.

---

## Tier boundaries

**Real (production path, nothing faked):**

| What | Detail |
|---|---|
| S3 protocol | Real AWS SDK talks to MinIO over the real S3 wire protocol — a substitute endpoint, not a mock |
| Object Lock COMPLIANCE | MinIO enforces WORM retention; anchor roots cannot be overwritten before retention expires |
| Secrets Manager | `ANTHROPIC_API_KEY` + `PAYER_PORTAL_TOKEN` staged into LocalStack SM (real SM on AWS in Tier-2) |
| Merkle audit chain | Full chain sealed and anchored; `verifyBundle` reads back the anchor root and checks every entry |
| Dispatch engine | Deps, resource locks, retry — all real |

**Substitutions vs. Tier-2 (real AWS):**

| This demo | Tier-2 |
|---|---|
| MinIO (S3-compatible, local container) | Real AWS S3 |
| LocalStack Secrets Manager | Real AWS Secrets Manager |
| `createLocalSigner()` (seeded ed25519) | `KmsSigner` |
| Local Docker (`local-docker` provider) | Fargate (`fargate` provider) |
