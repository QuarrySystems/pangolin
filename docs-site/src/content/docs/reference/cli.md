---
title: CLI reference
description: Every `pangolin` and `pangolin orch` subcommand, its options, arguments, and exit behavior.
sidebar:
  order: 1
---

The `pangolin` binary is a thin CLI over `PangolinClient` (and, for the `orch`
family, an `OperationsApi`). It resolves a `pangolin.config.{ts,js,mjs}` in the
current working directory and dispatches to the subcommand. See
[pangolin.config reference](/pangolin/reference/config/) for how the config is
resolved and what it must export.

The CLI is the **canonical privileged entry point** — `register`, `assign`,
`deploy`, and `orch cancel` / `orch audit` / `orch serve` all live here and
are deliberately absent from the [MCP tool surface](/pangolin/reference/mcp-tools/).
See [The privilege boundary](/pangolin/explanation/privilege-boundary/).

Most subcommands load the client lazily, so the `pangolin.config` resolution cost
is only paid when a subcommand actually runs.

## `pangolin capabilities`

Manage capability bundles.

| Subcommand | Args / options | Behavior |
|---|---|---|
| `register` | `--name <name>` (required), `--from <dir>` (required) | Walks `<dir>` recursively, builds a `files:` map keyed by forward-slash relative paths, calls `client.capabilities.register`. Prints the resulting `CapabilityRef` as JSON. |
| `list` | — | Prints one tab-delimited line per capability: `name\tcontentHash\tregisteredAt`. |
| `get <name>` | — | Prints the named capability ref as JSON, or `(not found)` when the lookup returns `null`. |
| `sync` | `--provider <name>` (required), `--from <dir>`, `--dry-run` | Bulk-registers capabilities from a provider's on-disk convention. `--from` defaults to the provider's `defaultCapabilityDir`. `--dry-run` parses and prints without registering. See [Sync capabilities & subagents](/pangolin/how-to/sync-capabilities-subagents/). |

## `pangolin subagent`

Manage subagents.

