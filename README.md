# agora

> Secure, deterministic, auditable execution of AI agents — submit a DAG of tasks, fan out safely across an isolated, credential-sealed worker pool, and get back a reviewable patch artifact and a verifiable audit trail of exactly what ran — tamper-detecting by default, tamper-evident at the external-immutable (S3 Object Lock) tier.

A registry-backed dispatch SDK for sub-agent compute workloads. Integrators
register **capabilities**, **subagents**, and **env bundles** once at deploy
time, then **dispatch** against them at run time — the same code path
running locally against Docker as in production against Fargate + S3.
Provider seams (compute, credentials, storage, secret store, channel,
result sink) keep the registry shape and dispatch contract identical
across environments. The orchestrator layer adds a DAG planner on top:
disjoint resource locks fan out in parallel; shared locks serialize; each
finished task yields a reviewable patch (`result_ref`); the whole run
produces a tamper-evident audit trail — verifiable at the
external-immutable tier (S3 Object Lock), tamper-detecting on the local
default path.

agora is **source-available** under the Business Source License 1.1 — see
[LICENSE](./LICENSE) and [LICENSING.md](./LICENSING.md).

📖 **Docs:** https://quarrysystems.github.io/agora

## Install

```bash
pnpm add @quarry-systems/agora-client
```

The caller-side SDK pulls in `@quarry-systems/agora-core` (interface
contracts only) transitively. Provider packages — `agora-providers-*`,
`agora-storage-*` — are composed at the deployment boundary; install only
the ones your target stack uses.

## Hello World

```typescript
import { AgoraClient, NoopCredentialProvider, StdoutResultSink } from '@quarry-systems/agora-client';
import { LocalStorageProvider } from '@quarry-systems/agora-storage-local';
import { LocalDockerProvider } from '@quarry-systems/agora-providers-local-docker';

const client = new AgoraClient({
  namespace: 'hello-world',
  compute: { 'local-docker': new LocalDockerProvider({ allowUnpinnedImage: true }) },
  credentials: { none: new NoopCredentialProvider() },
  storage: new LocalStorageProvider({ rootDir: '/tmp/agora' }),
  targets: { local: { compute: 'local-docker', credentials: 'none' } },
  resultSink: new StdoutResultSink(),
});

await client.capabilities.register({ name: 'echo-cap', files: { 'agora-setup.sh': '#!/bin/sh\necho "hello from agora-worker"\n' } });
await client.subagent.register({ name: 'echo', systemPrompt: 'Just exit.', capabilities: ['echo-cap'] });
await client.env.register({ name: 'minimal', values: { LOG_LEVEL: 'info' } });

const result = await client.dispatch({ subagent: 'echo', env: 'minimal', target: 'local', workerImage: 'ghcr.io/quarrysystems/agora-worker:latest' });
console.log(result.stdout);
```

The full runnable version (with mkdtemp + cleanup, comments, and a
Fargate + S3 production variant) lives at
[`examples/hello-world/`](examples/hello-world/).

## Offload

The orchestrator surfaces as the `agora orch` subcommand. A `plan.json`
describes a DAG of agent tasks with `depends_on`, `resourceLocks`, and
per-task subagent/env/target bindings. Disjoint resource locks fan out in
parallel; shared locks serialize automatically. Each finished task drops a
reviewable patch artifact (`result_ref`). The run produces a tamper-evident
audit bundle — verifiable at the external-immutable tier (S3 Object Lock),
tamper-detecting on the local path.

```sh
agora orch serve              # long-running driver (sole DB owner)
agora orch validate plan.json # pre-flight plan validation, no submit
agora orch submit plan.json   # non-blocking; prints a run id
agora orch watch <run-id>     # follow the run to completion
agora orch audit <run-id>     # exportable evidence bundle (verifies; names the guarantee tier)
agora orch audit <run-id> --out bundle.json   # write the bundle to a file
agora verify bundle.json      # re-verify an exported bundle against its external anchor
agora pipeline register|validate|list         # manage declared worker pipelines
```

See [`examples/offload-fanout/`](examples/offload-fanout/) for the runnable
demo — a three-task fan-out plan that exercises parallel locks, patch
artifacts, and the audit command end-to-end.

## What's in this repo

Thirteen packages under `packages/`:

