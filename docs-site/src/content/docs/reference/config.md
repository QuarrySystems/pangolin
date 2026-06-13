---
title: pangolin.config reference
description: How pangolin.config is resolved, what it must export, and a worked pangolin.config.mjs.
sidebar:
  order: 4
---

The `pangolin` CLI and the MCP server resolve a `pangolin.config` file in the
current working directory to obtain the `PangolinClient` they operate on (and, for
the `orch` family, an `OrchContext`). Integrators typically keep one
`pangolin.config.mjs` in their deploy repo.

## Resolution order

On every CLI invocation, the loader looks in the current working directory for,
in this exact order:

1. `pangolin.config.ts`
2. `pangolin.config.js`
3. `pangolin.config.mjs`

The first file that exists is dynamically imported. If none exist, the CLI
errors with `no pangolin.config.{ts,js,mjs} found in <cwd>`.

## What it must export

| Export | Used by | Required |
|---|---|---|
| `default` **or** named `client` | All `PangolinClient`-backed commands (`capabilities`, `subagent`, `env`, `dispatch`, `deploy`) | The client surface. Errors if neither is present. |
| named `orch` | The `pangolin orch` family | Only when running an `orch` verb. Errors lazily (clear message) if an `orch` verb runs without it. |

`default` and `client` are interchangeable for the client — the loader takes
`mod.default ?? mod.client`. The `orch` export is an `OrchContext`:

```typescript
interface OrchContext {
  transport: SubmissionTransport & ControlChannel;
  anchor?: AuditAnchor;
  storage?: { get(ref: string): Promise<Uint8Array> };
  verifySignature?: (root: Uint8Array, sig: Signature) => boolean;
  runService?: (signal: AbortSignal) => Promise<void>;  // pre-wired serve() for `pangolin orch serve`
  scheduleStore?: ScheduleStore;  // config-owned; required for `pangolin orch schedule` verbs
}
```

`runService` is required only for `pangolin orch serve`; the client verbs use
`transport` (plus `anchor`/`storage` for `status`/`watch`/`audit`).

`scheduleStore` is required only for the `pangolin orch schedule add|list|rm` verbs;
omitting it has no effect on any other verb. The default implementation is
`SqliteScheduleStore` from `@quarry-systems/pangolin-orchestrator`, which persists
schedules in a dedicated `schedules` table on the same SQLite database used by
`SqliteRunStateStore`. Pass the same `dbPath` to both so they share one file:

```javascript
import {
  SqliteRunStateStore,
  SqliteScheduleStore,
  serve,
} from '@quarry-systems/pangolin-orchestrator';

const dbPath = join(tmpdir(), 'my-run-state.db');
const store = new SqliteRunStateStore(dbPath);
const scheduleStore = new SqliteScheduleStore(dbPath);

export const orch = {
  transport,
  runService: (signal) => serve({ orchestrator, transport, scheduler, signal }),
  scheduleStore,
};
```

Custom implementations can satisfy the `ScheduleStore` interface directly.

## Worked `pangolin.config.mjs`

