# Writing a provider

Agora is provider-shaped: every backend concern — compute, credentials,
storage, results, channels, notifications — is behind an interface in
`@quarry-systems/agora-core`. You plug in by implementing one of those
interfaces and passing your instance to `new AgoraClient({...})`.

This guide covers the contracts, a working example for each, and the
places people most often get tripped up.

## The seams

| Interface | What it does | Examples shipped |
|---|---|---|
| `ComputeProvider` | Starts a worker container on a backend, waits for it to exit, optionally cancels | `LocalDockerProvider` (dockerode), `FargateProvider` (ECS) |
| `StorageProvider` | Content-addressed blob storage for capability/subagent/env bundles + dispatch records | `LocalStorageProvider` (fs), `S3StorageProvider` |
| `CredentialProvider` | One-shot resolver for the credential material a dispatch needs | `NoopCredentialProvider`, `AwsCredsProvider` |
| `ResultSink` | Where the orchestrator delivers the worker's terminal result | `StdoutResultSink`, callback URL variants |
| `ChannelProvider` | Inbound message stream the worker subscribes to during dispatch | (none in MVP — interface only) |
| `NotificationProvider` | Outbound webhook fire when a dispatch reaches a terminal state | (none in MVP — interface only) |

All live in `packages/agora-core/src/`. Importing from `@quarry-systems/
agora-core` is the only allowed dependency for a third-party provider
package — keeping the dep graph linear (every package's only agora dep is
core).

## ComputeProvider — the most common one to write

The contract (`providers.ts`):

```typescript
interface ComputeProvider {
  readonly name: string;
  run(spec: TaskSpec, ctx: ProviderContext): Promise<TaskHandle>;
  awaitExit(handle: TaskHandle, ctx: ProviderContext): Promise<TaskExit>;
  cancel?(handle: TaskHandle, ctx: ProviderContext): Promise<void>;
}
```

`run` is non-blocking and returns an opaque `TaskHandle`. `awaitExit`
blocks until the container terminates and returns the exit code + captured
stdout/stderr. `cancel` is optional — providers that can't abort
in-flight tasks (some batch queues) just omit it; the runtime treats
cancellation as best-effort.

Walking skeleton for a new compute backend:

```typescript
import type {
  ComputeProvider, TaskSpec, ProviderContext, TaskHandle, TaskExit,
} from '@quarry-systems/agora-core';

export class MyComputeProvider implements ComputeProvider {
  readonly name = 'my-backend';

  constructor(private readonly opts: { /* connection config */ }) {}

  async run(spec: TaskSpec, ctx: ProviderContext): Promise<TaskHandle> {
    // 1. Translate spec.env + spec.secretRefs into your backend's env mechanism.
    //    secretRefs are e.g. "arn:aws:secretsmanager:..." — your provider
    //    is responsible for resolving them against ctx.credentials.
    // 2. Translate spec.resources.cpu / .memory into backend-native sizing.
    // 3. Translate spec.image into a backend-native image ref.
    // 4. Submit the task and capture an id.
    const taskId = await myBackend.submit({ /* ... */ });
    return { providerTaskId: taskId };
  }

  async awaitExit(handle: TaskHandle, ctx: ProviderContext): Promise<TaskExit> {
    // Poll or stream until terminal. Return:
    //   - exitCode: application exit (0 = success)
    //   - providerFailureReason: set ONLY for infrastructural failures
    //     (image pull, quota, scheduling) — not application non-zero exits
    //   - stdout/stderr: captured output (cap at a sane limit per ADR-0014)
    const result = await myBackend.wait(handle.providerTaskId);
    return {
      exitCode: result.exitCode,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(result.infraFailed && { providerFailureReason: result.infraReason }),
    };
  }

  async cancel(handle: TaskHandle): Promise<void> {
    await myBackend.cancel(handle.providerTaskId);
  }
}
```

Wire it into `AgoraClient`:

```typescript
const client = new AgoraClient({
  namespace: 'my-deploy',
  compute: { 'my-backend': new MyComputeProvider({ /* ... */ }) },
  credentials: { /* ... */ },
  storage: /* ... */,
  targets: { prod: { compute: 'my-backend', credentials: 'aws' } },
  resultSink: /* ... */,
});
```

The `targets` map is how dispatch routing happens: `dispatch.run({target:
'prod', ...})` selects the `prod` target, which selects the `my-backend`
compute provider.

**Common stumbles:**

