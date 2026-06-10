# demo-claims-appeals-minio — tamper-evident GTM demo (design)

**Date:** 2026-06-10
**Status:** approved (brainstorming)
**Author:** agent:claude-opus-4-8 (with Brett)
**Source of truth:** `wikis/agora/guides/guide-demo-mode-a-batch-runseal-claims.md` (the GTM script)

## 1. Purpose

A recordable, CLI-only, **tamper-evident** claims-appeals demo that runs the GTM
script's 5 beats against **local MinIO with S3 Object Lock**. It is the
pre-outreach Mode-A demo (batch run+seal): a batch of denied insurance claims →
parallel drafted appeals → sealed audit bundle → the headline *forge-one-byte →
verification-fails* beat.

It ships as a **new sibling example** at `examples/demo-claims-appeals-minio/`,
parallel to the repo's existing `offload-fanout`/`offload-minio` pair. The
existing `examples/demo-claims-appeals` (LocalAnchor, `start:env`,
**tamper-detecting**) is left intact as the zero-setup laptop version; together
the two examples make the assurance-tier ladder concrete.

Audience for the recording: **non-technical buyers** (insurance ops, compliance,
execs).

### Non-goals
- **No dashboard / UI.** The product's wedge is "math your auditor re-runs, not a
  dashboard you trust." A UI would weaken Beat 4's credibility and risk
  repositioning into the commodity "agent dashboard" category. Polish is via
  narration + clean terminal + before/after stills in the video edit. A separate
  "governance console" could be a *future* asset, out of scope here.
- No CI coverage of the live MinIO/Object-Lock path (it needs the stack); CI
  covers only the deterministic fake-executor smoke test. The README says so
  explicitly — no silent claim of coverage.
- No reskins (legal/reconciliation/etc.) built here — that's a doc table in the
  script.

## 2. Topology (host-side serve)

Chosen over the fully-containerized `offload-minio` topology because the demo is
**recorded**: the terminal on camera should be the host running `pangolin orch …`
verbatim per the script, with the fewest moving parts.

- `docker compose up -d` brings up **MinIO** (buckets: `pangolin-audit` with
  Object Lock / COMPLIANCE mode, `pangolin-data` normal), **LocalStack**
  (Secrets Manager — the credential lane for Beat 2), and a one-shot
  **minio-init**. **No serve container.**
- Operator runs `pangolin orch serve &` **on the host**. Serve is the sole
  SQLite writer (local DB path) and launches **sibling worker containers** via
  the local Docker socket.
- All `pangolin orch …` / `pangolin verify …` commands run on the host — the
  recorded terminal.

### Endpoint duality (already solved in offload-minio)
- Host process → MinIO `http://localhost:9000`, LocalStack `http://localhost:4566`.
- Worker containers → `http://host.docker.internal:9000` / `:4566`, injected via
  `LocalDockerProvider` `extraHosts` + `extraEnv` in the config.

### Data flow per run
1. `register.mjs` writes `claim-appeal`/`verify` subagents + `appeal-kit`
   capability + `minimal` env into S3 storage (`pangolin-data`).
2. `submit plan.json` → submission lands in the S3 mailbox; serve picks it up.
3. Serve dispatches 3 `claim-appeal` workers (concurrency 2, per-claim
   `resourceLocks`); each resolves the credential ref from Secrets Manager,
   drafts `appeals/<claimId>.md`, self-verifies, and its patch escapes as a
   content-addressed artifact.
4. `verify` gate runs after all three reach `done`.
5. Serve seals the epoch → Merkle root written to the Object-Lock bucket via
   `S3ObjectLockAnchor` (WORM, COMPLIANCE) → guarantee `external-immutable`.
6. `audit` / `verify --full` read bundle from mailbox/anchor/storage and
   re-verify.

## 3. Files

