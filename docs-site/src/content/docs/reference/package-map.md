---
title: Package map
description: The thirteen agora packages and the package dependency graph (everything points at agora-core).
sidebar:
  order: 7
---

agora ships as thirteen packages under `packages/`, all published under the
`@quarry-systems/` npm scope. `agora-core` is the types-only contract sink;
every other package depends on it and nothing else by default.

## The thirteen packages

| Package | One-liner |
|---|---|
| `agora-core` | Types-only contract package. Every other agora package depends on this; nothing depends on anything else by default. |
| `agora-client` | Caller-side SDK. `AgoraClient` is the single entry point integrators construct: registration + dispatch surface, with wired-in providers. |
| `agora-cli` | The `agora` binary. Thin CLI over `AgoraClient` that resolves `agora.config.{ts,js,mjs}` and dispatches to subcommands. Canonical privileged entry point. |
| `agora-mcp` | Stdio MCP server exposing the run-time, orchestration-safe tool surface. `register` / `assign` are deliberately absent — privileged ops never reach the AI loop. |
| `agora-worker` | Container-side runtime. One process per dispatch. Fetches bundles, verifies integrity, overlays the workspace, resolves secrets, hands off to a `RuntimeAdapter`. |
| `agora-runtime-claude-code` | MVP `RuntimeAdapter` implementation. Prompt rendering, `claude --print` invocation, Claude-specific merge rules, `needs_input` sentinel detection. |
| `agora-providers-fargate` | `ComputeProvider` backed by AWS ECS Fargate (`RunTask` / `DescribeTasks` / `StopTask`). Production target. |
| `agora-providers-local-docker` | `ComputeProvider` backed by the local Docker daemon via `dockerode`. Developer iteration + local smoke suite. |
| `agora-providers-aws-creds` | `CredentialProvider` wrapping the AWS SDK default credential chain. Lazy resolution, no extra caching. |
| `agora-storage-s3` | `StorageProvider` backed by S3. Content-addressed object layout, integrity-verified on read. Production target. |
| `agora-storage-local` | `StorageProvider` backed by the local filesystem. Pairs with `agora-providers-local-docker` for the local stack. |
| `agora-secret-store` | `SecretStore` seam plus impls — `InlineSecretStager` (AWS Secrets Manager) and `LocalSecretStore` (on-disk staging). `agora-client` also depends on it. |
| `agora-orchestrator` | Orchestrator engine (codename *agora-offload*): named queues, `depends_on` resolution, resource locks, a fire-and-reconcile tick loop, SQLite run-state, and a verifiable audit trail (tamper-detecting by default, tamper-evident at the S3 Object Lock tier), behind pluggable `Executor` / `Trigger` seams. Surfaces as `agora orch` + the client MCP tools. |

:::note
The README labels the agora-mcp tool surface as "exactly six run-time tools."
The shipped server exposes **nine** — see [MCP tools](/agora/reference/mcp-tools/).
:::

## Dependency graph

`agora-core` is the types-only sink; every arrow flows toward it. The only
package that depends on more than `agora-core` is `agora-client` (which also
depends on `agora-secret-store`), and the two consumer packages `agora-cli` /
`agora-mcp`, which depend on `agora-client`.

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
  worker --> core
  runtime --> core
  pfargate --> core
  plocal --> core
  pawscreds --> core
  ss3 --> core
  slocal --> core
  secretstore --> core
  orch --> core
```

No agora package depends on another Quarry Systems library (Stoa, Bedrock,
RaState, etc.). The constraint is enforced by a CI allowlist check on
`package.json` dependencies.