This is the config from
[`examples/offload-fanout/`](https://github.com/quarrysystems/pangolin/tree/main/examples/offload-fanout/),
which wires both a `client` and an `orch` context against the local
provider stack. It is import-safe: no throw at load when `ANTHROPIC_API_KEY` is
absent.

```javascript
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PangolinClient, NoopCredentialProvider, StdoutResultSink } from '@quarry-systems/pangolin-client';
import { LocalStorageProvider } from '@quarry-systems/pangolin-storage-local';
import { LocalDockerProvider } from '@quarry-systems/pangolin-providers-local-docker';
import { LocalSecretStore } from '@quarry-systems/pangolin-secret-store';
import {
  PangolinOrchestrator,
  SqliteRunStateStore,
  ManualTrigger,
  DispatchExecutor,
  AuditLog,
  LocalAnchor,
  createLocalSigner,
  verifyEd25519,
  MailboxSubmissionTransport,
  LocalDirMailbox,
  serve,
} from '@quarry-systems/pangolin-orchestrator';

const rootDir = join(tmpdir(), 'pangolin-fanout-storage');
const secretDir = join(tmpdir(), 'pangolin-fanout-secrets');
const mailboxDir = join(tmpdir(), 'pangolin-fanout-mailbox');
const dbPath = join(tmpdir(), `pangolin-fanout-${process.pid}.db`);

const workerImage = 'ghcr.io/quarrysystems/pangolin-worker:latest';

// PangolinClient — lazy: no Docker/network until dispatch fires.
export const client = new PangolinClient({
  namespace: 'offload-fanout',
  compute: { 'local-docker': new LocalDockerProvider({ allowUnpinnedImage: true }) },
  storage: new LocalStorageProvider({ rootDir }),
  secretStores: { local: new LocalSecretStore({ dir: secretDir }) },
  credentials: { none: new NoopCredentialProvider() },
  targets: { local: { compute: 'local-docker', credentials: 'none', secretStore: 'local' } },
  resultSink: new StdoutResultSink(),
});

export default client;

// Audit + orchestrator setup (import-safe: constructors are lazy / in-memory).
const store = new SqliteRunStateStore(dbPath);
process.on('exit', () => { try { store.close(); } catch {} });
const signer = createLocalSigner();
const anchor = new LocalAnchor(store);
const auditLog = new AuditLog({
  store,
  signer,
  anchor,
  // timestamper: new Rfc3161TimestampAuthority({ url: 'https://freetsa.org/tsr' }),  // optional RFC 3161 trusted time
  // A dropped audit append means the sealed record is incomplete — surface it
  // (completeness is a SOC2 / EU AI Act Art 12 control). `auditLog.droppedAppends`
  // holds the running total.
  onDrop: (entry, err) =>
    console.error(`[pangolin] AUDIT DROP kind=${entry.kind} run=${entry.runId}:`, err),
});

const orchestrator = new PangolinOrchestrator({
  store,
  executors: {
    dispatch: new DispatchExecutor({
      client,
      target: 'local',
      workerImage,
      secrets: {
        ANTHROPIC_API_KEY: { inline: process.env.ANTHROPIC_API_KEY ?? '' },
      },
    }),
  },
  triggers: { manual: new ManualTrigger() },
  queues: { default: { concurrency: 2 } },
  auditLog,
});

const verifySignature = (root, sig) => verifyEd25519(root, sig, signer.publicKey);
const transport = new MailboxSubmissionTransport(new LocalDirMailbox(mailboxDir));
const runService = (signal) => serve({ orchestrator, transport, signal });

export const orch = {
  transport,
  storage: client.storage,
  anchor,
  verifySignature,
  runService,
};
```

## Config keys reference

The `PangolinClient` constructor options are documented in full on the
[PangolinClient API](/pangolin/reference/pangolin-client-api/) page — `namespace`,
`compute`, `credentials`, `storage`, `targets`, `secretStores`, `telemetry`,
`resultSink`, `defaultModel`, and `dispatchRetention`. The `targets` map keys
each become a valid `--target` value for `pangolin dispatch run`; each target's
`compute`, `credentials`, and `secretStore` must reference a name present in
the corresponding option map.

## Targeting a self-hosted / S3-compatible store (MinIO, LocalStack)

The S3 seams accept a custom endpoint, so the whole stack can run against MinIO,
LocalStack, or any S3-compatible store — no AWS account required. The worked
example is [`examples/offload-minio/`](https://github.com/quarrysystems/pangolin/tree/main/examples/offload-minio/)
(a serve container + MinIO via docker-compose). The relevant options:

| Option | Where | Purpose |
|---|---|---|
| `endpoint`, `forcePathStyle`, `region` | `new S3StorageProvider({ bucket, endpoint, forcePathStyle: true, region })` | Point content-addressed storage at the custom endpoint (or inject a pre-built `client`). |
| `S3Mailbox` | `new MailboxSubmissionTransport(new S3Mailbox(s3MailboxClient))` | The submission inbox/outbox over S3 (the cross-machine analogue of `LocalDirMailbox`). |
| `AwsSecretStore` + `AWS_ENDPOINT_URL_SECRETS_MANAGER` | `secretStores: { aws: new AwsSecretStore() }` + the endpoint env on serve & workers | Secrets (e.g. the API key) staged into Secrets Manager — LocalStack for self-host, real SM on AWS. Network-reachable, so it crosses the serve→worker boundary; refs-only in the audit. |
| `PANGOLIN_S3_ENDPOINT` (+ `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION`) | **worker container env** | The worker builds its own S3 client at boot to fetch bundles/upload patches; it reads these to reach the same endpoint. |
| `extraEnv` | `new LocalDockerProvider({ extraEnv: { PANGOLIN_S3_ENDPOINT, AWS_*, AWS_ENDPOINT_URL_SECRETS_MANAGER } })` | Delivers the worker-boot env above (S3 bootstrap + the Secrets Manager endpoint) to every launched worker container. |

The S3 endpoint/creds **must** reach the worker as container env (via `extraEnv`),
not via a bundle — the worker needs S3 access *before* it can resolve anything else.
**Secrets** (the API key) go the proper secret lane — staged into a
network-reachable `SecretStore` (Secrets Manager) and resolved by the worker over
the wire, **not** a bundle value. Non-secret config travels as
[env bundles](/pangolin/explanation/how-offload-runs/#running-serve-in-a-container-self-hosted-delivery)
(content-addressed storage, reach workers).

> On **real AWS** none of this is needed: the default S3 endpoint + an IAM task
> role + AWS Secrets Manager all work without custom endpoints or `extraEnv`.
> LocalStack just stands in for Secrets Manager (and the S3 opts for MinIO) when
> self-hosting.
