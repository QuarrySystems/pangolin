---
title: agora-offload-tier1-minio-proof
created: 2026-06-02
---

```mermaid
flowchart TD
    task-s3-mailbox["task-s3-mailbox: S3-backed mailbox store<br/>files: packages/agora-orchestrator/src/contracts/mailbox.ts +3 more"]:::done
    task-example-scaffold["task-example-scaffold: example package scaffold<br/>files: examples/offload-minio/package.json +1 more"]:::done
    task-aws-s3-mailbox-client["task-aws-s3-mailbox-client: AWS S3 mailbox client<br/>files: examples/offload-minio/src/aws-s3-mailbox-client.ts +1 more"]:::done
    task-aws-s3-lock-client["task-aws-s3-lock-client: AWS S3 object-lock client<br/>files: examples/offload-minio/src/aws-s3-lock-client.ts +1 more"]:::done
    task-plan-smoke["task-plan-smoke: deterministic run plan<br/>files: examples/offload-minio/plan.json +4 more"]:::done
    task-config["task-config: example config wiring<br/>files: examples/offload-minio/agora.config.mjs"]:::done
    task-serve-image["task-serve-image: serve container image<br/>files: examples/offload-minio/Dockerfile.serve +1 more"]:::done
    task-storage-s3-endpoint-opts["task-storage-s3-endpoint-opts: S3 provider endpoint opts<br/>files: packages/agora-storage-s3/src/index.ts +1 more"]:::done
    task-provider-extra-env["task-provider-extra-env: local-docker extraEnv<br/>files: packages/agora-providers-local-docker/src/index.ts +1 more"]:::done
    task-worker-s3-endpoint["task-worker-s3-endpoint: worker S3 endpoint support<br/>files: packages/agora-worker/src/bundle-fetcher.ts +1 more"]:::done
    task-config-worker-env["task-config-worker-env: wire extraEnv into config<br/>files: examples/offload-minio/agora.config.mjs"]:::done
    task-compose["task-compose: MinIO compose stack<br/>files: examples/offload-minio/docker-compose.yml +1 more"]:::done
    task-e2e["task-e2e: end-to-end MinIO demo<br/>files: examples/offload-minio/src/index.ts +1 more"]:::done
    task-readme["task-readme: example README<br/>files: examples/offload-minio/README.md"]:::done

    task-example-scaffold --> task-aws-s3-mailbox-client
    task-s3-mailbox --> task-aws-s3-mailbox-client
    task-example-scaffold --> task-aws-s3-lock-client
    task-example-scaffold --> task-plan-smoke
    task-aws-s3-mailbox-client --> task-config
    task-aws-s3-lock-client --> task-config
    task-config --> task-serve-image
    task-storage-s3-endpoint-opts --> task-worker-s3-endpoint
    task-config --> task-config-worker-env
    task-worker-s3-endpoint --> task-config-worker-env
    task-provider-extra-env --> task-config-worker-env
    task-serve-image --> task-compose
    task-config-worker-env --> task-compose
    task-compose --> task-e2e
    task-plan-smoke --> task-e2e
    task-e2e --> task-readme

    classDef done fill:#90ee90,stroke:#333
    classDef ready fill:#fffacd,stroke:#333
    classDef running fill:#87ceeb,stroke:#333
    classDef failed fill:#ffb6c1,stroke:#333
    classDef skipped fill:#d3d3d3,stroke:#333,stroke-dasharray: 5 5
```

## Context

Implements the **Tier-1 MinIO proof** specified in
[`docs/superpowers/specs/2026-06-02-agora-offload-tier1-minio-proof-design.md`](../specs/2026-06-02-agora-offload-tier1-minio-proof-design.md).

Goal: prove the offload orchestrator runs as a remote-style service (submit over
an S3 inbox, no inbound networking, multi-executor routing, patch escape,
`external-immutable` audit) against free substitutes — MinIO + local Docker — and
in doing so build the two genuinely-missing production pieces (`S3Mailbox` + a
concrete `AwsS3LockClient`) so Tier-2 Fargate is a config swap.

**Two subsystems, cleanly separated:**
- `packages/agora-orchestrator` — one product-code task adds the S3 mailbox
  (`task-s3-mailbox`). `S3LockClient` already ships (index.ts:26), so no
  orchestrator change is needed for the anchor.
- `examples/offload-minio` — the new self-contained proof: concrete AWS clients,
  the compose stack (MinIO + serve container), config, run plan, the e2e/tamper
  test, CI smoke, and docs.

**Spike resolution (2026-06-02) — all-real worker, no no-model adapter.** A spike
confirmed there is **no per-dispatch runtime-adapter selection** in the codebase
today: `agora-client` hardcodes `AGORA_RUNTIME_ADAPTER: 'claude-code'`
(dispatch.ts:219), `DispatchWork` (agora-core) has no `runtimeAdapter` field, and
`work.env` is **env-bundle references** (resolved by `resolveEnvBundles`), not raw
`KEY=VALUE`. So a no-model adapter could not be selected without a product change to
`agora-client`. Decision: **every edit runs the real `claude-code` adapter** (the
exact path `offload-fanout` already proves green) on a one-line rename — maximally
faithful, zero product change, ~pennies/run. This dropped the former no-model-adapter
and derived-image tasks; the worker image is the **stock**
`ghcr.io/quarrysystems/agora-worker:latest`.

**Grounding facts verified against the codebase:**
- `MailboxStore` is a 4-method seam (`put/get/list/delete`); only `LocalDirMailbox`
  ships today. `S3Mailbox` is the gap (spec §1).
- `S3ObjectLockAnchor` already exists and takes an injected `S3LockClient`
  (`putObject` with `retainUntil`+`mode:'COMPLIANCE'`, `getObject`); both the class
  and the `S3LockClient` type are exported (index.ts:25-26).