| Package | One-liner |
|---|---|
| [`agora-core`](packages/agora-core/) | Types-only contract package. Every other agora package depends on this; nothing depends on anything else by default. |
| [`agora-client`](packages/agora-client/) | Caller-side SDK. `AgoraClient` is the single entry point integrators construct: registration + dispatch surface, with wired-in providers. |
| [`agora-cli`](packages/agora-cli/) | The `agora` binary. Thin CLI over `AgoraClient` that resolves `agora.config.{ts,js,mjs}` and dispatches to subcommands. Canonical privileged entry point. |
| [`agora-mcp`](packages/agora-mcp/) | Stdio MCP server exposing exactly nine run-time, orchestration-safe tools. `register` / `assign` are deliberately absent — privileged ops never reach the AI loop. |
| [`agora-worker`](packages/agora-worker/) | Container-side runtime. One process per dispatch. Fetches bundles, verifies integrity, overlays the workspace, resolves secrets, hands off to a `RuntimeAdapter`. The runtime is a block-pipeline runner — agent / script / capture blocks, seal auto-appended. |
| [`agora-runtime-claude-code`](packages/agora-runtime-claude-code/) | MVP `RuntimeAdapter` implementation. Prompt rendering, `claude --print` invocation, Claude-specific merge rules, `needs_input` sentinel detection. |
| [`agora-providers-fargate`](packages/agora-providers-fargate/) | `ComputeProvider` backed by AWS ECS Fargate (`RunTask` / `DescribeTasks` / `StopTask`). Production target. |
| [`agora-providers-local-docker`](packages/agora-providers-local-docker/) | `ComputeProvider` backed by the local Docker daemon via `dockerode`. Developer iteration + local smoke suite. |
| [`agora-providers-aws-creds`](packages/agora-providers-aws-creds/) | `CredentialProvider` wrapping the AWS SDK default credential chain. Lazy resolution, no extra caching. |
| [`agora-storage-s3`](packages/agora-storage-s3/) | `StorageProvider` backed by S3. Content-addressed object layout, integrity-verified on read. Production target. |
| [`agora-storage-local`](packages/agora-storage-local/) | `StorageProvider` backed by the local filesystem. Pairs with `agora-providers-local-docker` for the local stack. |
| [`agora-secret-store`](packages/agora-secret-store/) | `SecretStore` seam plus impls — `AwsSecretStore` (AWS Secrets Manager), `LocalSecretStore` (on-disk), and a `storeFromConfig` factory. `agora-client` takes injected per-target stores (`secretStores`); the worker builds its store via `storeFromConfig`. |
| [`agora-orchestrator`](packages/agora-orchestrator/) | Orchestrator engine (codename *agora-offload*): named queues, `depends_on` resolution, resource locks, a fire-and-reconcile tick loop, SQLite run-state, typed-product handoff (`needs` → content-addressed `inputRefs`), per-queue execution patterns with audited dynamic spawn, and provenance-closure verification, behind pluggable `Executor` / `Trigger` seams. |

Plus:

- [`examples/`](examples/) — runnable worked examples:
  [`hello-world/`](examples/hello-world/) (the §4.4 worked example, also the
  integrator on-ramp); [`offload-fanout/`](examples/offload-fanout/) (the
  headline offload demo — locks + deps + concurrency + patch escape + audit);
  [`handoff-dag/`](examples/handoff-dag/) (typed-product handoff: B builds on
  A's patch); [`pattern-mapreduce/`](examples/pattern-mapreduce/) (dynamic
  fan-out: one item grows to five, provenance-verified);
  [`pattern-dogfood/`](examples/pattern-dogfood/) (gated circle-back via
  spawn); [`data-mapreduce/`](examples/data-mapreduce/) (the `data` pack: a
  second domain on the same engine, fully offline).
