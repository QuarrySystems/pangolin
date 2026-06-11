# Pangolin Scale Serve-Stack Runbook

Always-on `pangolin orch serve` on the portsandbox host (WSL2 + Docker Engine).
Reference spec: `docs/superpowers/specs/2026-06-07-pangolin-scale-serve-stack-design.md`.

---

## Step 1 — WSL2 prep (one-time, on the Windows portsandbox host)

### 1.1 Install Ubuntu from PowerShell (elevated)

```powershell
wsl --install -d Ubuntu
```

Reboot when prompted.

### 1.2 Enable systemd inside WSL2

Open the Ubuntu terminal and edit (or create) `/etc/wsl.conf`:

```ini
[boot]
systemd=true
```

Shut the distro down so the change takes effect:

```powershell
wsl --shutdown
```

Restart Ubuntu (any `wsl` invocation).

### 1.3 Install Docker Engine inside WSL2 (NOT Docker Desktop)

Inside the Ubuntu terminal, follow the official apt path:

```bash
# Install prerequisites
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg lsb-release

# Add Docker's GPG key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Add the repository
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

### 1.4 Add your user to the docker group

```bash
sudo usermod -aG docker $USER
# Re-open the terminal (or run `newgrp docker`) for the group to take effect
```

Verify:

```bash
docker ps
```

---

## Step 2 — Keep-alive (prevent WSL2 VM idle shutdown)

WSL2 terminates the VM when no Windows process holds a session. This step keeps it alive across reboots without a terminal.

### 2.1 Create a Windows Task Scheduler on-boot task

Open **Task Scheduler** on Windows and create a task with:

- **Trigger:** At startup
- **Action:** Start a program
  - Program: `wsl.exe`
  - Arguments: `-d Ubuntu -- true`
- **Run whether user is logged on or not**

This wakes the distro at boot and keeps the WSL2 VM running. For a persistent keep-alive session (belt-and-suspenders), you can alternatively configure a minimal service inside WSL2 that stays alive (e.g., a trivial `while true; do sleep 60; done` managed via systemd).

### 2.2 Suppress idle timeout (where supported)

In `C:\Users\<you>\.wslconfig` (create if absent):

```ini
[wsl2]
; -1 = never idle-shutdown (supported on WSL2 kernel >= 5.15.90.1 / Win 11 22H2+)
; If your kernel does not honour this flag the Task Scheduler task is sufficient.
vmIdleTimeout=-1
```

Apply:

```powershell
wsl --shutdown
```

### 2.3 Verification: fresh Windows boot, no terminal

1. Reboot Windows.
2. Wait 60 s without opening any WSL terminal.
3. Open **PowerShell** and run:

```powershell
wsl -l -v
```

Expected: `Ubuntu` shows **Running**.

4. Verify Docker is accessible from inside the distro:

```powershell
wsl -d Ubuntu -- docker ps
```

Expected: the table header (or running containers) — no error.

---

## Step 3 — Networking robustness

### 3.1 Default path (WSL2 localhost forwarding)

WSL2 forwards Windows `localhost` to the distro automatically. The laptop SSH tunnel (`LocalForward 9000 localhost:9000`) reaches the Windows host's `localhost:9000`, which WSL2 forwards to `localhost:9000` inside the distro, where MinIO listens.

### 3.2 Test the forwarding chain

**From the Windows box itself** (PowerShell):

```powershell
curl.exe http://localhost:9000/minio/health/live
```

Expected: HTTP 200.

**From the laptop through the tunnel:**

```bash
curl http://localhost:9000/minio/health/live
```

Expected: HTTP 200.

### 3.3 Fix: forwarding broke after host sleep

**Quick fix (one-off):**

```powershell
wsl --shutdown
```

Then wait for the Task Scheduler keep-alive to restart the VM (or open a WSL terminal), and confirm `docker ps` works again.

**Permanent fix — option A (Windows 11 only): mirrored networking**

In `C:\Users\<you>\.wslconfig`:

```ini
[wsl2]
networkingMode=mirrored
```

Apply:

```powershell
wsl --shutdown
```

Mirrored mode makes WSL2 share the Windows network stack, eliminating the forwarding hop entirely.

**Permanent fix — option B: sshd inside WSL2 as the tunnel target**

Install and enable OpenSSH server inside the Ubuntu distro:

```bash
sudo apt-get install -y openssh-server
sudo systemctl enable --now ssh
```

Then point the SSH tunnel at the WSL2 distro's IP directly (look it up via `ip addr` inside WSL2) instead of the Windows host, bypassing localhost forwarding entirely.

---

## Step 4 — First boot (inside WSL2, on the portsandbox host)

### 4.1 Clone the repo

```bash
git clone https://github.com/quarrysystems/pangolin.git
cd pangolin-scale
```

### 4.2 Install dependencies and build

```bash
pnpm install && pnpm -r build
```

### 4.3 Create and fill the local `.env`

```bash
cp deploy/serve-stack/.env.example deploy/serve-stack/.env
```

Open `deploy/serve-stack/.env` and set:

```bash
# Your Anthropic API key — staged per-dispatch via LocalStack Secrets Manager.
# The laptop never holds this value.
ANTHROPIC_API_KEY=sk-ant-...

