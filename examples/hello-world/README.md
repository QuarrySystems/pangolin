# hello-world example

The §4.4 worked Hello World. End-to-end runnable demonstration of agora's
caller-side SDK against the local-only provider stack:

- `AgoraClient` (the SDK entry point)
- `LocalDockerProvider` (compute)
- `LocalStorageProvider` (artifact storage)
- `NoopCredentialProvider` (no AWS dependency)
- `StdoutResultSink` (result collection straight from container logs)

This example is the integrator on-ramp. Per the spec §9 integrator
experience pillar, a developer with Docker installed should be able to
clone the repo, install dependencies, and see the resolved dispatch
output in under **30 minutes**. If you spent longer than that getting
this to run, the failure is ours — please file an issue and tell us
where you stalled.

## What it does

1. Constructs an `AgoraClient` against the local provider stack.
2. Registers:
   - a capability (`echo-cap`) with a single `agora-setup.sh` that
     prints a greeting,
   - a subagent (`echo`) bound to that capability,
   - an env bundle (`minimal`) with a `LOG_LEVEL` value.
3. Dispatches the subagent against the `local` target.
4. Prints the **resolved bundle refs** (the `agora://` URIs and content
   hashes the worker resolved) and the **captured stdout** from the
   container.
5. Cleans up the mkdtemp'd storage root so re-runs don't leak temp
   directories.

## Prerequisites

- Node.js 20+ and pnpm 9
- Docker Desktop (or equivalent) running locally
- A locally-built `ghcr.io/quarrysystems/agora-worker:latest` image
  available to your Docker daemon
- **An `ANTHROPIC_API_KEY`** available to the dispatch. The stock worker
  image runs the `claude-code` runtime adapter, which spawns the `claude`
  binary. Without a key the adapter exits non-zero and the dispatch is
  reported as **`provider-failed`** (see "What you'll see" below). This is
  expected v0.1 behavior — the adapter, not agora's machinery, is what
  needs the credential. A credential-free `noop` runtime adapter for a
  zero-setup on-ramp is tracked as a follow-up.

The example sets `allowUnpinnedImage: true` on `LocalDockerProvider` so
the `:latest` tag works for local iteration. Production dispatches must
always use a digest-pinned image per §7.4 — see the Fargate variant
below.

## Build the worker image

Until the `agora-worker-image.yml` GitHub workflow has published a
versioned image you can pin against, build it locally from the repo
root:

```sh
docker build \
  -t ghcr.io/quarrysystems/agora-worker:latest \
  -f docker/agora-worker/Dockerfile \
  .
```

Multi-stage build details and the runtime contract live in
[`docker/agora-worker/Dockerfile`](../../docker/agora-worker/Dockerfile).

## Run it

```sh
# from the repo root
pnpm install
pnpm -F hello-world-example build
pnpm -F hello-world-example start
```

### What you'll see

First, the `resolved` block — the bound artifact refs, the audit trail
proving exactly which bytes ran:

```text
=== resolved ===
{
  "subagent":     { "name": "echo",      "contentHash": "sha256:...", "registeredAt": "..." },
  "capabilities": [{ "name": "echo-cap", "contentHash": "sha256:...", "registeredAt": "..." }],
  "env":          [{ "name": "minimal",  "contentHash": "sha256:...", "registeredAt": "..." }]
}
```

Then `stdout`. Note: this is the worker's **structured-log stream** (one
JSON object per line), *not* a bare line of text. The `agora-setup.sh`
greeting is carried inside the `setup-script.ran` event's `stdout` field:

```text
=== stdout ===
{"kind":"worker.boot","dispatchId":"..."}
{"kind":"setup-script.ran","exitCode":0,"stdout":"hello from agora-worker\n","stderr":""}
{"kind":"dispatch.finished","dispatchId":"...","exitCode":0}
```

Finally, the dispatch **outcome**:

- **With** an `ANTHROPIC_API_KEY`, the `claude-code` adapter exits 0 and you
  see `=== dispatch OK ===` (exit code 0).
- **Without** a key, the adapter exits non-zero — the `setup-script.ran`
  line above still shows the greeting (the setup step ran fine), but the
  terminal event is `dispatch.failed` / `provider-failed`, and the example
  prints `=== dispatch FAILED ===` and exits non-zero:

  ```text
  === dispatch FAILED ===
  exitCode: 1
  reason:   provider-failed
  detail:   runtime exited with code 1
  ```

The `resolved` block is the same shape your production callers will see
— it's the contract every `ResultSink.collect()` honors regardless of
which compute / storage backend is wired in.

## Fargate + S3 production variant

The substitution is **constructor-only**. Every other line of
`src/index.ts` is identical between the local example and the production
deployment. Swap the three highlighted providers:

```typescript
import { AgoraClient, StdoutResultSink } from '@quarry-systems/agora-client';
import { S3StorageProvider } from '@quarry-systems/agora-storage-s3';
import { FargateProvider } from '@quarry-systems/agora-providers-fargate';
import { AwsCredsProvider } from '@quarry-systems/agora-providers-aws-creds';

const client = new AgoraClient({
  namespace: 'hello-world',
  compute: {
    fargate: new FargateProvider({
      cluster: 'arn:aws:ecs:us-east-1:123456789012:cluster/agora',
      taskDefinition: 'agora-worker:42',
      subnets: ['subnet-abc', 'subnet-def'],
      securityGroups: ['sg-xyz'],
    }),
  },
  credentials: {
    aws: new AwsCredsProvider({ region: 'us-east-1' }),
  },
  storage: new S3StorageProvider({
    bucket: 'my-org-agora-artifacts',
    region: 'us-east-1',
  }),
  targets: { prod: { compute: 'fargate', credentials: 'aws' } },
  resultSink: new StdoutResultSink(),
});

const result = await client.dispatch({
  subagent: 'echo',
  env: 'minimal',
  target: 'prod',
  // PINNED digest — Fargate provider rejects unpinned images per §7.4.
  workerImage:
    'public.ecr.aws/quarry-systems/agora-worker@sha256:0123456789abcdef...',
});
```

Notice what did NOT change:

- The capability / subagent / env-bundle registration calls.
- The `client.dispatch(...)` shape.
- The result-handling block (`result.resolved`, `result.stdout`).

That invariance is the whole point — the **registry shape and dispatch
contract are the same across environments**. Local-first development,
production-grade deployment, one code path.

## What's next

- `examples/cancel/` — `client.dispatch.cancel(id)` mid-flight.
- `examples/callback/` — async result delivery via callback URL + HMAC.
- `examples/multi-target/` — multiple compute backends in one client.

(Coming as part of the §4 worked-examples DAG.)