```
examples/demo-claims-appeals-minio/
  pangolin.config.mjs       # from offload-minio: S3 storage+mailbox, AwsSecretStore,
                            #   S3ObjectLockAnchor, seeded cross-process signer.
                            #   namespace 'demo-claims-appeals'. Host endpoints default
                            #   to localhost; workers get host.docker.internal via extraEnv.
  docker-compose.yml        # MinIO + LocalStack + minio-init (NO serve container)
  scripts/init-buckets.sh   # pangolin-audit (--with-lock) + pangolin-data
  register.mjs              # registers claim-appeal + verify + appeal-kit + minimal env
  plan.json                 # 3 appeals (per-claim locks) + verify gate (id: claims-demo-1)
  fixture/claims/claim-00{1,2,3}.json   # synthetic denials (lifted from existing example)
  make-recording-bundle.mjs # emits known-green bundle.json + pre-forged bundle.forged.json
  test/claims-appeals-minio.test.ts     # deterministic CI smoke (fake executor)
  README.md                 # operator runbook + the 5-beat script inline + honesty wording
  package.json
```

**Reuse:** the `claim-appeal`/`verify` subagent definitions (prompt +
self-verify command) and the 3 claim fixtures already exist in
`examples/demo-claims-appeals` — lift them verbatim.

**Credential for Beat 2:** stage a synthetic `PAYER_PORTAL_TOKEN` through
`AwsSecretStore` alongside `ANTHROPIC_API_KEY`, so the redaction beat has a
domain-named credential to show (ref-only in the audit, log-redacted).
**Honesty note:** the denials are fixtures — the demo does NOT simulate a live
portal pull. The token is *staged into each dispatch as a per-dispatch secret*
and is provably absent from the sealed record. Narration must say exactly that
("staged into each dispatch, provably absent from the record"), NOT "used to
pull the denial" (the script's framing assumes a live pull we don't perform).
If a credential staged-but-unused reads as a hollow prop on camera, cut Beat 2
to the gating cut (0/1/4/5) rather than overclaim.

**Signer:** reuse offload-minio's seeded deterministic ed25519 signer (fixed
seed shared via config, override `PANGOLIN_SIGNER_SEED_HEX`) so serve (signs) and
the host verifier (verifies) — separate processes — agree cross-process. DEV
ONLY; production uses an out-of-band public key (KMS).

## 4. The 5 beats → commands

| Beat | Command(s) | Surfaces |
|---|---|---|
| 0 Frame | — | spoken intro |
| 1 Fan-out | `pangolin orch submit plan.json` → `pangolin orch watch <id>` | 3 appeals fan out under per-claim locks → `done` + `resultRef` |
| 2 Sealed creds | `pangolin orch audit <id>` | `PAYER_PORTAL_TOKEN` ref-only / redacted; never in transcript |
| 3 Ran-to-byte | `pangolin orch audit <id>` | per item: self-verify PASS + model + costUsd — **committed** |
| 4 Headline | `pangolin orch audit <id> --out bundle.json` → `pangolin verify bundle.json --full` (green) → forge byte → `verify` again | all `✓` / `intact:true` / `external-immutable`; one row RED / `intact:false` / exit 1 |
| 5 Honesty | — | spoken close (external-immutable ⇐ S3 Object Lock) |

The outreach-**gating** 60–90s cut is Beats **0 → 1 → 4 → 5** (skips 2 & 3) —
record that first. Beat 3 is the GTM-critical "govern-and-run" beat (self-verify
quality gate + per-action cost accountability) and is **committed**, not optional
— it answers the economic buyer's "can I trust the output and control the spend?"

### Beat 3 — committed (the data already exists; this is surfacing, not a build)
Spike findings (2026-06-10, code-grounded):
- **Model + cost: landed.** `model-cost-evidence` DAG complete (14/14). The
  claude-code adapter extracts `total_cost_usd` (`pangolin-runtime-claude-code/src/envelope.ts:19`),
  the worker sums per-block usage (`pangolin-worker/src/pipeline-runner.ts:181`),
  and the orchestrator already renders per-node model + a `costUsd` footer in the
  run **view** (`pangolin-orchestrator/src/view/render.ts:107,541`). `pangolin
  orch watch` shows model/cost today.
- **Self-verify: captured per item** (Gap A — the item's `verify` field, sealed
  with the patch; `dispatch.ts:110` returns it on the dispatch result).