| Subcommand | Args / options | Behavior |
|---|---|---|
| `register` | `--name <name>` (required), `--from <file>`, `--system-prompt <text>`, `--prompt-template <text>`, `--model <id>`, `--capability <names...>` (repeatable) | Registers a subagent from a YAML file (`--from`) **or** inline flags — not both. Supply `--from` or at least one inline field, else it errors. Prints `{ name, contentHash, registeredAt }` as JSON. `--model <id>` pins the preferred model for this subagent; accepts a reserved level (`fast`, `standard`, `max`) or a provider-native id — see the [level vocabulary table](/pangolin/reference/pangolin-client-api/#reserved-level-vocabulary). Pin-optional: omitting it leaves the subagent model-agnostic. |
| `assign <name>` | `--capabilities <list>` (required, comma-separated) | **Currently restricted.** Touches the client (so config errors surface), then throws a clear error directing you to re-register the subagent with the new capability list. Full assign-only flow is deferred to v1.5. |
| `list` | — | Prints one tab-delimited line per subagent: `name\tcontentHash\tregisteredAt`. |
| `get <name>` | — | Prints the named subagent ref as JSON, or `(not found)`. |
| `sync` | `--provider <name>` (required), `--from <dir>`, `--dry-run` | Bulk-registers subagents from a provider's convention. `--from` defaults to `defaultSubagentDir`. |

## `pangolin env`

Manage env bundles.

| Subcommand | Args / options | Behavior |
|---|---|---|
| `register` | `--name <name>` (required), `--value <kv...>` (repeatable), `--secret <kv...>` (repeatable) | `--value` takes `KEY=VALUE` pairs (non-secret). `--secret` takes `KEY=arn:...`, `KEY=local-secret://...`, or `KEY=inline:<value>`. A `--secret` value with no recognized prefix prints an error and exits `1`. Prints the `EnvRef` as JSON. |
| `list` | — | Prints one tab-delimited line per env bundle: `name\tcontentHash\tregisteredAt`. |
| `get <name>` | — | Prints the named env ref as JSON, or `(not found)`. |

The `--secret` prefixes are the single source of truth for the flag format:
`arn:` / `local-secret://` produce an opaque `{ ref }`; `inline:` strips the
prefix and produces `{ inline }`.

## `pangolin dispatch`

Dispatch and observe workers.

| Subcommand | Args / options | Behavior |
|---|---|---|
| `run` | `--subagent <name>` (required), `--target <name>` (required), `--env <names...>`, `--input <json>` (default `{}`), `--capability <names...>`, `--add-capability <names...>`, `--worker-image <digest>` | Parses `--input` as JSON (invalid JSON → error + exit `1`). Calls `client.dispatch`. `--worker-image` defaults to `ghcr.io/quarrysystems/pangolin-worker:latest` (the published worker image). Prints the `DispatchResult` as pretty JSON. **Exits `1` if `result.failure` is set.** |
| `describe <id>` | — | Calls `client.dispatch.describe(id)`, prints the full `DispatchResult` as pretty JSON. |
| `cancel <id>` | — | Calls `client.dispatch.cancel(id)`, prints `cancelled: <id>`. |

`--capability` **replaces** the subagent's assigned capability set;
`--add-capability` **appends** to it. Combining both throws (enforced
client-side).

## `pangolin deploy`

Reconcile a manifest against the registry.

| Args / options | Behavior |
|---|---|
| `--from <path>` (required) | Parses the manifest at `<path>` and walks it top-to-bottom in three phases: **capabilities** (each `from:` dir is bundled and registered) → **subagents** → **envs**. Per-entry confirmation lines are printed as `<type> <name>\t<contentHash>`. |

Halt-on-failure: the first registration error aborts the deploy; no rollback
is attempted, so partial state remains on the registry. Re-registration is
idempotent via content-addressing, so running the same manifest twice produces
no new entries.

## `pangolin orch`

Submit, follow, cancel, and audit offload runs. Aliased as `pangolin
orchestrator`. These verbs require the `pangolin.config` to export an `orch`
context (an `OrchContext`); the error surfaces lazily when a verb runs without
it.

| Subcommand | Args / options | Behavior |
|---|---|---|
| `submit <plan.json>` | `--queue <name>`, `--actor <id>` | Reads and parses the plan JSON. `--queue` overrides the plan's `queue`. Submits via `OperationsApi.submit`. Prints the run id. |
| `validate <plan.json>` | — | Static whole-DAG pre-flight: normalizes the plan (`needs[*].from` unioned into `depends_on`), then runs the same `validateRun` the submit path enforces — structural checks, duplicate ids, reference existence, `needs ⊆ depends_on`, cycle detection, and edge-type-tag compatibility. Every error prints on stderr (collect-all) and **exit code is `1` on an invalid plan**; a valid plan prints `{"valid":true,"items":N}`. Does not touch the store. |
| `status [run-id]` | — | Prints the latest status record for the run as pretty JSON (or `null`). |
| `watch <run-id>` | `--json`, `--interval <ms>`, `--no-color`, `--no-clear`, `--ascii`, `--pattern <name>` | Live pattern-aware view: status glyphs, ghost respawn arcs under `spawn-fix` gates until resolution, per-item model/cost evidence when storage is available, and a terminal verify-row summary. Redraws in place each poll cycle until the run reaches a terminal state (Ctrl-C to stop). See [`pangolin orch watch` — the live view](#pangolin-orch-watch--the-live-view) for details. |
| `cancel <target>` | `--actor <id>` | Requests cancellation of a run/item. Prints `cancel requested: <target>`. |
| `audit <run-id>` | `--out <path>` | Produces the audit bundle. Writes to `--out` if given, else prints JSON. **Sets exit code `1` when the bundle's `report.intact` is false.** Pair with the top-level [`pangolin verify`](#pangolin-verify) to re-check an exported bundle. See [Export & verify an audit bundle](/pangolin/how-to/verify-audit-bundle/). |
| `serve` | — | Starts the long-running orchestrator driver via the config's `runService`. Errors if the `orch` export provides no `runService`. Wires `SIGINT`/`SIGTERM` to an `AbortController` for graceful shutdown. |
| `schedule add` | `--id <id>` (required), `--cron "<expr>"` (required), `--plan <plan.json>` (required), `--actor <id>` | Validates the cron expression up front (throws on invalid syntax), computes the first `nextDueAt`, and upserts the schedule. Re-running with the same `--id` is an idempotent update — the expression, template, and actor are replaced, and bookkeeping recomputed. Prints `schedule '<id>' next due <ISO>`. Errors if the `orch` export provides no `scheduleStore`. |
| `schedule list` | — | Prints one tab-delimited line per schedule: `id\tcronExpr\tlast=<ISO or '-'>\tnext=<ISO>`. Errors if the `orch` export provides no `scheduleStore`. |
| `schedule rm` | `--id <id>` (required) | Removes a schedule by id. No-op if the id is absent (re-runnable safe). Errors if the `orch` export provides no `scheduleStore`. |

The actor for `submit`, `cancel`, and `schedule add` resolves as: the `--actor` flag, else
`$PANGOLIN_ACTOR`, else `human:<os-username>`.

### `pangolin orch render` — preview a plan before submitting

```sh
pangolin orch render <plan.json> [--pattern <name>] [--no-color] [--ascii]
```

Renders the pre-run view of a plan file — ghost arcs dotted, item ids and
dependency edges laid out in the chosen pattern — without reading an
`pangolin.config` file. Useful for inspecting a plan before you have an
orchestrator running.

| Flag | Description |
|---|---|
| `--pattern <name>` | Layout pattern: `pipeline`, `map-reduce`, or `static-dag`. Omitting `--pattern` renders a generic dependency tree with no pattern-specific ghost arcs. |
| `--no-color` | Disable ANSI color output. |
| `--ascii` | Use pure-ASCII glyphs (no Unicode box-drawing characters). |

Validation errors from `pattern.plan()` (for example, a missing splitter item
for `map-reduce`) surface on stderr with a non-zero exit code, the same way
`orch validate` surfaces them.

### `pangolin orch watch` — the live view

```sh
pangolin orch watch <run-id> [--pattern <name>] [--interval <ms>] [--no-color] [--no-clear] [--ascii] [--json]
```

By default, `watch` renders a **live pattern-aware view** that redraws in place
each poll cycle: status glyphs per item, ghost respawn arcs under `spawn-fix`
gates until they resolve, per-item model/cost evidence when storage is
available, and a terminal verify-row summary once the run seals. Ctrl-C stops
the watch early.

| Flag | Description |
|---|---|
| `--pattern <name>` | Layout pattern for the view: `pipeline`, `map-reduce`, or `static-dag`. |
| `--interval <ms>` | Poll interval in milliseconds (default determined by the transport). |
| `--no-color` | Disable ANSI color output. |
| `--no-clear` | Append frames instead of redrawing in place. |
| `--ascii` | Use pure-ASCII glyphs. |
| `--json` | **Scripting escape hatch.** Raw record stream: one JSON line per poll, the previous default format. Use this when piping `watch` output to a downstream tool. |

## `pangolin pipeline`

Manage declared block-pipeline specs (see
[Dispatch lifecycle → The block-pipeline runner](/pangolin/reference/dispatch-lifecycle/#the-block-pipeline-runner)).
Pipeline verbs are client/CLI surface — they are not orchestrator operations and
are not MCP-reachable.

| Subcommand | Args / options | Behavior |
|---|---|---|
| `register <file>` | — | Reads a `PipelineSpec` JSON file and calls `client.pipeline.register`. The spec is validated (collect-all), content-addressed over its canonical-JSON form, and stored as a pinned immutable version. Prints `{ id, contentHash, registeredAt, pinnedUri }` as JSON — `pinnedUri` is the `pangolin://<namespace>/pipeline/<id>@<hash>` ref a dispatch pins. Missing file, invalid JSON, or an invalid spec → error + exit `1`. Re-registering the identical spec is idempotent (same hash, original `registeredAt`). |
| `validate <file>` | — | **Storage-free** structural validation — no `pangolin.config`, no client, no network. Runs the same `validatePipelineSpec` check as `register` (known block kinds, reserved `seal` rejected, `<pack>.<name>` id form, non-empty `blocks`, script/capture parameter validity, edge-type tags). Collect-all: every error prints on stderr and **exit code is `1` on an invalid spec**; a valid spec prints `OK`. |
| `list` | — | Prints one tab-delimited line per pipeline: `id\tcontentHash\tregisteredAt` — mirroring the `subagent` / `capabilities` list surface. Catalog enumeration is not yet implemented in the storage layer, so today this surfaces the same "not yet implemented" error those resource types would. |

## `pangolin verify`

Re-verify an **exported** audit bundle against its external anchor. Top-level
(sibling to `orch`), and — like `orch audit` — it requires the `pangolin.config` to
export an `orch` context carrying an `anchor`.

| Args / options | Behavior |
|---|---|
| `verify <bundle.json>` · `--json`, `--full` | Reads and parses the bundle file, rebuilds an in-memory audit store from its `auditLog.entries`, and re-runs `verify()` against the **live anchor** — never the root embedded in the bundle. Prints a human-readable checklist + hash-chained ledger. `--json` emits the raw `VerificationReport` (including the collect-all `checks` map **and the `timeTier` field** — `asserted` vs `tsa-attested`, the orthogonal trusted-time dimension); `--full` prints every ledger row instead of head+tail. **Sets exit code `1` when the bundle does not verify.** See [Export & verify an audit bundle](/pangolin/how-to/verify-audit-bundle/). |

The same check is available programmatically as `verifyBundle(bundle, { anchor })`,
exported canonically from `@quarry-systems/pangolin-core` (and re-exported from
`@quarry-systems/pangolin-orchestrator` for back-compat) for third parties who want
to re-verify a handed-over bundle in their own tooling.

:::note[Orchestrator-free standalone verifier]
An auditor who does **not** have the orchestrator can verify a bundle with the
zero-dependency `@quarry-systems/pangolin-verify` package — no install required:

```sh
npx @quarry-systems/pangolin-verify <bundle.json> [--anchor <verify-context.json>]
```

Offline (default) recomputes against the bundle's embedded root (ceiling
`tamper-detecting`); `--anchor <verify-context.json>` fetches the real WORM root
(ceiling `tamper-evident`). See
[Export & verify an audit bundle](/pangolin/how-to/verify-audit-bundle/#5-verify-without-the-orchestrator--quarry-systemspangolin-verify).
:::