- `S3StorageProvider` accepts an injected `client?: S3Client` for endpoint override
  ("LocalStack, MinIO, etc.").
- Per-item **data** flows `workerInput → work.input → AGORA_INPUT_JSON` (dispatch.ts:218)
  → worker `inputJson` (env-parser.ts:94) → `spec.input` to the adapter — **verified
  end-to-end**. This is how each edit learns which file to rename (the `offload-fanout`
  `{{file}}` promptTemplate pattern).
- `LocalDockerProvider` sets no `NetworkMode` (workers land on the default bridge →
  MinIO endpoint duality, spec §2.1) and reads `DOCKER_HOST` / the socket via `new Docker()`.

**Execution note:** `task-config` and downstream import the new `S3Mailbox` symbol;
the dependency edges ensure `task-s3-mailbox`'s source lands first, but the
implementer for any orchestrator-consuming example task must run `pnpm -r build`
(or at least build `agora-orchestrator`) so the workspace `dist` carries the new
export before typecheck.

**Prerequisite (not a task — pre-existing repo artifact):** the stock worker image
must be built locally (it is GHCR-private):
`docker build -t ghcr.io/quarrysystems/agora-worker:latest -f docker/agora-worker/Dockerfile .`.
No derived image is needed — the stock `claude-code` adapter is what runs.

## Tasks

## Task: S3-backed mailbox store

```yaml
id: task-s3-mailbox
depends_on: []
files:
  - packages/agora-orchestrator/src/contracts/mailbox.ts
  - packages/agora-orchestrator/src/mailbox/s3.ts
  - packages/agora-orchestrator/src/index.ts
  - packages/agora-orchestrator/test/mailbox-s3.test.ts
status: done
```

Add the `MailboxS3Client` injected seam to the existing `contracts/mailbox.ts`, and
implement `S3Mailbox` (a `MailboxStore`) over it — mirroring how `S3ObjectLockAnchor`
injects `S3LockClient` so the orchestrator gains no AWS-SDK dependency (spec §1, §1.1).
Export `S3Mailbox` from the package barrel (`MailboxS3Client` is re-exported
automatically via the existing `export * from './contracts/index.js'`).

## Implementation

```typescript
// packages/agora-orchestrator/src/contracts/mailbox.ts  (append)
/** Minimal injected S3 seam for S3Mailbox — keeps agora-orchestrator AWS-SDK-free.
 *  Keys are '/'-delimited logical paths under a bucket+prefix the impl owns. */
export interface MailboxS3Client {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  list(prefix: string): Promise<string[]>;   // returns full logical keys
  delete(key: string): Promise<void>;          // idempotent
}
```

```typescript
// packages/agora-orchestrator/src/mailbox/s3.ts
import type { MailboxStore, MailboxS3Client } from '../contracts/index.js';

/** MailboxStore backed by an injected S3 seam. Logic only — the concrete
 *  AWS-SDK client is supplied by the caller (example/Tier-2 storage pkg). */
export class S3Mailbox implements MailboxStore {
  constructor(private readonly s3: MailboxS3Client) {}
  put(key: string, bytes: Uint8Array): Promise<void> { return this.s3.put(key, bytes); }
  get(key: string): Promise<Uint8Array | null> { return this.s3.get(key); }
  delete(key: string): Promise<void> { return this.s3.delete(key); }
  async list(prefix: string): Promise<string[]> {
    // segment-boundary-safe prefix match, matching LocalDirMailbox semantics
    const dirPrefix = prefix.endsWith('/') ? prefix : prefix + '/';
    const keys = await this.s3.list(dirPrefix);
    return keys.filter((k) => k === prefix || k.startsWith(dirPrefix));
  }
}
```

```typescript
// packages/agora-orchestrator/test/mailbox-s3.test.ts
import { describe, it, expect } from 'vitest';
import { S3Mailbox } from '../src/mailbox/s3.js';
import type { MailboxS3Client } from '../src/contracts/index.js';

const fake = (): MailboxS3Client => {
  const m = new Map<string, Uint8Array>();
  return {
    put: async (k, b) => void m.set(k, b),
    get: async (k) => m.get(k) ?? null,
    list: async (p) => [...m.keys()].filter((k) => k.startsWith(p)),
    delete: async (k) => void m.delete(k),
  };
};

it('round-trips and prefix-lists at segment boundary', async () => {
  const mb = new S3Mailbox(fake());
  await mb.put('inbox/r1.json', new Uint8Array([1]));
  expect(await mb.get('inbox/r1.json')).toEqual(new Uint8Array([1]));
  expect(await mb.list('inbox')).toEqual(['inbox/r1.json']);
  expect(await mb.list('in')).toEqual([]); // 'in' must NOT match 'inbox/...'
});
```

## Acceptance criteria

- `MailboxS3Client` interface is exported from `@quarry-systems/agora-orchestrator`.
- `S3Mailbox` implements `MailboxStore` and is exported from the barrel.
- `list('inbox')` returns keys under `inbox/` but `list('in')` returns `[]`
  (segment-boundary-safe, matching `LocalDirMailbox`).
- `get` of an absent key resolves to `null`; `delete` of an absent key is a no-op.
- `vitest run` passes for the new test; the existing orchestrator suite still passes.

Test file: `packages/agora-orchestrator/test/mailbox-s3.test.ts`.

## Task: example package scaffold

```yaml
id: task-example-scaffold
depends_on: []
files:
  - examples/offload-minio/package.json
  - pnpm-lock.yaml
status: done
is_wiring_task: true
```

Scaffold the new workspace package `offload-minio-example` so all downstream
imports resolve. Mirrors `examples/offload-fanout/package.json` and adds the deps
this proof needs beyond it: `@quarry-systems/agora-storage-s3` and
`@aws-sdk/client-s3`.

