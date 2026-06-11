---
title: MCP tools
description: The run-time MCP tool surface exposed by pangolin-mcp — three catalog reads, three dispatch operations, three orchestrator operations.
sidebar:
  order: 2
---

`@quarry-systems/pangolin-mcp` is a stdio MCP server that exposes a deliberately
narrow, **run-time-safe** tool surface over a `PangolinClient` (and, when
configured, an `OperationsApi`). Privileged deploy-time operations
(`register`, `assign`) and privileged/service orchestrator operations never
appear here — see [The privilege boundary](/pangolin/explanation/privilege-boundary/).

## The tools

The server registers **nine** tools, in declaration order (the
`PANGOLIN_TOOL_NAMES` tuple in `tools.ts`):

### Catalog reads (metadata only)

These return metadata only — never file contents, system-prompt bodies, secret
values, or secret ARNs.

| Tool | Purpose | Inputs |
|---|---|---|
| `pangolin_capabilities_list` | List registered capabilities (`name`, `registeredAt`, `contentHash`). | none |
| `pangolin_subagents_list` | List registered subagents (`name`, `registeredAt`, `contentHash`). | none |
| `pangolin_envs_list` | List registered env bundles (`name`, `registeredAt`, `contentHash`). | none |

### Dispatch operations

| Tool | Purpose | Inputs |
|---|---|---|
| `pangolin_dispatch` | Dispatch a unit of work to a registered subagent on a configured target. Returns a `DispatchResult`. | Required: `target`, `subagent`, `workerImage`. Optional: `env`, `capabilities`, `addCapabilities`, `secrets`, `input`, `callback`, `timeoutSeconds`, `defaultDispatchTimeoutSeconds`, `retentionDays`, `resources`, `dispatchId`. (`additionalProperties` allowed.) |
| `pangolin_dispatch_describe` | Look up a previously-sealed dispatch record by id. Returns the full `DispatchResult`. Throws if purged by retention. | Required: `dispatchId`. |
| `pangolin_dispatch_cancel` | Request cancellation of an in-flight dispatch by id. | Required: `dispatchId`. |

### Orchestrator operations

These three are pure client-side translators over `OperationsApi`. Each
requires the `orch` export in `pangolin.config` to be configured; without it the
tool returns a clear "orchestrator surface not configured" error response.

| Tool | Purpose | Inputs |
|---|---|---|
| `pangolin_orchestrator_submit` | Submit a `Run` plan to the orchestrator. Returns the run id. | Required: `plan` (object). Optional: `actor` (defaults to `agent:mcp`). |
| `pangolin_orchestrator_status` | Return the latest status `OutboxRecord` for a run id. | Required: `runId`. |
| `pangolin_orchestrator_watch` | Poll and wait for a run to reach a terminal state. Returns the last record seen; bounded by `timeoutMs`. | Required: `runId`. Optional: `timeoutMs` (default `25000`). |

## Deliberately absent

The following are excluded by design and enforced architecturally by a CI
allowlist check:

- any `pangolin_*_register` — registration is a privileged deploy-time operation.
- any `pangolin_*_assign` — capability assignment is privileged.
- `pangolin_orchestrator_cancel` — privileged.
- `pangolin_orchestrator_audit` — service-only.
- `pangolin_orchestrator_serve` — CLI-only.

Registration and assignment run through the [CLI](/pangolin/reference/cli/)
instead. The reasoning behind keeping privileged operations out of the AI loop
is in [The privilege boundary](/pangolin/explanation/privilege-boundary/).

:::note
The README describes the pangolin-mcp surface as "exactly six run-time tools."
That count reflects the original surface (three catalog reads + three dispatch
operations). The code exposes **nine**: the three `pangolin_orchestrator_*` client
tools were added when the offload orchestrator landed. The authoritative list
is the `PANGOLIN_TOOL_NAMES` tuple in `pangolin-mcp`.
:::

## Error handling

Errors thrown by client or `OperationsApi` methods are caught and returned as
`{ content, isError: true }` responses. The server surfaces `err.message` only,
never `err.stack`, so internal file paths and trace frames never leak across
the tool boundary.