- [Architecture decisions](https://quarrysystems.github.io/agora/explanation/decisions/) — ADRs for the substantive design
  decisions taken during MVP design (published in the docs site).
- [`docker/`](docker/) — the published worker OCI image build context.

## User guides

Start here if you're new:

- [Getting started](https://quarrysystems.github.io/agora/tutorials/first-dispatch/) — zero-to-first-dispatch on
  local Docker. Build the worker image, write `agora.config.mjs`, wire the
  CLI and MCP server, register and dispatch.
- [Your first offload run](https://quarrysystems.github.io/agora/tutorials/first-offload-run/) — submit a
  small DAG, watch it fan out under resource locks, and verify the audit bundle.

Reference:

- [Dispatch lifecycle](https://quarrysystems.github.io/agora/reference/dispatch-lifecycle/) — what each event in the
  worker stdout stream means, which lifecycle step each `dispatch.failed`
  reason maps to.
- [Worker file layout](https://quarrysystems.github.io/agora/how-to/worker-file-layout/) — where to put files so the
  worker picks them up (skills, settings, plugins, setup scripts), and the
  `agora-setup.sh` single-slot constraint that catches first-time authors.
- [Sync capabilities & subagents](https://quarrysystems.github.io/agora/how-to/sync-capabilities-subagents/) — `agora capabilities sync` /
  `agora subagent sync` reference, the `claude-code` and `stoa` providers
  shipped today, and how to author a new one.
- [Handle needs_input](https://quarrysystems.github.io/agora/how-to/handle-needs-input/) — how a sub-agent pauses for
  clarification, what the orchestrator does with the question, and how
  re-dispatch threads continuity through `partial_state`.
- [How an offload run executes](https://quarrysystems.github.io/agora/explanation/how-offload-runs/) — run a DAG of agent
  tasks unattended with `agora orch serve | submit | watch | cancel | audit`:
  queues/deps/resource-locks, the patch escape (`result_ref`), and the
  verifiable audit bundle + guarantee tiers.

Extension + deployment:

- [Writing a provider](https://quarrysystems.github.io/agora/how-to/write-a-provider/) — plug in a new compute
  backend, storage layer, credential source, or result sink.
- [Remote Docker dispatch](https://quarrysystems.github.io/agora/how-to/remote-docker-dispatch/) — orchestrate
  from one machine, run workers on another machine's Docker daemon.

## Architecture

> For the **end-to-end runtime process** (register → CLI/MCP surfaces + the
> §10.6 privilege boundary → `dispatch` vs `orch` → worker sandbox → patch escape
> → tamper-evident audit), see the
> [Architecture overview](https://quarrysystems.github.io/agora/explanation/architecture-overview/) — one rendered diagram
> of the whole flow. The graph below is the complementary **package dependency**
> view.

The package dependency graph (§8 of the spec). `agora-core` is the
types-only sink; every arrow flows toward it:

```mermaid
graph TD
  core[agora-core<br/><i>types only</i>]
  client[agora-client]
  cli[agora-cli]
  mcp[agora-mcp]
  worker[agora-worker]
  runtime[agora-runtime-claude-code]
  pfargate[agora-providers-fargate]
  plocal[agora-providers-local-docker]
  pawscreds[agora-providers-aws-creds]
  ss3[agora-storage-s3]
  slocal[agora-storage-local]
  secretstore[agora-secret-store]
  orch[agora-orchestrator<br/><i>offload engine</i>]

  client --> core
  client --> secretstore
  cli --> client
  mcp --> client
  mcp --> orch
  worker --> core
  worker --> secretstore
  worker --> ss3
  worker --> slocal
  runtime --> core
  pfargate --> core
  plocal --> core
  pawscreds --> core
  ss3 --> core
  slocal --> core
  secretstore --> core
  orch --> core
  orch --> client
```

ASCII rendering of the same graph:

```text
agora-core                              (types only)
   ▲
   ├── agora-client                     (caller-side SDK)
   │     ▲
   │     ├── agora-cli                  (binary `agora`)
   │     ├── agora-mcp                  (stdio MCP server, run-time tools only; also depends on agora-orchestrator)
   │     └── agora-orchestrator         (offload engine — queues/deps/locks, serve, operations API, tamper-evident audit; CLI `agora orch` + client MCP tools)
   ├── agora-worker                     (container-side runtime; also depends on agora-secret-store + both storage packages)
   ├── agora-runtime-claude-code        (RuntimeAdapter impl)
   ├── agora-providers-fargate          (ComputeProvider, AWS Fargate)
   ├── agora-providers-local-docker     (ComputeProvider, local Docker)
   ├── agora-providers-aws-creds        (CredentialProvider, AWS)
   ├── agora-storage-s3                 (StorageProvider, S3)
   ├── agora-storage-local              (StorageProvider, local FS)
   └── agora-secret-store               (SecretStore seam: AWS + Local; agora-client and agora-worker also depend on it)
```

No agora package depends on another Quarry Systems library (Stoa,
Bedrock, RaState, etc.). The constraint is enforced by a CI allowlist
check on `package.json` dependencies.

## Documentation

- [Roadmap](ROADMAP.md) — what's shipped in V1, what's planned next (V1.1, additive), and what's left as a branch. Also as a [docs-site page](https://quarrysystems.github.io/agora/explanation/project-status-roadmap/).
- [Changelog](CHANGELOG.md) — notable changes per release. [Releasing](RELEASING.md) documents how a release is cut (manual today).
- [Full MVP design spec](docs/superpowers/specs/2026-05-21-agora-mvp-design.md) — the §1–§11 design canon.
- [Orchestrator architecture spec](docs/superpowers/specs/2026-05-28-agora-orchestrator-design.md) — the *agora-offload* design: registries, effect tiers, queues/deps/locks, the intent outbox, and the trunk trap-check driving the `agora-orchestrator` package.
- [Offload V1 delivery spec](docs/superpowers/specs/2026-05-29-agora-offload-v1-design.md) — the shipped V1 slice (`serve` + escape + tamper-evident audit + operator surface), the security/determinism/auditability edge, and the honesty constraints. See also [How an offload run executes](https://quarrysystems.github.io/agora/explanation/how-offload-runs/).
- [Architecture decisions](https://quarrysystems.github.io/agora/explanation/decisions/) — eighteen ADRs covering
  package scope, repo location, runtime-adapter seam, secret TTL,
  lifecycle vocabulary, MCP auth model, the source-available (BSL) license,
  orchestration-as-a-separate-layer (ADR-0018, superseding ADR-0010), and more.
- [Examples](examples/) — worked, runnable demonstrations against the
  local provider stack.

## Common commands

```sh
pnpm install            # install workspace deps
pnpm -r run lint        # lint every package
pnpm -r run test        # test every package
pnpm -r run typecheck   # typecheck every package
pnpm -r run build       # build every package
```

## License

agora is **source-available** under the Business Source License 1.1 — see
[LICENSE](./LICENSE) and [LICENSING.md](./LICENSING.md).