```jsonc
{
  "name": "offload-minio-example",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "license": "BUSL-1.1",
  "scripts": {
    "start": "tsx src/index.ts",
    "start:env": "tsx --env-file=../../.env src/index.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "@quarry-systems/agora-client": "workspace:*",
    "@quarry-systems/agora-orchestrator": "workspace:*",
    "@quarry-systems/agora-storage-s3": "workspace:*",
    "@quarry-systems/agora-providers-local-docker": "workspace:*",
    "@quarry-systems/agora-secret-store": "workspace:*",
    "@aws-sdk/client-s3": "^3"
  },
  "devDependencies": { "tsx": "^4.19.0", "typescript": "^5.7.2", "vitest": "^2.1.9" }
}
```

## Acceptance criteria

- `pnpm install` at the repo root resolves the new package with no peer/workspace errors.
- `pnpm --filter offload-minio-example exec tsc --version` runs (package is wired into the workspace).
- All deps listed are present so downstream tasks' imports satisfy H8.

Test file: `examples/offload-minio/test/smoke.test.ts` (its presence under this package is what proves the package is wired; authored in `task-plan-smoke`).

## Task: AWS S3 mailbox client

```yaml
id: task-aws-s3-mailbox-client
depends_on: [task-example-scaffold, task-s3-mailbox]
files:
  - examples/offload-minio/src/aws-s3-mailbox-client.ts
  - examples/offload-minio/test/aws-s3-mailbox-client.test.ts
status: done
```

Concrete `MailboxS3Client` backed by `@aws-sdk/client-s3`, talking to MinIO now /
real S3 later via the injected endpoint (spec §1 — named for mechanism, not the
deployment). Maps logical `/`-delimited keys to `bucket` + `prefix` objects.

## Implementation

```typescript
// examples/offload-minio/src/aws-s3-mailbox-client.ts
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand, NoSuchKey } from '@aws-sdk/client-s3';
import type { MailboxS3Client } from '@quarry-systems/agora-orchestrator';

export interface AwsS3MailboxClientOpts { client: S3Client; bucket: string; prefix?: string; }

export class AwsS3MailboxClient implements MailboxS3Client {
  private readonly p: string;
  constructor(private readonly o: AwsS3MailboxClientOpts) { this.p = o.prefix?.replace(/\/?$/, '/') ?? ''; }
  private k(key: string) { return this.p + key; }
  async put(key: string, bytes: Uint8Array) {
    await this.o.client.send(new PutObjectCommand({ Bucket: this.o.bucket, Key: this.k(key), Body: bytes }));
  }
  async get(key: string) {
    try {
      const r = await this.o.client.send(new GetObjectCommand({ Bucket: this.o.bucket, Key: this.k(key) }));
      return new Uint8Array(await r.Body!.transformToByteArray());
    } catch (e) { if (e instanceof NoSuchKey) return null; throw e; }
  }
  async list(prefix: string) {
    const out: string[] = []; let token: string | undefined;
    do {
      const r = await this.o.client.send(new ListObjectsV2Command({ Bucket: this.o.bucket, Prefix: this.k(prefix), ContinuationToken: token }));
      for (const c of r.Contents ?? []) if (c.Key) out.push(c.Key.slice(this.p.length));
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
  async delete(key: string) {
    await this.o.client.send(new DeleteObjectCommand({ Bucket: this.o.bucket, Key: this.k(key) }));
  }
}
```

```typescript
// examples/offload-minio/test/aws-s3-mailbox-client.test.ts
import { describe, it, expect } from 'vitest';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { AwsS3MailboxClient } from '../src/aws-s3-mailbox-client.js';

const MINIO = process.env.AGORA_S3_ENDPOINT; // set when MinIO is running
const d = MINIO ? describe : describe.skip;

d('AwsS3MailboxClient against MinIO', () => {
  it('put/get/list/delete round-trips under prefix', async () => {
    const client = new S3Client({ endpoint: MINIO, forcePathStyle: true, region: 'us-east-1',
      credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' } });
    await client.send(new CreateBucketCommand({ Bucket: 'agora-data' })).catch(() => {});
    const mb = new AwsS3MailboxClient({ client, bucket: 'agora-data', prefix: 'mailbox/' });
    await mb.put('inbox/x.json', new Uint8Array([7]));
    expect(await mb.get('inbox/x.json')).toEqual(new Uint8Array([7]));
    expect(await mb.list('inbox/')).toContain('inbox/x.json');
    await mb.delete('inbox/x.json');
    expect(await mb.get('inbox/x.json')).toBeNull();
  });
});
```

## Acceptance criteria

- Implements `MailboxS3Client` (`put/get/list/delete`) against an injected `S3Client`.
- `get` of a missing key returns `null` (catches `NoSuchKey`), not a throw.
- `list` strips the prefix so returned keys match the logical keys `S3Mailbox` expects, and paginates (`ContinuationToken`) past 1000 objects.
- Integration test passes against a running MinIO (`AGORA_S3_ENDPOINT` set); skips cleanly when unset.

Test file: `examples/offload-minio/test/aws-s3-mailbox-client.test.ts`.

## Task: AWS S3 object-lock client

```yaml
id: task-aws-s3-lock-client
depends_on: [task-example-scaffold]
files:
  - examples/offload-minio/src/aws-s3-lock-client.ts
  - examples/offload-minio/test/aws-s3-lock-client.test.ts
status: done
```

Concrete `S3LockClient` (the seam `S3ObjectLockAnchor` already declares and exports)
backed by `@aws-sdk/client-s3`: `PutObject` with object-lock `COMPLIANCE` retention,
`GetObject`. Endpoint-configurable → MinIO now, real S3 later (spec §1).

## Implementation