- **Application failures vs infrastructural failures.** A non-zero exit
  from the worker is application failure — set `exitCode`, leave
  `providerFailureReason` undefined. The worker container can't start
  (bad image, scheduling failure)? That's infrastructural — set
  `providerFailureReason`. The orchestrator routes these differently.
- **Image pinning.** `LocalDockerProvider` accepts `allowUnpinnedImage:
  true` for dev; production providers should reject anything that isn't
  digest-pinned (`@sha256:...`). The Fargate provider already does.
- **stdout/stderr capping.** ADR-0014 caps stdout at 10 MiB. Your provider
  should truncate (with a clear marker) rather than blow up on large
  outputs.

## StorageProvider — the second most common

`StorageProvider` is the registry's backing store. It moves bundle bytes
in and out, and answers "what's the latest registered hash for this
logical name?" queries.

```typescript
interface StorageProvider {
  readonly name: string;
  put(uri: string, contents: Uint8Array): Promise<{ contentHash: string }>;
  get(uri: string): Promise<Uint8Array>;
  resolveLatest(uri: string): Promise<{ uri; contentHash; registeredAt } | null>;
  list(uri: string): Promise<Array<{ uri; contentHash; registeredAt }>>;
  resolveByHash(query: { namespace; type; contentHash }):
    Promise<{ uri; name; contentHash; registeredAt } | null>;
}
```

URIs are agora-shaped strings — `agora://<namespace>/<type>/<name>/
<contentHash>` for blob slots, `agora://<namespace>/<type>/<name>` for the
resolve/list queries. The storage layer interprets them as a path.

The provider picks the hash algorithm. `LocalStorageProvider` and
`S3StorageProvider` both use sha256.

**Common stumbles:**

- **`resolveByHash` is load-bearing for the dispatch path.** Subagents
  store bound capabilities as hashes (for reproducibility); the worker
  uses `resolveByHash` to round-trip them back to fetchable URIs. An
  O(N) walk is acceptable for MVP scale.
- **`listNames(prefix)` is NOT in the interface yet.** The CLI's
  `capabilities list` etc. throw `NOT_IMPLEMENTED` because the catalog
  layer can't enumerate. Future addition.
- **Local-vs-remote scope.** `LocalStorageProvider` bind-mounts host
  paths into the worker container — works for one-host deployments, breaks
  the moment compute is on a different machine. For cross-machine, use
  `S3StorageProvider` (or implement against your blob store of choice).

## CredentialProvider, ResultSink — small, often default

`CredentialProvider`:

```typescript
interface CredentialProvider {
  readonly name: string;
  resolve(): Promise<ResolvedCredentials>;  // { kind: string, [...]: unknown }
}
```

The `kind` discriminator names the credential family — `'aws-sts'`,
`'static-bearer'`, etc. The compute provider knows what to do with each
kind it accepts. For local-Docker dev that needs no credentials, use
`NoopCredentialProvider`.

`ResultSink`:

```typescript
interface ResultSink {
  collect(result: DispatchResult): Promise<void>;
}
```

Called when a dispatch reaches a terminal lifecycle event. The shipped
`StdoutResultSink` just prints — implement your own to push to a queue,
write to a database, or PR-comment.

## Where to put the package

Conventions used by the shipped providers:

- One npm package per provider, under `@quarry-systems/agora-<role>-<name>`
  (e.g. `agora-providers-fargate`, `agora-storage-s3`).
- Single class export named after the provider (`FargateProvider`,
  `S3StorageProvider`).
- README.md cross-linking the MVP spec section that owns the contract.
- The only `agora-*` dep is `@quarry-systems/agora-core` (types only).
  No depending on other agora packages.

This keeps the dep graph linear — `agora-client` and `agora-worker`
depend on `agora-core` and on whichever providers the integrator chooses,
not on a fixed set.

## Testing your provider

The shipped providers each have a unit test suite and an integration
suite. For ComputeProviders the integration test is the canonical
"register → dispatch → assert exit 0" flow. `examples/hello-world/` is the
template — copy it, swap your provider in, and the rest of the
integration code is identical (that's the whole point of the seam).

## See also

- MVP spec §5 (provider contracts), §5.1-§5.7 for per-interface details.
- ADR-0014 (stdout cap), ADR-0015 (capability size cap) — sizing limits
  your provider must respect.
- ADR-0011 — no entrypoint override at dispatch (the runtime spawns the
  adapter, not user-supplied commands).
