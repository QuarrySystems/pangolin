---
title: PangolinClient API
description: PangolinClient constructor options and the capabilities / subagent / env / dispatch namespaced surfaces.
sidebar:
  order: 3
---

`PangolinClient` (from `@quarry-systems/pangolin-client`) is the single caller-side
entry point integrators construct. The constructor validates the option shape
and holds the wired-in providers; namespaced sub-APIs
(`capabilities`, `subagent`, `env`, `pipeline`, `dispatch`) are installed on
the prototype when the barrel is imported.

## Constructor options

```typescript
new PangolinClient(opts: PangolinClientOptions)
```

| Option | Type | Required | Notes |
|---|---|---|---|
| `namespace` | `string` | yes | Logical namespace for the registry. |
| `compute` | `Record<string, ComputeProvider>` | yes | Named compute providers. |
| `credentials` | `Record<string, CredentialProvider>` | yes | Named credential providers. |
| `storage` | `StorageProvider` | yes | Single storage backend. |
| `targets` | `Record<string, TargetConfig>` | yes | Logical dispatch targets. Each is validated at construction time — its `compute`, `credentials`, and (if set) `secretStore` names must all resolve, else the constructor throws. |
| `secretStores` | `Record<string, SecretStore>` | no | Per-target secret stores. Defaults to `{}` — there is **no implicit AWS store**. |
| `telemetry` | `TelemetryHook` | no | Lifecycle-event sink. |
| `resultSink` | `ResultSink` | no | Collects dispatch results. |
| `defaultModel` | `string` | no | Default model id. |
| `dispatchRetention` | `DispatchRetentionConfig` | no | `{ defaultDays?, maxDays? }`. `defaultDays` defaults to `30`; `maxDays` defaults to `2555` (~7 years, a hard ceiling). The constructor throws if `maxDays` exceeds the cap or if `defaultDays` exceeds `maxDays`. |

### `TargetConfig`

```typescript
interface TargetConfig {
  compute: string;        // name in `compute`
  credentials: string;    // name in `credentials`
  secretStore?: string;   // name in `secretStores`
  defaultResources?: { cpu?: number; memory?: number };
}
```

A target names the **isolation boundary** a dispatch runs inside — the
`compute` + `credentials` + `secretStore` tuple bounding what it can reach,
touch, and spend. It is not a scheduling hint.

Introduce a new target when the answer to *"what could this dispatch steal or
break?"* changes — a different effect tier (read-only analysis vs. holding
production write credentials), a different tenant's secret material, or a
genuinely different execution environment. Pin a single target otherwise;
carrying the same value for every dispatch is the seam that lets you split a
boundary later without touching call sites.

Do **not** split targets purely for queueing (that is the orchestrator's
`queues`) or for resource sizing (`DispatchWork.resources` overrides
`defaultResources` per dispatch). Two targets with identical `compute`,
`credentials`, and `secretStore` draw no boundary.

`target` is **not an authorization check** — the caller selects it freely and
the runtime validates only that the name resolves. A dispatch record states
which envelope a dispatch ran inside; it does not attest that the caller was
permitted to select it. See
[ADR-0019](/pangolin/explanation/decisions/0019-target-is-an-isolation-boundary/).

Targets are constructor-wired live provider instances, not content-addressed
registry artifacts, so they do not appear in `pangolin.config.yaml` and are not
reconciled by `pangolin deploy` — that manifest registers hashable content
(capabilities, subagents, envs).

Readonly fields after construction: `namespace`, `compute`, `credentials`,
`storage`, `targets`, `secretStores`, `telemetry`, `resultSink`,
`defaultModel`, and `retention` (resolved to `{ defaultDays, maxDays }`).

## `client.capabilities`

```typescript
register(opts: RegisterCapabilityOpts): Promise<CapabilityRef>
list(): Promise<CapabilityRef[]>
get(name: string): Promise<CapabilityRef | null>
```

`RegisterCapabilityOpts`: `{ name: string; files: Record<string, Uint8Array | string> }`
(extends `CredentialPatternCheckOpts`). `string` file values are UTF-8 encoded
and scanned for credential patterns; `Uint8Array` values pass through unscanned.
Throws `CapabilityTooLargeError` over 50 MiB, `CredentialsInEnvError` on a
credential-pattern match. Idempotent on identical content.

## `client.subagent`