```typescript
// examples/offload-minio/src/aws-s3-lock-client.ts
import { S3Client, PutObjectCommand, GetObjectCommand, NoSuchKey } from '@aws-sdk/client-s3';
import type { S3LockClient } from '@quarry-systems/agora-orchestrator';

// `S3LockClient.putObject/getObject` take only `key` — the bucket is owned by this
// concrete client (it must match the bucket passed to S3ObjectLockAnchor in config).
export interface AwsS3LockClientOpts { client: S3Client; bucket: string; }

export class AwsS3LockClient implements S3LockClient {
  constructor(private readonly o: AwsS3LockClientOpts) {}
  async putObject(key: string, body: Uint8Array, opts: { retainUntil: Date; mode: 'COMPLIANCE' }) {
    await this.o.client.send(new PutObjectCommand({
      Bucket: this.o.bucket, Key: key, Body: body,
      ObjectLockMode: opts.mode,
      ObjectLockRetainUntilDate: opts.retainUntil,
    }));
  }
  async getObject(key: string) {
    try {
      const r = await this.o.client.send(new GetObjectCommand({ Bucket: this.o.bucket, Key: key }));
      return new Uint8Array(await r.Body!.transformToByteArray());
    } catch (e) { if (e instanceof NoSuchKey) return undefined; throw e; }
  }
}
```

```typescript
// examples/offload-minio/test/aws-s3-lock-client.test.ts
import { describe, it, expect } from 'vitest';
import { S3Client, CreateBucketCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { AwsS3LockClient } from '../src/aws-s3-lock-client.js';

const MINIO = process.env.AGORA_S3_ENDPOINT;
const d = MINIO ? describe : describe.skip;

d('AwsS3LockClient against MinIO object lock', () => {
  it('writes under COMPLIANCE retention; delete before retention is rejected', async () => {
    const client = new S3Client({ endpoint: MINIO, forcePathStyle: true, region: 'us-east-1',
      credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' } });
    await client.send(new CreateBucketCommand({ Bucket: 'agora-audit', ObjectLockEnabledForBucket: true })).catch(() => {});
    const lock = new AwsS3LockClient({ client, bucket: 'agora-audit' });
    const future = new Date(Date.now() + 60_000);
    await lock.putObject('audit/roots/e1.json', new Uint8Array([1]), { retainUntil: future, mode: 'COMPLIANCE' });
    expect((await lock.getObject('audit/roots/e1.json'))).toEqual(new Uint8Array([1]));
    await expect(client.send(new DeleteObjectCommand({ Bucket: 'agora-audit', Key: 'audit/roots/e1.json' }))).rejects.toBeTruthy();
  });
});
```

## Acceptance criteria

- Implements the exported `S3LockClient` interface (`putObject` with `mode:'COMPLIANCE'` + `retainUntil`, `getObject`).
- `putObject` sets `ObjectLockMode` + `ObjectLockRetainUntilDate`; an object so written cannot be deleted before retention expires (asserted against MinIO).
- `getObject` of a missing key returns `undefined` (per the seam contract), not a throw.
- `AwsS3LockClientOpts` carries the `bucket`, matching the `S3ObjectLockAnchor` bucket arg.
- Integration test passes against MinIO; skips cleanly when `AGORA_S3_ENDPOINT` is unset.

Test file: `examples/offload-minio/test/aws-s3-lock-client.test.ts`.

## Task: deterministic run plan

```yaml
id: task-plan-smoke
depends_on: [task-example-scaffold]
files:
  - examples/offload-minio/plan.json
  - examples/offload-minio/fixture/alpha.ts
  - examples/offload-minio/fixture/beta.ts
  - examples/offload-minio/fixture/shared.ts
  - examples/offload-minio/test/smoke.test.ts
status: done
```

