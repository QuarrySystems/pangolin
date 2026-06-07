# `deploy/serve-stack` — always-on `agora orch serve` on the portsandbox host — design

**Date:** 2026-06-07
**Status:** approved (brainstorm session, post #56)
**Motivation:** seven live runs this weekend, every one manually kicked off and babysat on the laptop; the product claim is "runs while you sleep, hands you a sealed ledger" and the orchestrator currently dies when the laptop lid closes. Kickoff is the loudest felt friction in the demand-pull queue (position synthesis item 2 — deliberately sequenced after self-verify + gates existed; both now do). `examples/offload-minio` already proved every hard sub-problem (serve with no published port, S3 mailbox, two-bucket audit/data split, network secret lane, sibling-worker dispatch, endpoint duality); this is that shape **hardened into a deployment**, not new product code.

## 1. Decisions (locked in brainstorm)

| # | Decision | Choice |
|---|---|---|
| S1 | Host | **WSL2 Ubuntu on the Windows portsandbox box, Docker Engine installed natively inside WSL2** (NOT Docker Desktop — no login-session/update lifecycle in an always-on path; native restart policies; systemd available via `/etc/wsl.conf` `systemd=true`). The WSL2 VM idle-shutdown problem is a first-class runbook item (keep-alive task + boot task), not a footnote. |
| S2 | Reachability | **SSH tunnel only** (matches the existing substrate posture): the laptop's sole channel is the tunneled MinIO mailbox (`ssh -L 9000:localhost:9000` to the Windows host; WSL2 localhost-forwarding bridges Windows→WSL2). Nothing newly exposed. The runbook covers the known WSL2 forwarding flakiness after sleep/resume with two fixes: `networkingMode=mirrored` (`.wslconfig`, Win11) or sshd inside WSL2 as fallback tunnel target. |
| S3 | Stack | **Fresh dedicated stack** at `deploy/serve-stack/` — compose with its own named volumes, `restart: unless-stopped`, tear-downable as a unit. Deployment is a first-class artifact, not an example override (rejected: layering prod duty onto `examples/offload-minio`; rejected: bare systemd units — compose is fewer moving parts). |
| S4 | Worker image | **Pulled from GHCR** (`ghcr.io/quarrysystems/agora-worker:main`, pinned tag) — depends on the user's GHCR-visibility ops fix (in progress); the runbook's update procedure is `docker compose pull && docker compose up -d`. Fallback documented: build-on-host from a clone (the run-2/3 recipe). |
| S5 | Signer | **Persisted keypair, not the example's deterministic dev seed**: generated on first boot into the serve volume; the PUBLIC key exported to a laptop-fetchable file so `agora verify` works remotely (the #55 verify-context shape). Production posture stays KMS (Tier-2, out of scope). |

## 2. Topology

```
LAPTOP                                WINDOWS BOX (portsandbox host)
agora.config.mjs (client kit)         sshd (Windows)  ── localhost fwd ──▶ WSL2 Ubuntu (kept alive)
  submit / watch (live view) ─ SSH -L 9000 ─▶                              Docker Engine
  render / audit / verify                                                   ├─ minio         vols: minio-data
                                                                            ├─ minio-init    (one-shot: agora-audit lock + agora-data)
                                                                            ├─ localstack    (Secrets Manager lane)
                                                                            ├─ serve-data-init (one-shot chown)
                                                                            ├─ serve         vols: serve-data (SQLite + signer key)
                                                                            │   restart: unless-stopped · docker.sock mount · no published port
                                                                            └─ sibling workers (ghcr image, launched per dispatch)
```

The serve container is reachable ONLY through the MinIO mailbox (the offload-minio no-inbound posture, unchanged). The laptop never holds the Anthropic key — it lives in the host's `.env`, staged per-dispatch through the Secrets Manager lane exactly as the example proved (refs-only in the audit).

## 3. `deploy/serve-stack/` contents

| File | What |
|---|---|
| `docker-compose.yml` | The five offload-minio services, hardened: `restart: unless-stopped` on minio/localstack/serve; named volumes `minio-data`, `serve-data`, `localstack-data`; image `ghcr.io/quarrysystems/agora-worker:main` for workers and the serve image built from the repo's existing `examples/offload-minio/Dockerfile.serve` shape (its own pinned build or a published serve image — pinned at plan time from what exists); `env_file: .env`; `group_add: ${DOCKER_GID}`; `extra_hosts: host.docker.internal:host-gateway`. Endpoint duality preserved verbatim (in-container `host.docker.internal:9000`, laptop `localhost:9000`). |
| `agora.config.mjs` | Serve-side operator config, offload-minio shape with the S5 delta: on first boot generate an ed25519 keypair, persist under `/data` (the serve volume), write `public-key.json` to the **data bucket** so the laptop client can fetch it; subsequent boots load the persisted key. Everything else (S3 mailbox/storage/object-lock anchor, AwsSecretStore lane, DispatchExecutor target local-docker, queues incl. `pattern: pipeline` for gated runs) per the example. |
| `client/agora.config.mjs` | The laptop kit: same config shape pointed at `http://localhost:9000` (tunnel), NO key required, `verifySignature` reading the fetched `public-key.json` — enabling `agora orch submit/watch/render/audit` and `agora verify` from the laptop. |
| `client/smoke-plan.json` | One trivial single-dispatch plan — the post-deploy health check (a real worker boots, escapes a patch, the bundle seals). |
| `.env.example` | `ANTHROPIC_API_KEY=`, `DOCKER_GID=` with the stat one-liner comment. |
| `RUNBOOK.md` | The ops half (see §4). |

No product-code changes expected; if plan-time audit finds a genuinely missing seam (e.g. the signer-persistence hook needs a helper), it lands as the smallest additive change with its own tests.

## 4. RUNBOOK.md — the ops half (everything host-side, ordered)

1. **WSL2 prep** (one-time): install Ubuntu; `/etc/wsl.conf` → `[boot] systemd=true`; install Docker Engine inside WSL2 (NOT Desktop); add user to docker group.
2. **Keep-alive** (the WSL2-specific clause): Windows Task Scheduler ON-BOOT task running `wsl.exe -d Ubuntu -- true` + either `.wslconfig` `vmIdleTimeout=-1` (where supported) or a trivial keep-alive session; verification step (`wsl -l -v` shows Running after a fresh boot with no terminal opened).
3. **Networking robustness**: default localhost-forwarding path; if the tunnel breaks after host sleep → `wsl --shutdown` + restart, or adopt `networkingMode=mirrored` (Win11 `.wslconfig`) / sshd-in-WSL2 as the permanent fix. The runbook states how to TEST it (curl MinIO from Windows, then through the laptop tunnel).
4. **First boot**: clone/pull repo in WSL2 → `cp .env.example .env` + key → `export DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)` → `docker compose up -d` → wait healthy → `docker pull ghcr.io/quarrysystems/agora-worker:main`.
5. **Laptop setup**: ssh-config entry with the `LocalForward 9000 localhost:9000` line; fetch `public-key.json`; smoke run: `agora orch submit client/smoke-plan.json` → `agora orch watch <id>` (live view) → `agora verify` the bundle.
6. **Crash-recovery drill** (the claim, demonstrated): submit the smoke plan, `docker kill` the serve container mid-run, `compose up -d`, observe `recoverStranded` complete the run and the bundle seal intact.
7. **Update procedure**: `git pull && docker compose pull && docker compose up -d --build serve` (worker image refresh included); state survives via volumes.
8. **Teardown**: `docker compose down` (volumes preserved) / `down -v` (full reset; the audit bucket's object-locked roots note).
9. **Known warts, stated honestly**: LocalStack free tier loses staged secrets on ITS restart → absorbed by dispatch retry (maxAttempts 2 re-stages); WSL2 clock skew after sleep (affects S3 signing) → `hwclock -s` note; Docker-in-WSL2 disk growth → prune note.

## 5. Acceptance (operational, not unit)

1. Fresh Windows boot, no terminal opened → `serve` is running (keep-alive + restart policies proven).
2. From the laptop through the tunnel: smoke plan submits, the **live run view** tracks it, the bundle verifies (`agora verify`, five rows) with the fetched public key.
3. Crash-recovery drill (§4.6) green: kill mid-run → resumed → sealed intact.
4. Run 4 (the larger gated run) submitted remotely and completed unattended — the actual "runs while you sleep" demonstration. (Run 4 itself is its own plan; this stack is its prerequisite.)

## 6. Out of scope (named triggers)

| Deferred | Trigger |
|---|---|
| Tier-2 AWS (real S3 + Fargate + KMS) | The example's seam-swap table, unchanged — a paying reason |
| Public/cloudflared exposure of the mailbox | A consumer that can't SSH |
| Multi-host / remote-daemon workers | First capacity pull |
| Published serve image on GHCR | Second deployment site |
| Scheduled/cron submission to the always-on serve | First recurring-run need (the cron trigger seam already exists) |