# GID of /var/run/docker.sock so the non-root serve user can launch workers.
# Run the one-liner below, paste the number here.
DOCKER_GID=<paste output of the command below>
```

One-liner to find `DOCKER_GID`:

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock alpine stat -c '%g' /var/run/docker.sock
```

Paste that number as `DOCKER_GID=` in `deploy/serve-stack/.env`. No export step is needed — compose reads the file directly.

### 4.4 Pull the worker image

The worker image is config-level (`DispatchExecutor.workerImage` in `pangolin.config.mjs`), not a compose service. `docker compose pull` does NOT refresh it. Pull it explicitly:

```bash
docker pull ghcr.io/quarrysystems/pangolin-worker:main
```

### 4.5 Start the stack

```bash
docker compose -f deploy/serve-stack/docker-compose.yml up -d
```

### 4.6 Wait for health

```bash
# Watch all services reach healthy / exited-successfully
docker compose -f deploy/serve-stack/docker-compose.yml ps

# Follow serve logs
docker compose -f deploy/serve-stack/docker-compose.yml logs -f serve
```

Expected: `minio` healthy, `localstack` healthy, `minio-init` exited 0, `serve-data-init` exited 0, `serve` running (no crash loop).

---

## Step 5 — Laptop setup

### 5.1 Clone and build on the laptop

```bash
git clone https://github.com/quarrysystems/pangolin.git
cd pangolin-scale
pnpm install && pnpm -r build
```

**STALE-DIST note:** repeat `pnpm install && pnpm -r build` after every `git pull`. Stale dist files cause spurious missing-export errors — always rebuild before trusting them.

### 5.2 SSH config entry

Add to `~/.ssh/config` on the laptop:

```
Host portsandbox
  HostName <windows-box-ip-or-hostname>
  User <your-username>
  LocalForward 9000 localhost:9000
```

Open the tunnel before any client operation:

```bash
ssh -N portsandbox
```

(or `ssh portsandbox` to get a shell; the `LocalForward` applies either way.)

### 5.3 Fetch the serve public key

The serve container publishes its signing public key to `s3://pangolin-data/public-key.json` on every start. Fetch it to the location the client config reads from:

```bash
AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin \
  aws s3 cp \
    --endpoint-url http://localhost:9000 \
    s3://pangolin-data/public-key.json \
    deploy/serve-stack/client/public-key.json
```

This file is read by `deploy/serve-stack/client/pangolin.config.mjs` via a relative `./public-key.json` URL — it must live next to that config file.

### 5.4 Run the smoke check

The smoke script registers a tiny capability + subagent, submits a single-item run with a fresh timestamp-based id, and prints follow-up commands:

```bash
cd deploy/serve-stack
pnpm smoke
```

Note the run id printed (e.g. `smoke-1749330000000`).

### 5.5 Follow-up: watch the run live

The `pangolin` CLI resolves `pangolin.config.mjs` from the current working directory. For laptop client operations the config is at `deploy/serve-stack/client/pangolin.config.mjs`, so all CLI verbs must be run from `deploy/serve-stack/client/`:

```bash
cd deploy/serve-stack/client
pnpm exec pangolin orch watch <run-id>
```

This shows the live run view (streaming updates while the worker executes).

### 5.6 Audit and verify

```bash
# Still in deploy/serve-stack/client/
pnpm exec pangolin orch audit <run-id> --out bundle.json
pnpm exec pangolin verify bundle.json
```

`pangolin verify` checks the five audit-log rows against the persisted ed25519 signature using the `public-key.json` you fetched in step 5.3.

---

## Step 6 — Crash-recovery drill

This demonstrates the core claim: "runs while you sleep, hands you a sealed ledger."

### 6.1 Submit the smoke run

```bash
cd deploy/serve-stack
pnpm smoke
```

Note the run id.

### 6.2 Kill the serve container mid-run

Find the serve container (name: `pangolin-serve`) and kill it while the worker is running:

```bash
docker kill pangolin-serve
```

### 6.3 Observe auto-restart (this IS the demonstration)

`restart: unless-stopped` in `docker-compose.yml` causes Docker to restart the `serve` container automatically — no manual `docker compose up` is needed. Watch it come back:

```bash
docker compose -f deploy/serve-stack/docker-compose.yml logs -f serve
```

Expected: serve restarts, logs `[serve] starting tick+inbox loop`, then `recoverStranded` runs and requeues the in-flight item.

### 6.4 Verify the completed bundle

```bash
cd deploy/serve-stack/client
pnpm exec pangolin orch watch <run-id>
pnpm exec pangolin orch audit <run-id> --out bundle.json
pnpm exec pangolin verify bundle.json
```

Expected: verification passes; bundle is sealed intact.

### 6.5 Two honest nuances

1. **Orphaned sibling worker.** When the serve container was killed, the worker container it had already launched kept running independently (Docker siblings are not reaped when the launcher exits). The requeued item fires a fresh worker. You may briefly see two workers running; the orphan completes or fails independently and its output is ignored by the resumed item.

2. **Recovery consumes one retry.** With `maxAttempts: 2` (the smoke plan's default), the recovered item's attempt counter has incremented by one. A failure during the post-recovery execution is terminal (no further retries remain).

---

## Step 7 — Update procedure

When a new commit lands, update the host with:

```bash
# Pull latest code
git pull

# Rebuild workspace packages
pnpm install && pnpm -r build

# Pull updated compose images (minio, localstack, mc, busybox)
docker compose -f deploy/serve-stack/docker-compose.yml pull

# Pull the worker image EXPLICITLY — it is config-level, not a compose service.
# `docker compose pull` does NOT refresh it.
docker pull ghcr.io/quarrysystems/pangolin-worker:main

# Rebuild and restart the serve container with the new code
docker compose -f deploy/serve-stack/docker-compose.yml up -d --build serve
```

---

## Step 8 — Teardown

**Stop the stack, keep volumes (restart-safe):**

```bash
docker compose -f deploy/serve-stack/docker-compose.yml down
```

`minio-data` and `serve-data` volumes are preserved. `docker compose up -d` restores full state.

**Full reset (data destroyed):**

```bash
docker compose -f deploy/serve-stack/docker-compose.yml down -v
```

**Note on the audit bucket:** `pangolin-audit` is object-lock enabled (COMPLIANCE mode). Individual locked objects cannot be deleted even with `-v`. A fresh `up -d` creates new bucket names on a new MinIO volume; old locked objects on the destroyed volume are gone with the volume. If you need to delete locked objects in an existing MinIO instance, you must set a retention governance override or wait for the retention period to expire.

---

## Step 9 — Known warts (stated honestly)

| Wart | Behaviour | Workaround |
|---|---|---|
| **LocalStack community: no persistence** | Community LocalStack has no state persistence. A LocalStack restart loses all staged per-dispatch secrets. There is deliberately no `localstack` volume in `docker-compose.yml` — a volume would be misleading. | Staged-secret loss is absorbed ONLY when the loss surfaces at reconcile time: the dispatch retry re-fires with a fresh `dispatchId` and re-stages. If LocalStack is still down when the retry fires (fire-time staging failure), the item fails terminally — `maxAttempts` is bypassed. Acceptable for this tier; not hidden. |
| **WSL2 clock skew after host sleep** | After the Windows host wakes from sleep the WSL2 clock can drift, breaking S3 request signing (MinIO rejects requests with timestamps too far from the server clock). | Inside WSL2: `sudo hwclock -s` (sync from hardware clock). Add it to your wake-up checklist. |
| **Docker-in-WSL2 disk growth** | Docker build cache, dangling images, and stopped containers accumulate on the WSL2 virtual disk. | Periodic pruning: `docker system prune -f` (removes stopped containers, dangling images, unused networks, build cache). Add `docker image prune -f` if you regularly rebuild. |
| **`:main` tag is mutable** | `ghcr.io/quarrysystems/pangolin-worker:main` is a mutable floating tag, not a digest-pinned immutable ref. A re-pull can change the image silently. | True digest pinning (`@sha256:...`) is deferred. Always `docker pull` explicitly before a planned upgrade; never assume the cached layer is current. |

---

## Acceptance checklist (spec §5)

- [ ] Fresh Windows boot, no terminal opened → `serve` is running (`wsl -l -v` shows Ubuntu Running; `docker ps` shows `pangolin-serve` up).
- [ ] From the laptop through the tunnel: smoke plan submits, the live run view (`pangolin orch watch`) tracks it, the bundle verifies (`pangolin verify`, five rows) with the fetched public key.
- [ ] Crash-recovery drill (Step 6) green: kill mid-run → serve auto-restarts → `recoverStranded` completes → bundle seals intact.
- [ ] A larger gated run submitted remotely and completed unattended — the "runs while you sleep" demonstration. (This is the planned Run 4; the stack is its prerequisite.)