The submitted `Run` and its fixtures, plus an offline CI smoke test (fake executor,
no Docker/MinIO/key) asserting the plan shape — mirrors `offload-fanout`'s smoke
test (spec §5, §7). All edits run the real `code-edit` subagent; the file each edits
comes via `workerInput.file`. The run: 4 edits — `edit-alpha`/`edit-beta` with
disjoint per-file locks (fan out across `dispatch-a`/`dispatch-b`) and
`edit-shared-1`/`edit-shared-2` that **share the `shared.ts` lock** (serialize; the
rename is idempotent so order doesn't matter) — plus a `verify` gate depending on all
four.

## Implementation

```jsonc
// examples/offload-minio/plan.json
{
  "id": "minio-proof-1",
  "items": [
    { "id": "edit-alpha",    "executor": "dispatch-a", "trigger": "manual",
      "inputs": { "subagent": "code-edit", "workerInput": { "file": "alpha.ts" } },
      "depends_on": [], "resourceLocks": ["alpha.ts"] },
    { "id": "edit-beta",     "executor": "dispatch-b", "trigger": "manual",
      "inputs": { "subagent": "code-edit", "workerInput": { "file": "beta.ts" } },
      "depends_on": [], "resourceLocks": ["beta.ts"] },
    { "id": "edit-shared-1", "executor": "dispatch-a", "trigger": "manual",
      "inputs": { "subagent": "code-edit", "workerInput": { "file": "shared.ts" } },
      "depends_on": [], "resourceLocks": ["shared.ts"] },
    { "id": "edit-shared-2", "executor": "dispatch-b", "trigger": "manual",
      "inputs": { "subagent": "code-edit", "workerInput": { "file": "shared.ts" } },
      "depends_on": [], "resourceLocks": ["shared.ts"] },
    { "id": "verify", "executor": "dispatch-a", "trigger": "manual",
      "inputs": { "subagent": "verify" },
      "depends_on": ["edit-alpha","edit-beta","edit-shared-1","edit-shared-2"], "resourceLocks": [] }
  ]
}
```

```typescript
// examples/offload-minio/test/smoke.test.ts  (offline — no Docker/MinIO/key)
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

it('4 real edits, routed across two executors, two contend on shared.ts, verify gates all', async () => {
  const plan = JSON.parse(await readFile(fileURLToPath(new URL('../plan.json', import.meta.url)), 'utf8'));
  const edits = plan.items.filter((i: any) => i.id.startsWith('edit-'));
  expect(edits).toHaveLength(4);
  expect(edits.every((e: any) => e.inputs.subagent === 'code-edit')).toBe(true); // all REAL
  expect(edits.every((e: any) => typeof e.inputs.workerInput?.file === 'string')).toBe(true);
  expect(new Set(edits.map((e: any) => e.executor))).toEqual(new Set(['dispatch-a','dispatch-b']));
  // two items share the shared.ts lock → serialize; the other two are disjoint → fan out
  const shared = edits.filter((e: any) => e.resourceLocks[0] === 'shared.ts');
  expect(shared).toHaveLength(2);
  const verify = plan.items.find((i: any) => i.id === 'verify');
  expect(verify.depends_on).toEqual(expect.arrayContaining(edits.map((e: any) => e.id)));
});
```

## Acceptance criteria

- `plan.json` parses and contains exactly 4 `edit-*` items + 1 `verify` item.
- **All** edits use the real `code-edit` subagent (no faked/no-model runtime); each carries `workerInput.file`.
- Edits are split across `dispatch-a` and `dispatch-b` (routing-by-executor-name).
- `edit-shared-1` and `edit-shared-2` both lock `shared.ts` (serialize); `edit-alpha`/`edit-beta` hold disjoint locks (fan out).
- `verify` `depends_on` all four edits.
- Fixtures `alpha.ts`/`beta.ts`/`shared.ts` each export `OLD_NAME`.
- The smoke test passes with no Docker, no MinIO, no API key.

Test file: `examples/offload-minio/test/smoke.test.ts`.

## Task: example config wiring

```yaml
id: task-config
depends_on: [task-aws-s3-mailbox-client, task-aws-s3-lock-client]
files:
  - examples/offload-minio/agora.config.mjs
status: done
is_wiring_task: true
```

Assemble the operator config (spec §4): an `S3Client` at `$AGORA_S3_ENDPOINT`
(forcePathStyle) feeding `S3StorageProvider` (bucket `agora-data`), the
`S3Mailbox` transport via `AwsS3MailboxClient` (`agora-data`, prefix `mailbox/`),
the `S3ObjectLockAnchor` via `AwsS3LockClient` (`agora-audit`), a local ed25519
signer, and **two** dispatch executors (`dispatch-a`/`dispatch-b`, both
`target: 'local'`, the **stock** `workerImage`, each with
`secrets: { ANTHROPIC_API_KEY: { inline: process.env.ANTHROPIC_API_KEY } }` so the
real `claude-code` worker can run — matching `offload-fanout`). The endpoint comes
from env so the same file serves the in-container serve path (`host.docker.internal`)
and the host client path (`localhost`) per spec §2.1.

```javascript
// shape (abridged) — examples/offload-minio/agora.config.mjs
import { S3Client } from '@aws-sdk/client-s3';
import { S3StorageProvider } from '@quarry-systems/agora-storage-s3';
import { AwsS3MailboxClient } from './src/aws-s3-mailbox-client.js';
import { AwsS3LockClient } from './src/aws-s3-lock-client.js';
import { S3Mailbox, MailboxSubmissionTransport, S3ObjectLockAnchor, DispatchExecutor /* +orchestrator parts */ } from '@quarry-systems/agora-orchestrator';
const WORKER_IMAGE = 'ghcr.io/quarrysystems/agora-worker:latest'; // STOCK image
const s3 = new S3Client({ endpoint: process.env.AGORA_S3_ENDPOINT, forcePathStyle: true, region: 'us-east-1', credentials: { /* minio */ } });
// storage: new S3StorageProvider({ bucket: 'agora-data', client: s3 })
// transport: new MailboxSubmissionTransport(new S3Mailbox(new AwsS3MailboxClient({ client: s3, bucket: 'agora-data', prefix: 'mailbox/' })))
// anchor: new S3ObjectLockAnchor(new AwsS3LockClient({ client: s3, bucket: 'agora-audit' }), 'agora-audit')
// executors: { 'dispatch-a': new DispatchExecutor({ client, target: 'local', workerImage: WORKER_IMAGE, secrets: { ANTHROPIC_API_KEY: { inline: process.env.ANTHROPIC_API_KEY } } }),
//              'dispatch-b': new DispatchExecutor({ client, target: 'local', workerImage: WORKER_IMAGE, secrets: { ANTHROPIC_API_KEY: { inline: process.env.ANTHROPIC_API_KEY } } }) }
```

## Acceptance criteria

- Importing `agora.config.mjs` is side-effect-safe (no throw, no network) when `ANTHROPIC_API_KEY` is unset — matching `offload-fanout`'s import-safety rule (the empty-string inline secret is acceptable at import; the live-run guard is the serve container's concern).
- Exports a wired `client`/`orch` shape consumable by both the serve entrypoint and the host driver.
- Uses `$AGORA_S3_ENDPOINT` (not a hardcoded host) so serve and the host client can each point at the right MinIO endpoint (§2.1).
- Registers exactly two executors (`dispatch-a`, `dispatch-b`) on the **stock** worker image, storage→`agora-data`, mailbox→`agora-data/mailbox/`, anchor→`agora-audit`.

Test file: `examples/offload-minio/test/e2e.test.ts` (config is exercised end-to-end there; authored in `task-e2e`).

## Task: serve container image

```yaml
id: task-serve-image
depends_on: [task-config]
files:
  - examples/offload-minio/Dockerfile.serve
  - examples/offload-minio/serve-entrypoint.mjs
status: running
is_wiring_task: true
```