So all three fields exist in run-state now. The work is **bounded wiring**, two
tasks:
1. **Surface per-item self-verify + model + costUsd in `pangolin orch audit`
   output** (the script places Beat 3 under `audit`). Data is in run-state; this
   is an orchestrator render/assembly task, not new evidence capture. (If during
   planning this proves larger than render-wiring, the fallback is to show Beat 3
   via `pangolin orch watch` — which already renders model/cost — plus the
   item's self-verify; the demo still lands, just under a different command.)
2. **Pin a model on the `claim-appeal` subagent** so the model id renders
   non-empty (unpinned today → blank).

## 5. Honesty enforcement (non-negotiable)
- S3 Object Lock → `external-immutable` → **"tamper-evident"** is truthful, and
  the `verify --full` render shows `external-immutable` on-screen.
- README states the one nuance plainly: it is *your* MinIO — the WORM retention
  is real but you administer the store; third-party-cloud Object Lock is strictly
  stronger for the "even I can't alter it" line. No overclaim.
- The LocalAnchor sibling remains "tamper-detecting." The pair *is* the tier
  ladder.

## 6. Recording artifacts (script guardrail: never depend on a live edit)
`make-recording-bundle.mjs` runs the flow once and emits two files:
`bundle.json` (known-green) and `bundle.forged.json` (one byte flipped in the
first audit entry's hash). The recording does `verify bundle.json --full` (green)
then `verify bundle.forged.json --full` (RED, exit 1) — deterministic. README
also documents the manual live forge for anyone who wants it.

## 7. Testing & gates
- `test/claims-appeals-minio.test.ts` — deterministic CI smoke, **fake
  executor** (no containers/MinIO/LLM), mirroring the existing
  `demo-claims-appeals` test: asserts `plan.json` fan-out shape (3
  per-output-locked appeals + verify gating all three), drives a real
  orchestrator to completion, every appeal `done` with `resultRef`,
  `bundle.report.intact === true`.
- The MinIO/Object-Lock path is exercised **manually** (needs the stack), not in
  CI — README says so.
- `pnpm --filter demo-claims-appeals-minio-example typecheck` + repo `pnpm -r
  lint` green.

## 8. Prerequisites (README "before you record")
1. Worker image **rebuilt** from current source
   (`docker build -f docker/pangolin-worker/Dockerfile -t
   ghcr.io/quarrysystems/pangolin-worker:latest .`) — must carry the S3/AWS env
   handling; **not** pulled.
2. `docker compose up -d` (MinIO + LocalStack healthy, buckets initialized).
3. `ANTHROPIC_API_KEY` + synthetic `PAYER_PORTAL_TOKEN` available to serve.
4. `pangolin` CLI on PATH.

## 9. Success criteria
1. `node register.mjs` → `pangolin orch serve &` → `submit` → `watch`: 3 appeals
   `done`, verify `done`, live, on MinIO.
2. `audit` shows the redacted credential (Beat 2) and — if the spike passes —
   self-verify/model/cost (Beat 3).
3. `verify bundle.json --full` → all `✓`, `intact:true`, `external-immutable`;
   forged copy → RED, `intact:false`, exit 1.
4. CI smoke test + typecheck + lint green.
5. README carries the 5-beat script and the honesty wording.

## 10. Open risks
- **Beat 3 placement** — committed; the only open question is whether per-item
  self-verify+model+cost goes into `audit` output (render-wiring, preferred) or
  is shown via `watch` (already renders model/cost) + the item's self-verify.
  Either way Beat 3 ships; planning picks the cleaner surface. NOT a feature gap.
- **MinIO/LocalStack on Windows + Docker Desktop**: `host.docker.internal` is
  injected by Docker Desktop, so worker→MinIO should resolve; verify during
  implementation. If LocalStack Secrets Manager proves flaky on this host, Beat 2
  falls back to documenting the secret lane without the live redaction shot
  (record-time decision, not a blocker for the gating cut).
- Worker image must carry S3/AWS env handling — confirm the rebuilt image does
  (current source is post the minio-proof feature).
