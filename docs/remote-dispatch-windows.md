# Remote dispatch to a Windows laptop (SSH `DOCKER_HOST`)

Run agora dispatches from one machine (the **orchestrator**) while the worker
containers execute on a second machine (the **target**) over its Docker daemon.
This is the "inward dispatch" leg of the substrate topology: laptop orchestrator
reaches a remote Docker daemon to run workers.

> **Why SSH and not a Cloudflare tunnel.** A Docker daemon API is
> root-equivalent — exposing it over a public tunnel is remote code execution
> waiting to happen. Inward dispatch stays on **LAN SSH**; Cloudflare Tunnel /
> portsandbox is reserved for the *outward* direction (exposing an HTTP service
> like Stoa). See the vault decision
> `wikis/_meta/decisions/decision-2026-05-23-substrate-architecture-stoa-v04-agora.md`.

> **Status.** The agora-side seam is verified: `LocalDockerProvider` defaults to
> `new Docker()` (honors `DOCKER_HOST`) and also accepts an injected
> `docker?: Docker` client. The Windows→Windows SSH→Docker hop below is a setup
> to validate with the marked ✅ check commands — it is environment-specific and
> not exercised in CI. Do this **after the `security/env-leak-hardening` PR
> merges**, since the secret-store wiring and green build are part of what you
> dispatch.

---

## A. On the target laptop (runs the workers)

1. **Docker Desktop running**, with the worker image present locally. Get it
   there by any of: build from the repo (`docker build -t
   ghcr.io/quarrysystems/agora-worker:latest -f docker/agora-worker/Dockerfile .`),
   `docker save` on the orchestrator → `docker load` on the target, or pull the
   GHCR digest (needs auth if the package is private).

2. **Enable the OpenSSH Server** (PowerShell, elevated):

   ```powershell
   Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
   Start-Service sshd
   Set-Service sshd -StartupType Automatic
   ```

3. **Set up key auth.** Put the orchestrator's public key on the target.

   > ⚠️ Windows gotcha: for an **admin** user, Windows OpenSSH reads
   > `C:\ProgramData\ssh\administrators_authorized_keys` (with strict ACLs), not
   > `~\.ssh\authorized_keys`. Use a **non-admin** user to avoid that trap.

4. ✅ **Confirm Docker is reachable over SSH** (run from the *orchestrator*):

   ```powershell
   ssh user@target "docker version"
   ```

   If this prints the remote engine, you're good. If `docker` isn't found, its
   PATH isn't visible to the non-interactive SSH shell — fix that first.

## B. On the orchestrator (this machine issues dispatches)

```powershell
$env:DOCKER_HOST = "ssh://user@target"
docker -H ssh://user@target ps   # ✅ should list the TARGET's containers
```

`LocalDockerProvider` reads `DOCKER_HOST` automatically — no code change needed.
To be explicit instead, inject the client in your agora config:

```typescript
import Docker from 'dockerode';
new LocalDockerProvider({ docker: new Docker({ protocol: 'ssh', host: 'target', username: 'user' }) })
```

## C. Smoke test

Run a hello-world-style dispatch, then check `docker ps` **on the target** — you
should see the `agora-worker` container running *there* while the orchestrator's
CPU stays flat. That separation is the whole point.

## D. Fallback if `ssh://` misbehaves (common on Windows)

dockerode's `ssh://` transport runs `docker system dial-stdio` on the remote,
which is finicky against Windows Docker Desktop's named pipe. Secure fallback:

1. In Docker Desktop on the target, expose the daemon on `tcp://localhost:2375`
   (**localhost only — never bind it to the LAN**).
2. From the orchestrator, tunnel it over SSH:

   ```powershell
   ssh -L 2375:localhost:2375 user@target
   # then, in another shell on the orchestrator:
   $env:DOCKER_HOST = "tcp://localhost:2375"
   ```

The daemon port is bound only to the target's localhost; SSH encrypts the hop.
This sidesteps the named-pipe / dial-stdio path entirely.

## E. Storage

- **Smoke-test first with the client and daemon on the same laptop** to prove
  the `DOCKER_HOST` path in isolation.
- For a real cross-machine split, switch to **`S3StorageProvider`**.
  `LocalStorageProvider` bind-mounts host paths that live on the *target*
  machine, so they won't exist on the orchestrator — local FS storage does not
  compose across machines. Memory (if using the Stoa substrate) comes over
  HTTPS, not a bind-mount, so it is unaffected.