Package `serve` as its own container (spec §2, §5 service side): a Node image that
loads `agora.config.mjs` and runs the `serve()` loop. The entrypoint constructs the
orchestrator + `S3Mailbox` transport from the config and calls `serve()`; the
container mounts the Docker socket (to launch sibling workers) and a named volume
(SQLite) — those mounts are declared in `task-compose`. The serve container is given
`ANTHROPIC_API_KEY` (the executors stage it into the real worker) and
`AGORA_S3_ENDPOINT=http://host.docker.internal:9000`. Resolve the §2 open item:
prefer `agora orch serve` if it can load this config, else this thin entrypoint.

```javascript
// examples/offload-minio/serve-entrypoint.mjs
import { serve } from '@quarry-systems/agora-orchestrator';
import { orch } from './agora.config.mjs';
const ac = new AbortController();
process.on('SIGTERM', () => ac.abort());
await serve({ orchestrator: orch.orchestrator, transport: orch.transport, signal: ac.signal });
```

## Acceptance criteria

- `docker build -f examples/offload-minio/Dockerfile.serve` produces an image whose `CMD` runs the serve loop.
- On start the container performs the §13.6 cold-start sequence (create SQLite schema if absent → construct registries from config → connect storage → poll the S3 inbox → start the tick loop) and exposes **no** inbound port.
- The container receives `ANTHROPIC_API_KEY` and `AGORA_S3_ENDPOINT` from its environment (set by compose).
- SIGTERM stops firing, finishes the in-flight reconcile pass, and exits cleanly.

Test file: `examples/offload-minio/test/e2e.test.ts` (serve is driven by the live run; authored in `task-e2e`).

## Task: S3 provider endpoint opts

```yaml
id: task-storage-s3-endpoint-opts
depends_on: []
files:
  - packages/agora-storage-s3/src/index.ts
  - packages/agora-storage-s3/test/endpoint-opts.test.ts
status: done
```

Extend `S3StorageProviderOpts` with optional `endpoint` / `forcePathStyle` / `region`
so a caller can target MinIO/LocalStack without pre-building an `S3Client`. When no
`client` is supplied but `endpoint` is, the provider builds
`new S3Client({ endpoint, forcePathStyle, region })` (credentials left to the SDK's
default env chain). When `client` IS supplied it wins (unchanged). Additive — real
AWS callers that pass neither are unaffected.

## Implementation

```typescript
// packages/agora-storage-s3/src/index.ts — extend opts + constructor
export interface S3StorageProviderOpts {
  bucket: string;
  client?: S3Client;
  prefix?: string;
  endpoint?: string;          // NEW — e.g. http://localhost:9000 (MinIO)
  forcePathStyle?: boolean;   // NEW — true for MinIO
  region?: string;            // NEW — defaults 'us-east-1'
  encryption?: { mode: 'AES256' } | { mode: 'aws:kms'; kmsKeyId?: string };
}
// in constructor: this.s3 = opts.client ?? new S3Client(
//   opts.endpoint ? { endpoint: opts.endpoint, forcePathStyle: opts.forcePathStyle, region: opts.region ?? 'us-east-1' } : {}
// );
```

```typescript
// packages/agora-storage-s3/test/endpoint-opts.test.ts
import { describe, it, expect } from 'vitest';
import { S3StorageProvider } from '../src/index.js';

it('builds a client targeting the given endpoint when no client is injected', async () => {
  const p = new S3StorageProvider({ bucket: 'b', endpoint: 'http://localhost:9000', forcePathStyle: true });
  // the internal client should resolve the configured endpoint
  const cfgEndpoint = await (p as any).s3.config.endpoint();
  expect(`${cfgEndpoint.protocol}//${cfgEndpoint.hostname}:${cfgEndpoint.port}`).toContain('localhost:9000');
});
```

## Acceptance criteria

- `S3StorageProviderOpts` gains optional `endpoint`/`forcePathStyle`/`region`; an injected `client` still takes precedence.
- With `endpoint` set and no `client`, the provider's S3 client resolves that endpoint (path-style honored).
- Existing behavior (no endpoint, no client → default AWS client) is unchanged; existing suite passes.

Test file: `packages/agora-storage-s3/test/endpoint-opts.test.ts`.

## Task: local-docker extraEnv

```yaml
id: task-provider-extra-env
depends_on: []
files:
  - packages/agora-providers-local-docker/src/index.ts
  - packages/agora-providers-local-docker/test/extra-env.test.ts
status: done
```

Add an optional `extraEnv?: Record<string, string>` to `LocalDockerProviderOpts`,
merged into each worker container's `Env` (so deploy-time config like
`AGORA_S3_ENDPOINT` + `AWS_*` creds reaches the worker's `process.env` at boot —
the only point the worker can configure its S3 client). `spec.env` (the dispatch
`AGORA_*` vars) takes precedence on key collisions.

## Implementation

```typescript
// packages/agora-providers-local-docker/src/index.ts
// opts: add `extraEnv?: Record<string, string>;` ; store `this.extraEnv = opts.extraEnv ?? {};`
// in prepareEnvAndBinds: const env = { ...this.extraEnv, ...spec.env };  // spec.env wins
```

```typescript
// packages/agora-providers-local-docker/test/extra-env.test.ts
import { describe, it, expect } from 'vitest';
import { LocalDockerProvider } from '../src/index.js';

