---
title: AgoraClient API
description: AgoraClient constructor options and the capabilities / subagent / env / dispatch namespaced surfaces.
sidebar:
  order: 3
---

`AgoraClient` (from `@quarry-systems/agora-client`) is the single caller-side
entry point integrators construct. The constructor validates the option shape
and holds the wired-in providers; namespaced sub-APIs
(`capabilities`, `subagent`, `env`, `dispatch`) are installed on the prototype
when the barrel is imported.

## Constructor options

```typescript
new AgoraClient(opts: AgoraClientOptions)
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
}
```

`capabilities` entries that are bare names are resolved against
`client.storage.resolveLatest`. `assign` re-registers the subagent under a new
capability set, producing a NEW pinned version (old and new coexist immutably).

`verify`, when set, declares a language-agnostic shell command the worker runs
over the agent's edit before sealing; its `{ passed, report, durationMs }` result
is recorded in the output sentinel and surfaced on the dispatch result. It is
report-only (a failed verify never fails the dispatch) and only present in the
stored definition when set (so subagents without it keep their content hash).
See [Dispatch lifecycle → Self-verify](/agora/reference/dispatch-lifecycle/#self-verify-optional).

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

## `client.dispatch`

`dispatch` is a **callable** with attached methods:

```typescript
client.dispatch(work: DispatchWork & ClientDispatchOpts): Promise<DispatchResult>
client.dispatch.fire(work: DispatchWork & ClientDispatchOpts): Promise<InFlightDispatch>
client.dispatch.describe(dispatchId: string): Promise<DispatchResult>
client.dispatch.cancel(dispatchId: string): Promise<void>
```

`ClientDispatchOpts` carries `workerImage: string` (required) and
`defaultDispatchTimeoutSeconds?: number`; the remaining fields (`subagent`,
`target`, `env`, `input`, `capabilities`, `addCapabilities`, `secrets`,
`callback`, `timeoutSeconds`, `retentionDays`, `resources`, `dispatchId`) come
from `DispatchWork`. `capabilities` REPLACES the subagent's assigned set;
`addCapabilities` APPENDS to it; combining both throws. See the
[Dispatch lifecycle](/agora/reference/dispatch-lifecycle/) for what happens
after the call.

## Bundled implementations

The barrel also exports default implementations: `StdoutResultSink`,
`NoopCredentialProvider`, `NoopTelemetryHook`, plus helpers
(`assertNoCredentialPattern`, `computeInlineSecretTtl`, `mintCallbackHmac`,
`signCallback`) and the `SecretStoreMismatchError` / `DispatchRecordExpiredError`
errors.