```typescript
register(opts: RegisterSubagentOpts): Promise<SubagentHandle>
assign(handle: SubagentHandle, capabilities: Array<string | CapabilityRef>): Promise<SubagentRef>
list(): Promise<SubagentRef[]>
get(name: string): Promise<SubagentRef | null>
```

`RegisterSubagentOpts`:

```typescript
interface RegisterSubagentOpts {
  name: string;
  systemPrompt?: string;
  promptTemplate?: string;
  model?: string;
  capabilities?: Array<string | CapabilityRef>;  // bare names or full refs
  verify?: VerifyConfig;  // self-verify config (Gap A): { command: string; timeout?: number }
  contextRequires?: ContextRequirement[];  // observable workspace properties, verified pre-agent
}
```

`capabilities` entries that are bare names are resolved against
`client.storage.resolveLatest`. `assign` re-registers the subagent under a new
capability set, producing a NEW pinned version (old and new coexist immutably).

`model`, when set on the subagent definition, pins the preferred model for all
dispatches using this subagent (unless overridden at dispatch time — see
[`DispatchWork.model`](#model-field-and-level-vocabulary) below). The value
follows the same level vocabulary: reserved levels or provider-native ids.
Pin-optional — nothing fails if a subagent has no model field.

`verify`, when set, declares a language-agnostic shell command the worker runs
over the agent's edit before sealing; its `{ passed, report, durationMs }` result
is recorded in the output sentinel and surfaced on the dispatch result. It is
report-only (a failed verify never fails the dispatch) and only present in the
stored definition when set (so subagents without it keep their content hash).
See [Dispatch lifecycle → Self-verify](/pangolin/reference/dispatch-lifecycle/#self-verify-optional).

`contextRequires`, when set, lists observable properties the staged workspace
must satisfy before the agent runs — the worker checks them after
`pangolin-setup.sh` and before it captures the pre-agent baseline. An unmet
requirement fails the dispatch with `reason: 'worker-failed'`, and it is only
present in the stored definition when set (so subagents without it keep their
content hash, mirroring `verify`). Three kinds: `paths` (at least `minCount`
entries, default 1, match `glob` — **directories count, not only files**, so
`logs/**` is satisfied by an empty `logs/sub/`; require a file explicitly with
`logs/*.txt` when that matters), `exec` (`bin` resolves on the runtime `PATH`,
and must be executable), and `git` (`needs: 'worktree'` — a usable `.git`;
`needs: 'history'` — at least one commit). It cannot express "a patch was applied" or "workspace is
at revision X" — neither is observable without redoing the work, so it is
deliberately absent rather than an unreliable check. See
[Dispatch lifecycle](/pangolin/reference/dispatch-lifecycle/) for where the
check sits in the worker's step order.

## `client.env`

```typescript
register(opts: RegisterEnvOpts): Promise<EnvRef>
list(): Promise<EnvRef[]>
get(name: string): Promise<EnvRef | null>
```

`RegisterEnvOpts`:

```typescript
interface RegisterEnvOpts {
  name: string;
  values?: Record<string, string>;                       // non-secret; scanned
  secrets?: Record<string, SecretRef | InlineSecret>;     // { ref } | { inline }
  secretStore?: string;                                   // required if any inline secret
}
```

Inline secrets are staged via the named `SecretStore`; only the resulting
opaque ref is recorded in the bundle — the inline value never crosses into
storage.

## `client.pipeline`

```typescript
register(spec: PipelineSpec): Promise<PipelineRef>
```

Registers a declared block-pipeline spec (see
[Dispatch lifecycle → The block-pipeline runner](/pangolin/reference/dispatch-lifecycle/#the-block-pipeline-runner)).
The spec is structurally validated first — **collect-all**: every error is
surfaced in one throw, not just the first — then content-addressed over its
canonical-JSON (sorted-key) serialization and stored as a pinned immutable
version. Re-registering the identical spec is **idempotent**: the same content
hash returns the original `registeredAt` with no duplicate write; a *different*
spec under the same `id` produces a new pinned version, and both coexist
immutably.

```typescript
interface PipelineRef {
  id: string;            // '<pack>.<name>'
  registeredAt: string;  // storage-authoritative timestamp
  contentHash: string;   // sha256 over the canonical spec
}
```

A minimal `PipelineSpec` — one script block (the runner always auto-appends
the terminal `seal`; it is never authored):

```typescript
const ref = await client.pipeline.register({
  schemaVersion: 1,
  id: 'data.transform',
  blocks: [
    { kind: 'script', command: 'node transform.js', timeoutSeconds: 120 },
  ],
  outputEdgeType: 'dataset-ref',
});
```

`pipeline.list()` is still deferred — pipelines use a different on-store layout
(`pipeline/<id>@<hash>`) than the catalog types, so the `StorageProvider.listNames`
walk that now backs `capabilities` / `subagent` / `env` enumeration does not apply
to it. Use `pangolin pipeline register`'s printed ref (or a known id) in the meantime.

## `client.dispatch`

`dispatch` is a **callable** with attached methods:

```typescript
client.dispatch(work: DispatchWork & ClientDispatchOpts): Promise<DispatchResult>
client.dispatch.fire(work: DispatchWork & ClientDispatchOpts): Promise<InFlightDispatch>
client.dispatch.describe(dispatchId: string): Promise<DispatchResult>
client.dispatch.cancel(dispatchId: string): Promise<void>
```

:::caution[`describe` only sees reconciled dispatches]
`dispatch.describe` reads the dispatch record that `client.dispatch(...)`'s reconcile step
writes at the end of the call. A dispatch fired with `client.dispatch.fire(...)` alone and never
carried through `reconcile` writes no dispatch record, so `describe` can never see it —
`DispatchRecordExpiredError` is thrown, indistinguishable from a record that expired past
retention (see the [`describe` reference](https://github.com/quarrysystems/pangolin/blob/main/packages/pangolin-client/src/describe.ts)).
Fire-and-forget consumers that still want the dispatch's output should not poll `describe` —
read the worker-written output sentinel directly with `readOutputSentinel` from
`@quarry-systems/pangolin-product` instead (it needs only the dispatch id and namespace, not a
dispatch record). See [Dispatch lifecycle → Reading output after the fact](/pangolin/reference/dispatch-lifecycle/#reading-output-after-the-fact).
:::

`ClientDispatchOpts` carries `workerImage: string` (required) and
`defaultDispatchTimeoutSeconds?: number`; the remaining fields (`subagent`,
`target`, `env`, `input`, `capabilities`, `addCapabilities`, `secrets`,
`callback`, `timeoutSeconds`, `retentionDays`, `resources`, `dispatchId`,
`model`, `trace`) come from `DispatchWork`. `capabilities` REPLACES the subagent's
assigned set; `addCapabilities` APPENDS to it; combining both throws. See the
[Dispatch lifecycle](/pangolin/reference/dispatch-lifecycle/) for what happens
after the call.

`trace?: TraceContext` (`{ traceId: string; runId?: string; itemId?: string }`) is an
optional correlation context stamped onto every `LifecycleEvent` this dispatch emits and
into its dispatch record. Omit it for a standalone dispatch and the client defaults
`{ traceId: dispatchId }` (a single-dispatch trace); the orchestrator sets
`{ traceId: runId, runId, itemId }` for items it fires. It is correlation only (not OTel
spans) and is kept out of metric labels — see
[Correlation: the optional `trace` field](/pangolin/reference/dispatch-lifecycle/#correlation-the-optional-trace-field).

### `model` field and level vocabulary

`DispatchWork.model` is the authorized model level or provider-native id for
this one dispatch. It is **pin-optional** — nothing fails if you omit it.

The precedence chain (highest to lowest) is: `DispatchWork.model` >
the subagent definition's stored `model` field > the `DispatchExecutor`'s
configured `defaultModel` > unset (the runtime adapter's own default applies).
An empty string is treated the same as unset at each step.

#### Reserved level vocabulary

The three portable levels are the single home for model selection across
adapters. The claude-code adapter maps them to bare CLI aliases (version-free):

| Level | claude-code alias | Meaning |
|---|---|---|
| `fast` | `haiku` | Fastest, most cost-effective model tier |
| `standard` | `sonnet` | Balanced speed and capability |
| `max` | `opus` | Highest capability |

Any string that is **not** one of these three reserved levels is passed through
verbatim to the underlying provider as a provider-native id (e.g.
`claude-opus-4-5`, `gpt-4o`). A second adapter may define its own level
mapping independently.

## Bundled implementations

The barrel also exports default implementations: `StdoutResultSink`,
`NoopCredentialProvider`, `NoopTelemetryHook`, plus helpers
(`assertNoCredentialPattern`, `computeInlineSecretTtl`, `mintCallbackHmac`,
`signCallback`) and the `SecretStoreMismatchError` / `DispatchRecordExpiredError`
errors.