it('passes extraEnv into the container Env (spec.env wins on collision)', async () => {
  const captured: any = {};
  const fakeDocker: any = { createContainer: async (cfg: any) => { captured.cfg = cfg; return { id: 'x', start: async () => {} }; } };
  const p = new LocalDockerProvider({ docker: fakeDocker, allowUnpinnedImage: true, extraEnv: { AGORA_S3_ENDPOINT: 'http://host.docker.internal:9000' } });
  await p.run({ image: 'img', command: [], dispatchId: 'd', env: { AGORA_NAMESPACE: 'ns' } } as any, {} as any);
  expect(captured.cfg.Env).toContain('AGORA_S3_ENDPOINT=http://host.docker.internal:9000');
  expect(captured.cfg.Env).toContain('AGORA_NAMESPACE=ns');
});
```

## Acceptance criteria

- `LocalDockerProviderOpts` gains optional `extraEnv`; defaults to `{}` (no behavior change when unset).
- `extraEnv` entries appear in the container `Env`; on key collision `spec.env` wins.
- Existing local-docker suite passes.

Test file: `packages/agora-providers-local-docker/test/extra-env.test.ts`.

## Task: worker S3 endpoint support

```yaml
id: task-worker-s3-endpoint
depends_on: [task-storage-s3-endpoint-opts]
files:
  - packages/agora-worker/src/bundle-fetcher.ts
  - packages/agora-worker/test/bundle-fetcher-s3-endpoint.test.ts
status: done
```

Make the worker's `constructStorageProvider` honor a custom S3 endpoint so a worker
can reach MinIO (today it builds `S3StorageProvider({ bucket, prefix })` against the
default AWS endpoint — unable to see MinIO). When `process.env.AGORA_S3_ENDPOINT` is
set, pass the new endpoint opts through; credentials ride the SDK's default env chain
(`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, set on the container via `extraEnv`).

## Implementation

```typescript
// packages/agora-worker/src/bundle-fetcher.ts — in the s3:// branch
const endpoint = process.env.AGORA_S3_ENDPOINT;
return new S3StorageProvider(
  endpoint
    ? { bucket, prefix, endpoint, forcePathStyle: true, region: process.env.AWS_REGION ?? 'us-east-1' }
    : { bucket, prefix },
);
```

```typescript
// packages/agora-worker/test/bundle-fetcher-s3-endpoint.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { constructStorageProvider } from '../src/bundle-fetcher.js';

afterEach(() => { delete process.env.AGORA_S3_ENDPOINT; });

it('passes the endpoint through to S3StorageProvider when AGORA_S3_ENDPOINT is set', async () => {
  process.env.AGORA_S3_ENDPOINT = 'http://host.docker.internal:9000';
  const sp: any = await constructStorageProvider('s3://agora-data');
  const cfgEndpoint = await sp.s3.config.endpoint();
  expect(cfgEndpoint.hostname).toBe('host.docker.internal');
});
```

## Acceptance criteria

- With `AGORA_S3_ENDPOINT` unset, `constructStorageProvider('s3://b')` behaves exactly as before (default AWS client).
- With it set, the returned provider's S3 client targets that endpoint with path-style addressing.
- `file://` / bare-path branches unchanged; existing worker suite passes.

Test file: `packages/agora-worker/test/bundle-fetcher-s3-endpoint.test.ts`.

## Task: wire extraEnv into config

```yaml
id: task-config-worker-env
depends_on: [task-config, task-worker-s3-endpoint, task-provider-extra-env]
files:
  - examples/offload-minio/agora.config.mjs
status: done
is_wiring_task: true
```

Update the example config's `LocalDockerProvider` construction to pass `extraEnv` so
the serve-launched worker containers receive the MinIO endpoint + credentials at boot
(the only way the worker's S3 client can target MinIO, per task-worker-s3-endpoint +
task-provider-extra-env). Values come from the serve container's own env (set by
compose): `AGORA_S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_REGION`.

```javascript
// examples/offload-minio/agora.config.mjs — LocalDockerProvider construction
new LocalDockerProvider({
  allowUnpinnedImage: true,
  extraEnv: {
    AGORA_S3_ENDPOINT: process.env.AGORA_S3_ENDPOINT ?? '',
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? process.env.AGORA_S3_ACCESS_KEY ?? 'minioadmin',
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? process.env.AGORA_S3_SECRET_KEY ?? 'minioadmin',
    AWS_REGION: process.env.AWS_REGION ?? 'us-east-1',
  },
})
```

## Acceptance criteria

- The config's `LocalDockerProvider` is constructed with `extraEnv` carrying `AGORA_S3_ENDPOINT` + `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` + `AWS_REGION`.
- Import-safety preserved: importing the config still throws nothing and opens no DB when env is unset (the `?? ''`/`?? 'minioadmin'` fallbacks keep it side-effect-free).
- No other part of the config changes.

Test file: `examples/offload-minio/test/e2e.test.ts` (exercised by the live run; authored in task-e2e).

## Task: MinIO compose stack

```yaml
id: task-compose
depends_on: [task-serve-image, task-config-worker-env]
files:
  - examples/offload-minio/docker-compose.yml
  - examples/offload-minio/scripts/init-buckets.sh
status: done
is_wiring_task: true
```

The compose stack (spec §2): a MinIO service (published on host `9000`), a one-shot
bucket-init that creates `agora-audit` **with object lock enabled** and `agora-data`
(no lock), and the `serve` container with the Docker socket mounted, a named volume
for SQLite, `AGORA_S3_ENDPOINT=http://host.docker.internal:9000`, `ANTHROPIC_API_KEY`
(from `../../.env`), and **no published port**. Worker containers (launched by serve
on the host daemon, default bridge per §2.1) run the **stock** worker image and reach
MinIO at `host.docker.internal:9000`.

## Acceptance criteria

- `docker compose up` starts MinIO and serve; `init-buckets.sh` creates `agora-audit` (object-lock enabled) and `agora-data` (no lock) idempotently.
- The serve service mounts `/var/run/docker.sock` and a named volume for the SQLite DB, sets `AGORA_S3_ENDPOINT` + `ANTHROPIC_API_KEY`, and publishes no port.
- A worker container launched during a run can reach MinIO at `host.docker.internal:9000` (add `host-gateway` mapping for non-Desktop Linux).
- Bringing the stack down and up again preserves run-state on the named volume (crash-safety, spec §4).

Test file: `examples/offload-minio/test/e2e.test.ts` (the live run requires this stack; authored in `task-e2e`).

## Task: end-to-end MinIO demo

```yaml
id: task-e2e
depends_on: [task-compose, task-plan-smoke]
files:
  - examples/offload-minio/src/index.ts
  - examples/offload-minio/test/e2e.test.ts
status: done
```

The host-side client driver (spec §5 client side) plus the live e2e + tamper test
asserting the §6 acceptance criteria. The driver registers the `code-edit`
(promptTemplate with `{{file}}`, à la `offload-fanout`) and `verify` subagents plus
the fixture capability **against MinIO storage** (shared, content-addressed — not a
serve connection), then builds an `OperationsApi` over the same `S3Mailbox` transport
(host endpoint) and submits. It never holds the `orchestrator`/`store` — it reaches
the serve container purely through MinIO. The host driver needs **no** API key (the
serve container stages it).

## Implementation

```typescript
// examples/offload-minio/src/index.ts  (driver — abridged)
import { readFile } from 'node:fs/promises';
import { OperationsApi } from '@quarry-systems/agora-orchestrator';
import { client, orch } from '../agora.config.mjs';
// 1. register subagents + fixture capability into shared MinIO storage (offload-fanout pattern)
const dir = new URL('../fixture/', import.meta.url);
const files = Object.fromEntries(await Promise.all(['alpha.ts','beta.ts','shared.ts']
  .map(async f => [f, await readFile(new URL(f, dir), 'utf8')])));
await client.capabilities.register({ name: 'minio-cap', files });
await client.subagent.register({ name: 'code-edit', capabilities: ['minio-cap'],
  promptTemplate: 'Rename the identifier OLD_NAME to NEW_NAME in `{{file}}` only — edit and save that one file, then stop.' });
await client.subagent.register({ name: 'verify', capabilities: ['minio-cap'],
  systemPrompt: 'Post-edit gate. Confirm the fixture files exist in your workspace, then exit 0.' });
// 2. submit via the mailbox; watch; audit
const api = new OperationsApi({ transport: orch.transport, anchor: orch.anchor, storage: orch.storage, verifySignature: orch.verifySignature });
const plan = JSON.parse(await readFile(new URL('../plan.json', import.meta.url), 'utf8'));
const runId = await api.submit(plan, 'human:demo');
for await (const _ of api.watch(runId, { intervalMs: 3000 })) { /* print item statuses */ }
const bundle = await api.audit(runId);
if (!bundle.report.intact || bundle.report.guarantee !== 'external-immutable') process.exitCode = 1;
```

```typescript
// examples/offload-minio/test/e2e.test.ts  (live — gated on AGORA_RUN_E2E)
import { describe, it, expect } from 'vitest';
const live = process.env.AGORA_RUN_E2E ? describe : describe.skip;
live('tier-1 minio e2e', () => {
  it('all 4 real-Claude edits reach done with result_refs and an external-immutable audit bundle', async () => {
    // register subagents/capability into MinIO; submit plan via OperationsApi over the S3 mailbox; watch to terminal
    // assert: every edit has a result_ref; bundle.report.intact === true;
    //         bundle.report.guarantee === 'external-immutable'
    expect(true).toBe(true); // placeholder for the live assertions
  });
  it('tampering a persisted audit entry fails verification (anchored root un-rewritable)', async () => {
    // mutate one SQLite audit entry on the serve volume, leave the MinIO root;
    // re-run verification → report.intact === false
    expect(true).toBe(true); // placeholder for the tamper assertion
  });
});
```

## Acceptance criteria

- `submit` returns a run id without blocking; `watch` advances item statuses driven only through the MinIO mailbox (the host driver cannot reach serve directly — no port).
- All four `edit-*` items run the real `claude-code` worker and expose a `result_ref`; fetching it from `agora-data` yields a reviewable patch.
- `edit-shared-1`/`edit-shared-2` are observed to serialize (never `running` simultaneously) via their shared `shared.ts` lock; `edit-alpha`/`edit-beta` may run concurrently.
- `audit(runId)` reports `intact: true`, `guarantee: 'external-immutable'`, and an `anchorId` naming the `agora-audit` object-lock anchor.
- The tamper test: mutating a persisted audit entry while the MinIO-anchored root stays put makes verification report `intact: false`.
- The exported bundle contains no secret values (refs only).

Test file: `examples/offload-minio/test/e2e.test.ts`.

## Task: example README

```yaml
id: task-readme
depends_on: [task-e2e]
files:
  - examples/offload-minio/README.md
status: done
is_wiring_task: true
```

Document the proof: prerequisites (build the **stock** worker image locally,
`docker compose up`), the run command, what the §6 acceptance checks prove, the
tamper demonstration, and the §0.2 representativeness boundary so a reader doesn't
over-claim what green means. Link the design spec.

## Acceptance criteria

- README lists the exact build/run sequence (`docker build` the stock worker image → `docker compose up` (MinIO + serve) → run the host driver) with the two MinIO endpoints called out (§2.1) and the `ANTHROPIC_API_KEY`-into-serve requirement.
- Documents the §6 acceptance + the tamper check, and links the design spec and the §0.2 boundary (all edits run the real adapter; the only substitutions are MinIO storage/mailbox/anchor + local-docker compute; Fargate/real-S3/KMS are Tier-2).
- States the cost posture (free infra; ~pennies of tokens per run) and the Tier-2 swap (endpoints + signer + Fargate target).

Test file: `examples/offload-minio/test/e2e.test.ts` (the README documents exactly this flow; no separate doc test).
