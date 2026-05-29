---
id: spec-2026-05-21-agora-mvp-design
title: "Agora MVP — registry-backed dispatch SDK for sub-agent compute workloads"
type: spec
created: 2026-05-21
updated: 2026-05-21
wiki: _meta
status: draft
summary: "Caller-side SDK that lets integrators register versioned subagents, capabilities, and env bundles, then dispatch a containerized Claude Code sub-agent to a compute target by reference. Worker fetches registered artifacts at boot, overlays capabilities as filesystem layers, invokes the sub-agent, returns the result. Pluggable interfaces for compute, credentials, storage, channels, result sinks, and telemetry. Strict orthogonality: agora knows nothing about Stoa, Bedrock, RaState, or any other Quarry Systems library."
author: agent:claude-code
---

# Agora MVP — registry-backed dispatch SDK for sub-agent compute workloads

## 1. Purpose

Provide a focused SDK that lets an integrator's application build up a small library of **subagents** (named, versioned definitions of "what kind of agent runs"), **capabilities** (named, versioned filesystem bundles that give the agent skills, MCP servers, plugins, permission patches), and **env bundles** (named, versioned env-var + secret-ref bundles), then dispatch any combination of them to remote compute. The dispatched worker is a stock container image that fetches the referenced artifacts on boot, overlays capabilities onto its filesystem, invokes a Claude Code sub-agent, captures the result, and exits.

Two surfaces ship:

- **`agora-client`** — installed in the integrator's process. Registers artifacts, dispatches workers, observes results.
- **`agora-worker`** — runs inside the worker container. Resolves artifact refs against storage, overlays capabilities, spawns the sub-agent, exits with the sub-agent's exit code.

Pluggable interfaces are defined for compute provider, credential provider, storage provider, channel adapter, result sink, and telemetry hook. MVP ships exactly one default implementation per interface where one is shipped; for channel adapter and telemetry hook, no default implementation ships.

## 2. Non-goals

Agora is not:

- A queue. Workers do not poll an inbox. Each `dispatch()` call produces exactly one worker invocation.
- A workflow engine. Agora does not orchestrate steps, retries, branching, or fan-out. The sub-agent does whatever the prompt directs.
- A knowledge store. Work products live wherever the sub-agent's prompt directs (git remote, S3, integrator API). Agora does not store outputs beyond the lifecycle event trail.
- An authorization service. Integrators wrap `dispatch()` with their own auth/authorization layer if they want one.
- A multi-runtime agent host. MVP targets Claude Code exclusively as a scope decision, not an architectural one — the RuntimeAdapter seam (§5.8) exists so additional runtime adapters can be added without restructuring; MVP simply ships one.

Most critically: **agora has no awareness of Stoa, Bedrock, RaState, or any other Quarry Systems library.** No agora package depends on any other Quarry-Systems-namespaced package. Cross-SDK composition is the integrator's responsibility — they configure capability bundles, env bundles, and prompts that wire other SDKs into the sub-agent's runtime context.

### Scope charter

Agora's job is single-dispatch remote sub-agent execution with auditable immutable artifacts. Anything that requires inter-dispatch state, scheduling, fan-out, branching, retry policy, or workflow semantics is out of scope and belongs in an orchestrator layered above Agora. Future feature requests that would introduce these concerns require an explicit charter amendment in this section, documented in §10.1, before implementation. This is the discipline that prevents Agora from becoming "Temporal plus Kubernetes plus LangGraph"; the value of Agora is partly defined by what it refuses to do.

## 3. Architecture overview

```
[integrator app process]
   │
   │  agora.capabilities.register({...})     ─┐
   │  agora.subagent.register({..., capabilities: [...]})   ─┤  upload to storage
   │  agora.env.register({...})              ─┘
   │
   │  agora.dispatch({ subagent, env, input, target, capabilities? })
   ▼
[agora-client]
   │  1. resolves refs to content hashes
   │  2. resolves credentials via CredentialProvider
   │  3. selects ComputeProvider per target
   │  4. provider.run(taskSpec)
   ▼
[compute target — Fargate task / local Docker / future provider]
   │  container starts; CMD is agora-worker entrypoint
   ▼
[agora-worker]
   │  1. reads AGORA_DISPATCH_ID, AGORA_BUNDLE_REFS_JSON, AGORA_STORAGE_URI,
   │     AGORA_RUNTIME_ADAPTER from env; constructs RuntimeAdapter
   │  2. fetches subagent + capabilities + env bundle from storage
   │  3. verifies fetched content matches advertised content hashes
   │  4. emits "started" lifecycle event (via callback, if configured)
   │  5. overlays capability bundles onto worker filesystem (in declared order;
   │     adapter-reserved paths use adapter.mergeRules; else default rules)
   │  6. resolves env-bundle + per-dispatch secret refs to real values
   │  7. merges env-bundle values + resolved secrets into process env
   │  8. optionally subscribes to ChannelAdapter (if a capability bundle declared
   │     one via agora-channel.json)
   │  9. invokes runtimeAdapter.invoke({...}) — adapter renders prompt, spawns
   │     runtime binary, captures stdout/stderr, detects needs_input sentinel
   │  10. checks runtimeExit.needsInputSentinelPath; resolves to finished /
   │      needs_input / failed
   │  11. emits resulting lifecycle event
   │  12. exits with runtimeExit.exitCode (or 0 on valid needs_input)
   ▼
[agora-client]
   │  ResultSink.collect() returns DispatchResult; the dispatch() Promise resolves
```

Three things to flag explicitly:

1. **The audit anchor is the bundle ref set.** Every dispatch record captures `(subagent contentHash, capability contentHashes[], env contentHash)`. Regulated buyers ask "what was in scope for this dispatch?" and get a deterministic answer pointing at immutable artifacts.

2. **Capabilities are filesystem overlays.** Agora does not model "plugins," "MCP servers," or "skills" as distinct concepts. A capability is a directory tree that gets applied to the worker's filesystem before the runtime starts. Runtime-specific paths (for the MVP Claude Code adapter: `~/.claude/skills/foo/SKILL.md`, `~/.claude/settings.json`, etc.) are governed by the RuntimeAdapter's merge rules; everything else uses default last-write-wins. Agora's worker knows about paths and merge engines; the adapter knows about runtime-specific path conventions.

3. **Channel subscription is opt-in via capability content.** A capability that wants the worker to subscribe to an event channel includes a manifest file the worker entrypoint reads. The caller doesn't need to know channels are involved.

## 4. Caller API

The caller API splits into two strata with sharply different trust models:

- **Deploy-time API (privileged).** Operations that create or modify artifacts that will execute on a worker — `capabilities.register()`, `subagent.register()`, `subagent.assign()`, `env.register()`. These run from a human at a terminal (CLI) or a deploy pipeline (TypeScript code in CI). They handle secrets, define what the worker CAN do, and define what the worker IS. **They are never reachable through an AI tool surface.** See §7.7 for the rationale.
- **Run-time API (orchestration-safe).** Operations that compose pre-registered artifacts and dispatch workers — `dispatch()`, `dispatch.describe()`, `dispatch.cancel()`, plus read-only catalog lookups (`capabilities.list()`, `subagent.get()`, etc.) that return metadata only, never contents or secret values. These are safe to expose through `agora-mcp` for AI-driven orchestrators.

### 4.1 The three primitives

All three follow the same shape: `register()` returns an immutable ref; identical re-registration returns the existing ref (idempotent); changed content under the same name creates a new auto-versioned entry.

#### 4.1.1 Capabilities

```typescript
await agora.capabilities.register({
  name: string,                        // human handle, e.g. 'git-readonly'
  files: Record<string, Uint8Array | string>,
                                       // path → contents. Paths are relative to the
                                       // worker's overlay root (typically the agent
                                       // user's home: '.claude/skills/foo/SKILL.md',
                                       // '.claude/settings.json', etc.)
                                       // Total bundle size capped at 50 MiB;
                                       // throws CapabilityTooLargeError above that.
}): Promise<CapabilityRef>;

interface CapabilityRef {
  name: string;
  registeredAt: string;                // ISO 8601
  contentHash: string;                 // 'sha256:...'
}
```

#### 4.1.2 Subagents

```typescript
await agora.subagent.register({
  name: string,                        // 'code-reviewer'
  systemPrompt: string,                // optional if promptTemplate given
  promptTemplate?: string,             // Mustache-style; dispatch() supplies vars via `input`
  model?: string,                      // e.g. 'claude-sonnet-4-6'; falls back to client default
  capabilities?: Array<string | CapabilityRef>,
                                       // optional: assign capabilities at register time
}): Promise<SubagentHandle>;

interface SubagentHandle extends SubagentRef {
  assign(capabilities: Array<string | CapabilityRef>): Promise<SubagentRef>;
                                       // creates a NEW subagent version with the
                                       // updated assignment baked into its identity
}

interface SubagentRef {
  name: string;
  registeredAt: string;
  contentHash: string;                 // hashes (def fields + resolved capability hashes)
}
```

**Assignment semantics (load-bearing).** A subagent's identity is the bundle `(def fields + resolved capability hashes)`. Re-assigning capabilities creates a new subagent version with a new content hash — the previous version still exists, immutably. This is required for the audit story: pinning a dispatch to a specific subagent version pins everything it does.

#### 4.1.3 Env bundles

```typescript
await agora.env.register({
  name: string,                        // 'prod-aws'
  values?: Record<string, string>,     // visible env vars
  secrets?: Record<string, SecretRef | InlineSecret>,
}): Promise<EnvRef>;

type SecretRef = { arn: string };
interface InlineSecret {
  inline: string;
  /**
   * Override the auto-computed TTL. The SDK auto-computes:
   *   ttlSeconds = (dispatch.timeoutSeconds ?? 7200) + 300 (cleanup grace)
   * Use this field only when an explicit shorter lifetime is required (e.g.,
   * for compliance reasons). The auto-computed default covers all typical
   * dispatch durations without integrator sizing.
   */
  ttlSeconds?: number;
}

interface EnvRef {
  name: string;
  registeredAt: string;
  contentHash: string;                 // hash(values + secret refs); inline secrets
                                       // are staged separately and not included in the hash
}
```

The same env/secrets split applies inside an env bundle as applied in the previous design. `values` is enforced not to contain credential-shaped strings; the SDK throws `CredentialsInEnvError` at register time if it does.

### 4.2 Dispatch

```typescript
await agora.dispatch({
  subagent: string | SubagentRef,      // ref or short name
  env?: string | EnvRef | Array<string | EnvRef>,
                                       // optional; multiple bundles deep-merged later-wins
  capabilities?: Array<string | CapabilityRef>,
                                       // REPLACES the subagent's assigned capabilities
  addCapabilities?: Array<string | CapabilityRef>,
                                       // ADDS to the subagent's assigned capabilities,
                                       // appended after them (so they override on conflict)
  input?: Record<string, unknown>,     // variables for promptTemplate rendering;
                                       // ignored when subagent has only systemPrompt
  target: string,                      // key into AgoraClientOptions.targets
  dispatchId?: string,                 // caller-provided; auto-generated if omitted
  callback?: {
    url: string;
    signatureAlgorithm?: 'sha256';
  },
  /**
   * Dispatch-scoped operational notifications. Distinct from capability-content
   * notifications (`agora-notifications.json`): those are behavior-tied (the
   * capability author mandates alerts when the capability is in scope); these
   * are operational (the SRE team owns where alerts for this dispatch go).
   * Both flow through the same HMAC-signing path. The worker merges both
   * sources at boot.
   */
  notifications?: NotificationConfig[],
  /**
   * Per-dispatch secrets. Distinct from env-bundle secrets in lifecycle:
   * env-bundle secrets are part of a registered, content-hashed artifact
   * meant to be reused across many dispatches. Per-dispatch secrets are
   * ephemeral — minted per dispatch (typically a per-dispatch identity
   * token, a one-shot credential, an OAuth access token with short TTL)
   * and not part of any registry artifact's content hash.
   *
   * Both sources are staged through Secrets Manager and resolved by the
   * worker at startup. On key conflict, per-dispatch secrets win over
   * env-bundle secrets (last-write-wins; dispatch is "later" than env).
   *
   * The credential-pattern check applies here too: passing a credential-
   * shaped string as a plain value (not wrapped in `inline:` or `arn:`)
   * throws `CredentialsInEnvError` — by design, since these end up in
   * env at the worker exactly like env-bundle secrets do.
   */
  secrets?: Record<string, SecretRef | InlineSecret>,
  /**
   * How long the dispatch record (resolved refs, stdout, stderr, lifecycle
   * events, needs_input payload, failure detail) is retained after the
   * dispatch terminates. Bounded by the AgoraClient's configured
   * `dispatchRetention.maxDays`. Default is the client's `defaultDays`.
   * Set explicitly when a dispatch's audit lineage requires longer
   * retention than the client default.
   */
  retentionDays?: number,
  /**
   * Bounds total dispatch wall-clock time. Used by the compute provider
   * (Fargate task timeout) and by the SDK to size auto-computed secret
   * TTLs. Default: provider-specific (Fargate: 1 hour). Cap: 24 hours in MVP.
   */
  timeoutSeconds?: number,
  resources?: { cpu?: number; memory?: number },
}): Promise<DispatchResult>;

export interface NotificationConfig {
  /** Event kinds this notification fires on. */
  when: LifecycleEvent['kind'][];
  /** HTTPS webhook URL. */
  webhook: string;
}

interface DispatchResult {
  dispatchId: string;
  exitCode: number;
  stdout: string;                      // truncated above 4 MiB with explicit marker
  stderr: string;                      // truncated above 256 KiB
  durationMs: number;
  resolved: {
    subagent: SubagentRef;             // exact version + content hash that ran
    capabilities: CapabilityRef[];     // in applied order
    env?: EnvRef[];                    // in applied order
  };
  failure?: {
    reason: 'worker-failed' | 'provider-failed' | 'timeout' | 'cancelled' | 'fetch-failed' | 'integrity-failed';
    detail: string;
  };
  /**
   * Populated when the sub-agent indicated it needs clarification to continue
   * (see §6.9). Mutually exclusive with `failure`: a `needsInput` outcome is
   * recoverable, not a failure. The orchestrator routes the question, then
   * re-dispatches with the answer added to input.
   */
  needsInput?: {
    question: string;
    options?: string[];
    context?: string;
    partialState?: unknown;
  };
}
```

The `resolved` block on the result is the audit anchor. Even when the caller used short names (`subagent: 'code-reviewer'`), the resolved block carries exact content hashes that can be inspected later.

### 4.3 Auto-versioning model

- Names within an `AgoraClient`'s namespace are unique per primitive type. `capabilities/git-readonly` and `subagent/git-readonly` are distinct.
- Each `register()` call generates a `registeredAt` ISO timestamp and a `contentHash`.
- The registry stores, per `(type, name)`: an ordered list of `(registeredAt, contentHash)` entries.
- A re-register call with identical content (same canonical hash of fields) returns the existing entry; no new entry is created.
- A re-register with changed content creates a new entry; previous entries remain immutable.
- Resolving a short name (`'code-reviewer'`) picks the most recently registered entry under that name.
- Refs may include a timestamp (`'code-reviewer@2026-05-21T12:48:00Z'`) or a content hash (`'code-reviewer@sha256:abc...'`); both forms resolve to a specific entry.
- Cross-namespace addressing is deferred. MVP assumes one implicit namespace per `AgoraClient`. The storage layer keys things with a URI-shaped path (`agora://<namespace>/<type>/<name>/<contentHash>`) so future cross-namespace refs surface as a thin API addition without storage migration.

### 4.4 A worked Hello World

```typescript
import { AgoraClient } from '@quarry-systems/agora-client';
import { FargateProvider } from '@quarry-systems/agora-providers-fargate';
import { AwsCredentialProvider } from '@quarry-systems/agora-providers-aws-creds';
import { S3StorageProvider } from '@quarry-systems/agora-storage-s3';

const client = new AgoraClient({
  namespace: 'my-org',
  compute: { fargate: new FargateProvider({...}) },
  credentials: { aws: new AwsCredentialProvider() },
  storage: new S3StorageProvider({ bucket: 'my-org-agora-artifacts' }),
  targets: { 'fargate-prod': { compute: 'fargate', credentials: 'aws' } },
});

// Register a capability bundle.
await client.capabilities.register({
  name: 'git-write',
  files: {
    '.claude/settings.json': JSON.stringify({
      permissions: {
        allow: ['Bash(git:*)', 'Edit', 'Write', 'Bash(npm:*)'],
      },
    }),
  },
});

// Register a subagent with the capability assigned at register time.
await client.subagent.register({
  name: 'code-reviewer',
  systemPrompt: 'You are a careful code reviewer who edits and pushes branches.',
  capabilities: ['git-write'],
  model: 'claude-sonnet-4-6',
});

// Register an env bundle.
await client.env.register({
  name: 'prod',
  values: { LOG_LEVEL: 'info' },
  secrets: {
    CLAUDE_API_KEY: { inline: process.env.CLAUDE_API_KEY! },
    GH_TOKEN: { inline: process.env.GH_TOKEN! },
  },
});

// Dispatch.
const result = await client.dispatch({
  subagent: 'code-reviewer',
  env: 'prod',
  input: { repoUrl: 'https://github.com/my-org/repo', issueId: 123 },
  target: 'fargate-prod',
});

console.log(result.resolved);  // exact content hashes that ran
```

### 4.5 Deploy manifest (CLI-driven registration)

For CI pipelines and team workflows, the privileged registrations are typically declared in a YAML manifest checked into a deploy repo, then reconciled by `agora deploy --from agora-manifest.yaml`. The manifest is one file per agora namespace:

```yaml
# agora-manifest.yaml
namespace: my-org

capabilities:
  - name: git-write
    from: ./caps/git-write/                # directory contents become the bundle
  - name: language-server-tools
    from: ./caps/language-server-tools/

subagents:
  - name: code-reviewer
    from: ./subagents/code-reviewer.yaml   # YAML with systemPrompt, model, etc.
    capabilities: [git-write, language-server-tools]
  - name: pdf-summarizer
    from: ./subagents/pdf-summarizer.yaml

envs:
  - name: prod
    values:
      LOG_LEVEL: info
      AGORA_SETUP_TIMEOUT_SECONDS: '180'
    secrets:
      CLAUDE_API_KEY:
        arn: arn:aws:secretsmanager:us-east-1:123:secret:claude-api-key-AbCdEf
      GH_TOKEN:
        from_env: GH_TOKEN                 # read at deploy time from the CLI's env;
                                           # staged inline into Secrets Manager
  - name: staging
    extends: prod                          # inherit; override below
    values:
      LOG_LEVEL: debug
```

**Deploy semantics:**

- The reconciler iterates manifest entries top-to-bottom. Capabilities first, then subagents (which reference capabilities), then envs.
- Each entry is registered via the same SDK `register()` path. Idempotent re-register applies: identical content returns the existing ref without bumping; changed content auto-bumps to a new version.
- `extends:` on env entries shallow-merges values + secrets from the parent. Useful for dev/staging/prod variations.
- `from_env:` on a secret resolves at deploy time from the CLI's process env, then stages as an inline secret. Useful for CI where credentials live in the CI environment, not in the manifest.
- Failure mode: if any artifact's registration fails, the deploy halts. Previously-registered artifacts remain (no rollback semantics in MVP). The integrator fixes the manifest and re-runs; idempotent re-register makes this safe.
- Subagent `capabilities:` reconciliation: if the manifest assigns `[git-write, language-server-tools]` and the registry currently shows the subagent assigned `[git-write]`, the reconciler issues a `subagent.assign()` call to align (creating a new subagent version).

**Manifest-vs-registry semantics — important and intentionally non-Terraform-shaped:**

The manifest declares what *should exist* in the registry. The registry is **append-only**: removing an entry from the manifest does NOT delete it from the registry. Older versions remain immutably available. This is a deliberate deviation from `kubectl apply` / `terraform apply` "manifest is source of truth, drift gets reconciled both directions" semantics — agora's audit guarantee relies on artifact immutability, so deletion is not part of the deploy flow.

Practical consequences:
- Removing a capability from the manifest stops new deploys from referring to it, but the artifact and any historical dispatch records that referenced it remain queryable.
- Reverting to an older version is `extends:` plus version pinning, not "edit and re-apply."
- The "current set" of artifacts in use is derivable from the latest manifest + the latest dispatch records, not from registry contents alone.

**Capability hygiene over time.** Old capability versions accumulate indefinitely (per §11 deferred items). For now, integrators with audit-storytelling concerns ("what's the active capability set?") should adopt their own tagging convention in capability names (`git-write-2026-q2`, `git-write-deprecated`) and prune via documentation rather than registry deletion. A `agora export-manifest` CLI command that re-renders the current registry state as a manifest, plus formal deprecation/archival semantics, are on the v0.2 roadmap.

The CLI also supports per-artifact subcommands for ad-hoc registration outside the manifest flow:

```bash
agora capabilities register --name git-write --from ./caps/git-write/
agora subagent register --name code-reviewer --from ./subagents/code-reviewer.yaml
agora subagent assign code-reviewer --capabilities git-write,language-server-tools
agora env register --name prod --secret CLAUDE_API_KEY=arn:...
agora capabilities list
agora subagent get code-reviewer
agora dispatch --subagent code-reviewer --env prod --input '{"repoUrl":"..."}' --target fargate-prod
agora dispatch describe <id>
agora dispatch cancel <id>
```

### 4.6 The agora-mcp tool surface

`@quarry-systems/agora-mcp` is an MCP server wrapping `AgoraClient`. It exposes **only the run-time, orchestration-safe operations** — never the privileged register/assign operations. Six tools:

| MCP tool name | Maps to | Notes |
|---|---|---|
| `agora_dispatch` | `client.dispatch()` | Accepts refs by name; references must exist in the registry already |
| `agora_dispatch_describe` | `client.dispatch.describe()` | Returns lifecycle state, resolved content hashes, **and captured stdout/stderr from the dispatch**. Rationale: the orchestrator already saw stdout via the original `dispatch()` call's `DispatchResult`; exposing it via describe surfaces the same information for later retrieval without forcing the orchestrator to retain it. Same data, same trust boundary. |
| `agora_dispatch_cancel` | `client.dispatch.cancel()` | Best-effort; idempotent |
| `agora_capabilities_list` | `client.capabilities.list()` | Returns names + content hashes + registeredAt; never file contents |
| `agora_subagents_list` | `client.subagent.list()` | Returns names + content hashes + assigned capability names; never system prompt body |
| `agora_envs_list` | `client.env.list()` | Returns names + content hashes; never secret values or `values` map contents |

No `register`, no `assign`, no `get` operation that returns sensitive bodies. The orchestrator agent can compose dispatches from the existing catalog but cannot mutate the catalog.

Transport: stdio in MVP, mirroring Stoa's pattern. Future HTTP transport is v0.2+.

Authentication: agora-mcp reads AWS credentials from the standard credential chain (same as agora-client). The MCP server inherits the privileges of whoever launched it — there is no separate auth between the orchestrator and agora-mcp. Locking down who can launch agora-mcp is the integrator's IAM concern.

## 5. Pluggable interfaces

All interfaces in `@quarry-systems/agora-core` (types-only). Default impls in separate provider packages.

### 5.1 ComputeProvider

```typescript
export interface ComputeProvider {
  readonly name: string;
  run(spec: TaskSpec, ctx: ProviderContext): Promise<TaskHandle>;
  awaitExit(handle: TaskHandle, ctx: ProviderContext): Promise<TaskExit>;
  cancel?(handle: TaskHandle, ctx: ProviderContext): Promise<void>;
}

export interface TaskSpec {
  image: string;                       // digest-pinned OCI image
  env: Record<string, string>;         // includes AGORA_* worker-config vars
  secretRefs: Record<string, string>;  // env-name → provider-resolvable reference
  command?: string[];
  resources?: { cpu?: number; memory?: number };
  dispatchId: string;
}

export interface ProviderContext {
  credentials: ResolvedCredentials;
  telemetry?: TelemetryHook;
}

export interface TaskHandle { providerTaskId: string; }

export interface TaskExit {
  exitCode: number;
  startedAt: Date;
  finishedAt: Date;
  stdout: string;
  stderr: string;
  providerFailureReason?: string;
}
```

**MVP impls:** `@quarry-systems/agora-providers-fargate`, `@quarry-systems/agora-providers-local-docker`.

### 5.2 CredentialProvider

```typescript
export interface CredentialProvider {
  readonly name: string;
  resolve(): Promise<ResolvedCredentials>;
}

export interface ResolvedCredentials {
  kind: string;                        // 'aws', 'gcp', 'none', ...
  [key: string]: unknown;
}
```

**MVP impls:** `@quarry-systems/agora-providers-aws-creds`. `NoopCredentialProvider` (bundled with agora-client) for the local-docker case.

### 5.3 StorageProvider

The registry's persistence layer. Used by `agora-client` for `register()` (write) and by `agora-worker` for artifact fetch (read).

```typescript
export interface StorageProvider {
  readonly name: string;
  /**
   * Write a blob keyed by a structured URI. Caller passes the URI; the provider
   * is responsible for translating to its backend (S3 key, FS path, etc.).
   * Returns the content hash the provider computed during write (must match
   * what the caller computed independently).
   */
  put(uri: string, contents: Uint8Array): Promise<{ contentHash: string }>;

  /**
   * Read a blob by URI. Verification of the blob against expected contentHash
   * happens on the caller side (worker), not in the provider.
   */
  get(uri: string): Promise<Uint8Array>;

  /**
   * Resolve the latest content hash for a given (type, name) path within a
   * namespace. Implementations maintain a small index alongside blob storage.
   */
  resolveLatest(uri: string): Promise<{ uri: string; contentHash: string; registeredAt: string } | null>;

  /**
   * List all entries for a given (type, name) path, ordered by registeredAt desc.
   */
  list(uri: string): Promise<Array<{ uri: string; contentHash: string; registeredAt: string }>>;
}
```

URI shape: `agora://<namespace>/<type>/<name>/<contentHash>` for blobs, `agora://<namespace>/<type>/<name>` for the resolve/list operations.

**MVP impls:**
- `@quarry-systems/agora-storage-s3` — backs blobs by S3 objects, maintains an index in a separate S3 prefix (small JSON files), uses S3 conditional writes for atomicity on the index.
- `@quarry-systems/agora-storage-local` — backs blobs by a local directory tree. Used by `LocalDockerProvider` (worker container mounts the host directory) and by the test suite.

### 5.4 ChannelAdapter

```typescript
export interface ChannelAdapter {
  readonly name: string;
  subscribe(config: ChannelConfig): AsyncIterable<ChannelMessage>;
}

export interface ChannelConfig {
  channel: string;
  opts?: Record<string, unknown>;
}

export interface ChannelMessage {
  id: string;
  body: string;
  ts: string;
}
```

**MVP impls:** none. Defining the interface; integrators bring their own. Adapter implementations live in the worker image, not in the client (the client has no knowledge of channels — that's a worker-side concern). See §6.8 for the full integration walkthrough.

### 5.5 TargetConfig

Data, not an interface — a config profile selecting compute + creds for a named deployment target.

```typescript
export interface TargetConfig {
  compute: string;                     // key into AgoraClientOptions.compute
  credentials: string;                 // key into AgoraClientOptions.credentials
  defaultResources?: { cpu?: number; memory?: number };
}
```

`dispatch({ target: 'fargate-prod' })` looks up `targets['fargate-prod']`. Channel adapters are not part of the target config — they live in the worker image and are resolved at the worker, not the client. See §6.8.

### 5.6 ResultSink

```typescript
export interface ResultSink {
  readonly name: string;
  collect(handle: TaskHandle, exit: TaskExit, ctx: SinkContext): Promise<DispatchResult>;
}

export interface SinkContext {
  dispatchId: string;
  resolved: DispatchResult['resolved'];
  telemetry?: TelemetryHook;
}
```

**MVP impl:** `StdoutResultSink` (bundled with agora-client).

### 5.7 TelemetryHook

```typescript
export interface TelemetryHook {
  readonly name: string;
  emit(event: LifecycleEvent): void;
}

export type LifecycleEvent =
  | { kind: 'dispatch.accepted'; dispatchId: string; target: string; resolved: DispatchResult['resolved']; at: string }
  | { kind: 'dispatch.started'; dispatchId: string; providerTaskId: string; at: string }
  | { kind: 'dispatch.finished'; dispatchId: string; exitCode: number; durationMs: number; at: string }
  | { kind: 'dispatch.needs_input'; dispatchId: string; durationMs: number; at: string }
  | { kind: 'dispatch.failed'; dispatchId: string; reason: string; at: string }
  | { kind: 'dispatch.cancelled'; dispatchId: string; at: string };
```

**MVP impl:** `NoopTelemetryHook` (bundled with agora-client). The vocabulary is **closed at six for MVP, extensible at minor versions**. Integrators implementing custom telemetry hooks MUST handle unknown event kinds gracefully (log and skip; do not throw) so future event kinds can land without breaking existing consumers. The contract: existing kinds keep their field shape; new kinds are additive.

### 5.8 RuntimeAdapter

The seam that lets agora support agentic runtimes other than Claude Code without restructuring the worker. The worker owns runtime-agnostic concerns (bundle fetch, integrity verification, overlay engine, secret resolution, env merge, setup-script execution, channel subscription, notification firing, lifecycle event emission); the adapter owns everything that knows about a specific runtime (prompt rendering, runtime binary invocation, runtime-specific filesystem conventions and merge rules, runtime-specific permission/plugin/MCP machinery, runtime-specific needs_input signaling).

```typescript
export interface RuntimeAdapter {
  readonly name: string;
  /**
   * Filesystem paths the adapter owns. The capability overlay engine
   * consults this list to know which paths are governed by the adapter's
   * mergeRules rather than the default last-write-wins.
   */
  reservedPaths: string[];
  /**
   * Merge rules for adapter-specific files. Map of glob-pattern → rule.
   * Worker overlay engine applies these only to paths in reservedPaths.
   */
  mergeRules?: Record<string, MergeRule>;
  /**
   * Render the prompt and invoke the runtime binary. The adapter is
   * responsible for: prompt template substitution, runtime spawn,
   * stdout/stderr capture, and detecting whether the runtime indicated
   * a needs_input outcome. Returns RuntimeExit.
   */
  invoke(spec: RuntimeInvocation, ctx: RuntimeContext): Promise<RuntimeExit>;
}

export interface RuntimeInvocation {
  systemPrompt?: string;
  promptTemplate?: string;
  input?: Record<string, unknown>;
  model?: string;
  workspaceDir: string;
}

export interface RuntimeContext {
  dispatchId: string;
  /** The merged process env at invocation time (env-bundle values + resolved secrets). */
  env: Record<string, string>;
  /** Optional telemetry hook the adapter may use for runtime-internal events. */
  telemetry?: TelemetryHook;
}

export interface RuntimeExit {
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * When set, the adapter is signaling that the runtime indicated a
   * needs_input outcome and the sentinel payload is at this path. The
   * worker reads + parses it per §6.9 and surfaces as DispatchResult.needsInput.
   * When unset, the worker proceeds by exitCode (0 → finished, non-zero → failed).
   */
  needsInputSentinelPath?: string;
}

export type MergeRule =
  | { strategy: 'last-write-wins' }
  | { strategy: 'deep-merge'; arrayMode?: 'union' | 'replace' | 'concat' }
  | { strategy: 'array-union' };
```

**MVP impl:** `@quarry-systems/agora-runtime-claude-code`. Implements the adapter for Claude Code:

- `reservedPaths`: `['.claude/settings.json', '.claude/skills/**', 'agora-plugins.json']`
- `mergeRules`:
  - `.claude/settings.json` → `{ strategy: 'deep-merge', arrayMode: 'union' }`
  - `.claude/skills/**` → `{ strategy: 'last-write-wins' }` (per skill directory)
  - `agora-plugins.json` → `{ strategy: 'array-union' }`
- `invoke`:
  - Renders the prompt: if `promptTemplate`, applies Mustache substitution with `input`; otherwise uses `systemPrompt` verbatim.
  - If `agora-plugins.json` is present after overlay, runs `claude plugins install <name>` for each entry before spawning.
  - Spawns `claude --print "<rendered>"` with `cwd: workspaceDir` and `env: ctx.env`. Captures stdout/stderr.
  - After exit, checks `${workspaceDir}/.agora/needs_input.json` for the sentinel; sets `needsInputSentinelPath` if present.
- Ships the `agora-needs-input-helper` content (a SKILL.md at `.claude/skills/agora-needs-input/SKILL.md` teaching the sentinel convention to Claude Code). The adapter overlays this onto the workspace before integrator capabilities unless `AGORA_DISABLE_NEEDS_INPUT_HELPER=true`.

**Adapter selection.** The worker selects an adapter at boot based on the `AGORA_RUNTIME_ADAPTER` env var (e.g., `claude-code`). The image bundles one adapter by default (Claude Code); integrators wanting different runtimes use a worker image that bundles their chosen adapter and sets the env var accordingly.

**Future adapter implementations** (Codex, Gemini CLI, custom harnesses) are deferred to v0.2+. The seam exists in MVP; only additional adapters are out of scope.

**Event payloads are deliberately low-sensitivity.** Lifecycle events carry state and low-cardinality identifiers (dispatch id, provider task id, exit code, reason enum, duration, ISO timestamp). They do NOT carry potentially-sensitive content like the rendered prompt, the `question` body from a `needs_input` outcome, captured stdout, or capability file contents. Consumers needing those payloads call `agora_dispatch_describe` (which returns them within the same trust boundary as the original `DispatchResult`). Rationale: events flow to N observers (TelemetryHook, primary callback URL, every notification webhook); the question body might contain filenames, code excerpts, or business logic that doesn't belong in every downstream observer's logs. The `dispatch.failed` event follows the same discipline (`reason` is a closed enum; the longer `detail` lives in `DispatchResult.failure`, not in the event). A future minor version may add an optional `questionPreview: string` (truncated, opt-in) if integrators consistently report wanting a lightweight UX hint without fetching describe; the additive shape preserves the closed-at-six commitment.

### 5.9 SecretStore (ENVStore)

The pluggable backend for secret material. The caller-side SDK *stages* inline secrets and the per-dispatch callback HMAC key here at register/dispatch time; the worker *resolves* refs back to values at boot. Resolution authority lives in the worker — all secret values (env-bundle and per-dispatch) pass through `resolve`, giving the worker a single chokepoint to register each value for log redaction before the sub-agent runs (§7.1).

```typescript
export interface SecretStore {
  readonly name: string;
  stage(args: { name: string; value: string; ttlSeconds: number; tags?: Record<string, string> }): Promise<{ ref: string; ttlSeconds: number }>;
  resolve(ref: string): Promise<string>;
  cleanupByTag(tagKey: string, tagValue: string): Promise<void>;   // best-effort
}
```

The `ref` is opaque and store-specific (callers never parse it): a Secrets Manager ARN for the AWS adapter, a `local-secret://<id>` URI for the local adapter. Because the ref is path-independent, the local adapter resolves correctly across the host→container boundary — the client and worker each construct a store over their own view of the same (bind-mounted) directory.

**MVP impls** (`@quarry-systems/agora-secret-store`):
- `AwsSecretStore` — AWS Secrets Manager. `ttlSeconds` is recorded as the `agora:ttlSeconds` tag (Secrets Manager has no native TTL; `cleanupByTag` or a sweeper reclaims). Used with S3 storage / Fargate.
- `LocalSecretStore` — per-secret files (mode 0600) under a private scratch dir, with sidecar tag metadata for `cleanupByTag`. Used with `file://` storage / `LocalDockerProvider`. The scratch dir MUST NOT be the registry/storage root — unlike the registry (which holds only secret *references*), this store holds plaintext secret *values* on disk.

**Store selection** is by storage scheme: `file://` storage ⇒ `LocalSecretStore`; otherwise `AwsSecretStore`. The client picks the store when staging per-dispatch secrets and, for the local store, passes the scratch dir to the worker via `AGORA_SECRET_STORE_DIR` (§6.1); the worker selects the matching store at boot.

## 6. Worker contract

The worker is distributed as both `@quarry-systems/agora-worker` (npm) and a published OCI image (`ghcr.io/quarry-systems/agora-worker:<digest>`).

### 6.1 Environment variables consumed

| Name | Required | Purpose |
|---|---|---|
| `AGORA_DISPATCH_ID` | yes | Opaque id. Used in lifecycle events and logs. |
| `AGORA_NAMESPACE` | yes | Namespace under which to resolve storage URIs. |
| `AGORA_STORAGE_URI` | yes | The storage backend the worker reads from (e.g. `s3://bucket-name`). Provider-specific format. |
| `AGORA_BUNDLE_REFS_JSON` | yes | JSON: `{ subagent: { uri, contentHash }, capabilities: [...], env: [...] }`. |
| `AGORA_INPUT_JSON` | no | JSON for prompt-template variable substitution. |
| `AGORA_CALLBACK_URL` | no | HTTPS URL for lifecycle event POSTs. |
| `AGORA_CALLBACK_TOKEN_REF` | no | Secret ref for the HMAC callback-signing key. Required iff callback URL set. |
| `AGORA_PER_DISPATCH_SECRET_REFS_JSON` | no | JSON `{ envName: ref }` of per-dispatch secret refs (§4.2). The worker resolves and registers these for redaction itself, rather than the compute layer injecting them ambiently (which would escape redaction). Empty/absent when the dispatch carried no per-dispatch secrets. |
| `AGORA_SECRET_STORE_DIR` | no | For the local secret store: the in-container directory `LocalSecretStore` resolves `local-secret://` refs from (bind-mounted by `LocalDockerProvider`). Absent for the AWS path. See §5.9. |

Plus integrator-defined vars merged in from env bundles — but only after the worker→runtime env firewall (§7.9) strips its own control-plane (`AGORA_*`) and ambient AWS credential variables.

### 6.2 Lifecycle

1. Boot: parse `AGORA_*` env. Construct storage provider from `AGORA_STORAGE_URI`. Construct the configured RuntimeAdapter (per `AGORA_RUNTIME_ADAPTER`, default `claude-code`).
2. Fetch subagent, capabilities, env bundles per `AGORA_BUNDLE_REFS_JSON`. **Verify each blob's SHA-256 matches the advertised `contentHash`.** Any mismatch fails the dispatch with `reason: 'integrity-failed'` before runtime invocation.
3. Emit `dispatch.started` if callback configured.
4. Overlay capability bundles onto worker filesystem in declared order. The adapter's `agora-needs-input-helper` content is overlaid first (unless `AGORA_DISABLE_NEEDS_INPUT_HELPER=true`). Conflict resolution: paths in `adapter.reservedPaths` use the adapter's `mergeRules`; everything else uses default last-write-wins. Agora-defined manifests (`agora-channel.json`, `agora-setup.sh`, `agora-notifications.json`) have their own merge rules documented in §6.3.
5. Resolve all secret refs to real values via the `SecretStore` (§5.9) — env-bundle secrets (from each env-bundle blob's `secretRefs`) and per-dispatch secrets (from `AGORA_PER_DISPATCH_SECRET_REFS_JSON`, §4.2). Each resolved value is registered with the structured logger so it is redacted from worker logs (§7.1). Throw `SecretResolutionError` if any ref fails; this fails the dispatch with `reason: 'fetch-failed'`.
6. Merge env into the value handed to the runtime: start from the worker's own `process.env` **with the §7.9 firewall applied** (control-plane `AGORA_*` and ambient AWS credential vars stripped), then overlay env-bundle values + all resolved secrets. On key conflict between an env-bundle secret and a per-dispatch secret, per-dispatch wins (last-write-wins; dispatch is logically "later" than the env bundle it composes with). A firewalled var can be deliberately re-supplied by an env bundle, which is merged on top.
7. If any capability bundle included `agora-setup.sh`, execute it with the merged env. Bounded by `AGORA_SETUP_TIMEOUT_SECONDS` (default 120). Non-zero exit fails the dispatch.
8. If any capability bundle includes a `agora-channel.json` manifest naming an adapter present in the worker image, construct the channel adapter (which can now read fully-resolved env vars) and start the channel subscription as a background task.
9. Invoke `runtimeAdapter.invoke({ systemPrompt, promptTemplate, input, model, workspaceDir }, ctx)`. The adapter renders the prompt, spawns the runtime binary, captures stdout/stderr, detects whether the runtime indicated a needs_input outcome, and returns `RuntimeExit`. The worker treats the runtime call as opaque — it does not interpose on tool calls, does not parse stdout for runtime-specific signals, does not know how the adapter implements prompt rendering or runtime invocation.
10. Tear down channel subscription if active.
11. Check `runtimeExit.needsInputSentinelPath`. Three outcomes:
    - **Path set, file present and valid** (parses as JSON with a non-empty `question` field, and `partialState` serializes to ≤1 MiB): populate `DispatchResult.needsInput`. Outcome event kind is `dispatch.needs_input` (not `dispatch.finished`).
    - **Path set, file present but malformed or oversized** (unparseable JSON, missing `question`, or `partialState` >1 MiB serialized): fail the dispatch with `reason: 'worker-failed'`, detail naming the specific failure (`'malformed needs_input sentinel at <path>'` or `'needs_input sentinel partialState exceeds 1 MiB cap'`). Do not attempt to recover.
    - **Path unset:** proceed by `runtimeExit.exitCode` (0 → `dispatch.finished`, non-zero → `dispatch.failed` with `reason: 'worker-failed'`).
12. Fire all notification handlers (from both `agora-notifications.json` capability content AND the dispatch-time `notifications` field, §4.2) whose `when` filter matches the resulting event kind.
13. Emit the resulting event (`dispatch.finished`, `dispatch.needs_input`, or `dispatch.failed`) to the primary callback URL.
14. Exit with `runtimeExit.exitCode` (or 0 if needs_input sentinel was valid, regardless of `exitCode`).

### 6.3 Capability overlay and merge semantics

Capabilities are filesystem trees applied in order by the worker's overlay engine. The engine consults the configured `RuntimeAdapter` for adapter-specific paths and merge rules; everything else uses default rules or agora-defined manifest rules.

**Default rule for regular files:** last-write-wins (later capability replaces earlier).

**Adapter-reserved paths.** Any path matching one of `runtimeAdapter.reservedPaths` is merged per the adapter's `mergeRules` instead of the default. For the MVP `ClaudeCodeRuntimeAdapter`, this includes:

- `.claude/settings.json` → deep-merge (objects recurse, arrays set-union preserving order, scalars last-write-wins, type conflicts fail the dispatch with `reason: 'integrity-failed'`).
- `.claude/skills/<name>/SKILL.md` → last-write-wins per skill directory. Two capabilities defining the same skill name → the later one wins. Integrators that need composable skills use distinct names.
- `agora-plugins.json` → array-merge (set-union), then the adapter runs `claude plugins install <name>` for each entry before runtime spawn.

Future RuntimeAdapter implementations declare their own `reservedPaths` and `mergeRules`; the worker's overlay engine applies them generically.

**Agora-defined manifest rules** (runtime-agnostic; same across all adapters):

- **`agora-channel.json`:** last-write-wins. Only one channel subscription per dispatch in MVP.
- **`agora-setup.sh`:** last-write-wins. Worker executes the script after overlay completes and before runtime invocation. Bounded by a per-dispatch timeout (default 120 seconds; integrator can override via `AGORA_SETUP_TIMEOUT_SECONDS`). Non-zero exit fails the dispatch with `reason: 'worker-failed'`. Captured stdout/stderr included in the worker's structured logs.
- **`agora-notifications.json`:** array-merge (set-union). Each entry declares a `when` filter against lifecycle event kinds (`dispatch.started`, `dispatch.finished`, etc.) and a `webhook` URL. Worker POSTs the matching event payload to each configured URL using the same HMAC signing scheme as the primary callback (per-dispatch token staged into Secrets Manager). Multiple notifications fire in parallel; a single failed delivery does not block others or fail the dispatch.

The overlay step is deterministic and runs to completion before runtime invocation. If overlay fails, the dispatch fails before any runtime token is consumed.

The merge rules above are intentionally conservative — set-union for arrays, fail-loudly on type conflicts, last-write-wins as the default — because deep capability stacking has real opacity risk. Integrators stacking five or more capabilities that touch overlapping files should expect the `agora capability explain` and `agora subagent explain` tooling (v0.2, see §11) to be useful for debugging effective overlay order, effective filesystem mutations, and effective adapter-specific configuration.

### 6.4 Sub-agent runtime

The worker delegates runtime invocation to the configured `RuntimeAdapter` (§5.8). Runtime-specific knowledge — which binary, how to render the prompt, how to detect needs_input, how to merge runtime-specific configuration files — lives in the adapter, not in the worker. MVP ships one adapter (`@quarry-systems/agora-runtime-claude-code`) and the stock worker image's `AGORA_RUNTIME_ADAPTER` defaults to `claude-code`.

For the MVP Claude Code adapter specifically: the adapter invokes `claude --print "<rendered prompt>"` with the workspace directory as cwd and the merged process env (env-bundle values + resolved secrets) as the runtime's env. Claude Code reads its model credentials from env (`CLAUDE_API_KEY`, `ANTHROPIC_API_KEY`, or AWS Bedrock credentials per the integrator's env bundle).

The worker does not interpose on the sub-agent's tool calls — that's between the runtime and its host environment. The worker does not impose its own timeouts; the compute provider's task timeout is authoritative.

### 6.5 File-editing and code-modifying workloads

The worker filesystem is ephemeral. There is no `AGORA_REPO_URL` and no built-in "clone before exec" step. Code-editing dispatches work the same way any remote CI agent edits code:

1. Integrator places a git credential (`GH_TOKEN`) in an env bundle's `secrets`.
2. Integrator's subagent prompt directs Claude Code to clone, edit, commit, and push to a remote branch (conventional name: `agora/dispatch-${AGORA_DISPATCH_ID}`).
3. Claude Code uses its bash + Edit/Write tools. The branch lands on the remote before the worker exits.
4. After the worker exits, the integrator handles the branch (open a PR, run CI, etc.).

Agora has no opinion on workspaces, branches, or post-dispatch branch handling. The pattern is emergent from the sub-agent's existing capabilities + a capability bundle granting `Bash(git:*)` + `Edit` + `Write` permissions.

Ephemeral storage sizing is governed by `resources` on the dispatch; for repos with large working trees or builds, integrators size appropriately.

### 6.6 Image hardening defaults

The stock `agora-worker` image ships with opinionated defaults. These split into runtime-agnostic worker concerns (in the table below) and adapter-specific concerns (documented in the adapter — for the MVP Claude Code adapter, see the `@quarry-systems/agora-runtime-claude-code` README).

**Worker-level hardening (runtime-agnostic):**

| Lever | Stock default | How to override |
|---|---|---|
| Container user | `agora` (non-root, uid 1000) | Custom worker image with different user |
| Root filesystem | Read-only mount | Custom worker image; `/workspace` and `/tmp` remain writable |
| Network egress | Governed by compute provider's network policy; agora does not configure | Configure security group / VPC rules per target |
| Runtime adapter selection | `AGORA_RUNTIME_ADAPTER=claude-code` (the only MVP adapter) | Set env var to a different adapter name bundled in a custom worker image |
| `agora-needs-input-helper` overlay | Always overlaid before any integrator capabilities. Content is adapter-provided (for Claude Code: a SKILL.md at `.claude/skills/agora-needs-input/SKILL.md` teaching the sentinel-file convention from §6.9). | Set `AGORA_DISABLE_NEEDS_INPUT_HELPER=true` in the dispatch's env to suppress the adapter's helper-overlay step |

**Adapter-level hardening (Claude Code adapter, MVP):**

| Lever | Stock default | How to override |
|---|---|---|
| Default Claude Code permissions | Read-only Bash patterns + Read + Glob + Grep + WebFetch | Capability bundle adds an Edit/Write allowance to `.claude/settings.json` |
| MCP servers | None pre-configured | Capability bundle adds MCP config to `.claude/settings.json` |
| `claude plugins install` at runtime | Allowed via `agora-plugins.json` manifest entries only | Custom worker image to disable, or capability bundle to add plugin entries |
| `claude mcp add` at runtime | Blocked (binary path inaccessible to sub-agent) | Custom worker image to re-enable |

Future runtime adapters will have their own hardening tables analogous to the second one above. The split makes it explicit which defaults are agora-architectural (worker-level) and which are runtime-policy decisions (adapter-level) that future adapters get to make independently.

The integrator's contract is: **build the smallest capability bundle set that gets the dispatch what it needs, and rely on the stock image's defaults for everything else.** For a "summarize this PDF" dispatch the integrator might not register any capabilities at all (read-only Bash and file ops + WebFetch suffice). For "fix the bug and push" the integrator registers a `git-write` capability that adds the right permissions and `GH_TOKEN` resolution.

### 6.7 Observability defaults

The stock `agora-worker` image emits a specific, documented set of signals at known destinations. This section is the contract a regulated buyer's security review will reference.

**What the worker emits by default:**

| Signal | Destination | Content |
|---|---|---|
| Worker structured logs | stdout (JSONL, one event per line) | Lifecycle stages, fetched bundle refs + content hashes, overlay decisions, setup-script outcome, sub-agent exec start/exit, secret-resolution outcomes (refs only, never values) |
| Sub-agent stdout / stderr | stdout / stderr, prefixed with `[claude]` | Interleaved with worker structured logs so the compute provider's log driver captures both. Also captured for `DispatchResult.stdout` / `.stderr`. Captured output is truncated above **4 MiB stdout / 256 KiB stderr** with an explicit marker (e.g., `\n...stdout truncated at 4 MiB. Full output not retained.\n`) appended at the truncation point. The compute provider's full log stream is unaffected — only the `DispatchResult` payload is capped. Integrators needing full output instruct the sub-agent to write to S3 or to a known file and echo only a pointer to stdout. |
| Primary lifecycle events | `AGORA_CALLBACK_URL` if configured | HMAC-signed POSTs of the six `dispatch.*` event kinds |
| Notification events | URLs in `agora-notifications.json` if any capability declares them | HMAC-signed POSTs to N additional targets, filtered by `when` |
| In-process telemetry | Caller's registered `TelemetryHook` | Same six event kinds, emitted in the agora-client process |

**Where the default destinations route to:**

- **Fargate target:** stdout / stderr flow to CloudWatch Logs via the task definition's `awslogs` driver. Log group + retention are integrator-configured per task def. Lifecycle events post to whatever URL the integrator gave; notifications same.
- **Local-docker target:** stdout / stderr flow to `docker logs` per the local daemon. Lifecycle events post to localhost URLs (typical dev pattern).

**What is NOT emitted by default:**

- The rendered prompt content. The sub-agent's prompt may contain instructions or context the integrator considers sensitive (proprietary review criteria, customer-specific guidance). Worker structured logs reference the subagent by `(name, contentHash)` only.
- Secret values. The worker's structured logger redacts any value present in the env bundle's resolved `secrets` map, replacing matches with `<redacted:secret>` before emission. Names of secret env vars are emitted (so integrators can debug "did the secret resolve?") but values are not. **Caveat:** redaction is by literal-string match against resolved secret values. Sub-agents that transform secrets before emitting them (e.g., signing a request body with a secret-derived HMAC, base64-encoding an API token, computing a token-derived hash) bypass the literal-string match — the transformed value will not be redacted. Integrators whose sub-agents do secret-derived transforms should treat the transformed values as potentially logged and avoid emitting them to stdout.
- Capability bundle contents (the actual file bytes). Capability bundles surface as `(name, contentHash, applied-at-index)` in logs.
- Sub-agent internal reasoning traces. Claude Code's own debug logs (model thinking, internal tool dispatch decisions) live in `~/.claude/logs/` during execution and disappear at worker exit. Integrators who want these capture them via a capability bundle that adds a log-shipping configuration to `.claude/settings.json`, or by writing them to `/workspace/.agora/` and having the sub-agent echo a pointer to stdout.

**Integrator extension points for richer observability:**

1. **TelemetryHook** — for in-process integration with OpenTelemetry, CloudWatch Metrics, DataDog, etc. Receives the same five lifecycle events the worker emits.
2. **`agora-notifications.json` capability content** — for N independently-routed webhooks per event kind. Suitable for Slack alerts on failure, PagerDuty on integrity failures, etc.
3. **Verbose Claude Code logging via capability** — `.claude/settings.json` fragment that enables Claude Code's own verbose logging modes, plus an `agora-setup.sh` that configures a log shipper sidecar or pipes the logs to a known destination before exec.
4. **Custom log enrichment via capability** — `agora-setup.sh` can wrap the worker's stdout through a log enrichment process (e.g., adding trace IDs from the integrator's request that triggered the dispatch).

**The integrator's audit story:** the dispatch result's `resolved` block records exact content hashes for subagent, capabilities, and env bundles. Combined with the compute provider's task records (start/stop time, exit code, captured stdout/stderr) and the lifecycle event POST trail, every dispatch is replayable from immutable artifacts. A regulated buyer's "what ran, when, with what authority, producing what output" question maps to: `(resolved.subagent.contentHash, resolved.capabilities[].contentHash, resolved.env[].contentHash, providerTaskId, callback event log, sub-agent stdout in DispatchResult)`.

### 6.8 Channel adapters in practice

The ChannelAdapter interface (§5.4) lets a dispatch subscribe to an event source during execution. This section is the end-to-end wiring: how an integrator adds channel support to their worker, how a capability declares a subscription, and how the sub-agent sees messages.

**Where adapter implementations live.** Adapters are worker-image concerns, not client concerns. The stock `agora-worker` image ships with zero adapters. Integrators who want channel subscription extend the image with their adapter code:

```dockerfile
FROM ghcr.io/quarry-systems/agora-worker:<digest>
COPY ./my-sqs-adapter /opt/agora/adapters/sqs/
# adapters/<name>/index.js exports a function returning a ChannelAdapter instance
```

The worker entrypoint enumerates `/opt/agora/adapters/` at boot, loading each subdirectory as a named adapter. Adapter names must be unique within the image.

**Declaring a subscription via capability content.** A capability bundle includes an `agora-channel.json` file:

```json
{
  "adapter": "sqs",
  "channel": "https://sqs.us-east-1.amazonaws.com/123456789012/my-queue",
  "opts": { "waitTimeSeconds": 20, "maxMessages": 10 }
}
```

The `adapter` field names an adapter that must exist in the worker image. The `channel` field is whatever the adapter's `subscribe()` expects as the channel identifier. The `opts` block is the adapter's configuration knob — opaque to agora, interpreted by the adapter.

**Subscription lifecycle.**

- After capability overlay, env merge, and setup-script execution (worker lifecycle step 8 in §6.2), if any capability bundle laid down `agora-channel.json`, the worker constructs the named adapter (by looking it up in `/opt/agora/adapters/`) and starts the subscription as a background task. Ordering is deliberate: the adapter constructor runs after env is fully resolved so it can read env vars (AWS creds, channel URLs) populated by the env bundle.
- If the adapter name is not present in the worker image, the dispatch fails with `reason: 'worker-failed'` before sub-agent exec. This is intentional: missing-adapter is a setup error, not a transient runtime concern.
- The subscription runs concurrently with the sub-agent.
- On sub-agent exit (or dispatch failure / cancellation), the worker calls the iterator's `return()` method to signal close, then awaits the adapter's cleanup with a 10-second timeout.

**How messages are made available to the sub-agent.** The worker writes each incoming message as one JSONL line to `/workspace/.agora/channel/inbox.jsonl`:

```jsonl
{"id":"msg-1","body":"...","ts":"2026-05-21T14:00:00Z"}
{"id":"msg-2","body":"...","ts":"2026-05-21T14:00:05Z"}
```

The path is documented and stable. The sub-agent's prompt or a capability's instructions direct Claude Code to read or watch this file using its bash and file-read tools. Agora does not interpose; it just makes messages available at a known location.

This pattern means the sub-agent and the channel listener are loosely coupled: the listener fills the file regardless of whether the sub-agent reads it; the sub-agent reads at whatever cadence makes sense for its task. A polling sub-agent uses `tail -f` (or sleep + cat). A one-shot sub-agent reads the file once when it needs context.

**Why not pipe messages into the sub-agent directly?** Two reasons. First, Claude Code in `--print` mode has no streaming-stdin contract that's friendly to inter-process push — stdin gets consumed at process start. Second, the file pattern is interpretable by the sub-agent's existing tool surface (bash, Read) without requiring the agora SDK to know about Claude Code's internals. The pattern composes; agora stays orthogonal.

**Cancellation via channel.** Some integrators want channel messages to terminate the dispatch. Two ways to wire this:

1. **Sub-agent reads inbox, decides to terminate.** Prompt tells the sub-agent: "if any inbox message has `body.type === 'cancel'`, complete your current step and exit." Soft cancellation, sub-agent in control. No agora support needed.
2. **Adapter sends SIGTERM to the worker.** An adapter implementation can write to a known control file (`/workspace/.agora/control/terminate`) that the worker entrypoint monitors. On observation, the worker sends SIGTERM to the sub-agent. Hard cancellation. Requires the adapter to be authored with this behavior — not the default.

For MVP, only path (1) is documented and tested. Path (2) is an integrator pattern, supported by the worker's existing SIGTERM handling but not surfaced as a first-class agora primitive.

**Constraints in MVP.**

- One channel subscription per dispatch (the merge rule on `agora-channel.json` is last-write-wins, not array-merge — single subscription only).
- No outbound message sending from the worker via the adapter. Adapters are receive-only in MVP. A sub-agent that wants to send messages does so via its own bash/network tools.
- Adapter failure during execution (network outage, expired credentials, etc.) emits a structured log entry but does not fail the dispatch — the sub-agent continues with whatever messages it has already received.
- **No inbox file rotation or truncation.** The worker appends to `/workspace/.agora/channel/inbox.jsonl` indefinitely; integrators expecting high-volume channels should size `resources.memory` and ephemeral storage accordingly, or have the adapter rate-limit ingestion. Default Fargate ephemeral storage (20 GiB) accommodates most workloads; pathological cases need explicit storage configuration in the task definition.
- **SIGTERM-based hard cancellation (path 2 above).** If an adapter writes to `/workspace/.agora/control/terminate`, the worker entrypoint observes the file (poll interval: 1 second), sends SIGTERM to the sub-agent process, waits a 10-second grace period for the sub-agent to flush state and exit, then sends SIGKILL if still running. The grace period matches the compute provider's typical stop-grace contract so the worker exits before the provider hard-kills the container. Adapter authors implementing this pattern should plan for the 10-second grace window in their semantics.

Multi-subscription, bidirectional adapters, and adapter-mediated structured cancellation are all v0.2+ topics.

### 6.9 The `needs_input` convention (sub-agent asking for clarification)

A sub-agent that hits ambiguity mid-task — "I could change function A or function B; which?" — should not guess. The MVP pattern for handling this is **request-stop-restart**, not in-flight ask. The sub-agent exits with a structured response indicating it needs input; the orchestrator (Claude Code agent via agora-mcp, or TypeScript code) routes the question to the right answerer (a human via Slack, another agent, a database lookup) and re-dispatches with the answer added to input.

**The convention.**

A sub-agent that needs input writes a sentinel file at a documented path before terminating its response:

```
/workspace/.agora/needs_input.json
```

With this structured content:

```json
{
  "question": "The bug could be in src/foo.ts:42 or src/bar.ts:17. Which one should I fix?",
  "options": ["src/foo.ts:42", "src/bar.ts:17"],
  "context": "<freeform body the sub-agent considers relevant for the answerer>",
  "partial_state": { }
}
```

`question` is required. `options` is optional (use when the question is a constrained choice). `context` is optional (freeform context the answerer might need). `partial_state` is optional (freeform structure the orchestrator will pass back as input on the resumed dispatch).

**Why a sentinel file rather than an exit code.**

Exit codes are pollutable — signals, OS quirks, the sub-agent's tool subprocesses, and the runtime's own non-interactive exit behavior can all produce non-zero exits unrelated to the sub-agent's intent. A sentinel file is a documented contract: the sub-agent's write-capable tool (Claude Code's `Write` for the MVP adapter; equivalent for future adapters) produces the file deliberately, and the runtime adapter detects its presence after the runtime exits regardless of exit code. The file's existence is the authoritative signal; its contents are the payload. The worker trusts the adapter's `RuntimeExit.needsInputSentinelPath` to know whether the file was present.

**Worker resolution rule (in lifecycle step 11, see §6.2):**

```
runtimeExit = await runtimeAdapter.invoke({...})

if runtimeExit.needsInputSentinelPath is set:
    parsed = try_parse_json(runtimeExit.needsInputSentinelPath)
    serialized_partial_state_size = byte_length(canonical_json(parsed.partial_state))
    if parsed is valid JSON
       AND parsed.question is a non-empty string
       AND serialized_partial_state_size ≤ 1 MiB:
        → DispatchResult.needsInput = parsed
        → emit dispatch.needs_input (recoverable outcome)
        → exit cleanly with code 0
    else:
        → DispatchResult.failure = { reason: 'worker-failed',
                                     detail: 'malformed or oversized needs_input sentinel...' }
        → emit dispatch.failed
        → exit with runtimeExit.exitCode
else if runtimeExit.exitCode == 0:
    → completed; DispatchResult.needsInput = undefined
    → emit dispatch.finished
else:
    → DispatchResult.failure = { reason: 'worker-failed', detail: '...' }
    → emit dispatch.failed
```

Malformed sentinel is treated as a worker failure, not silently as "no needs_input." A sub-agent that wrote the file but produced garbage content is broken; the integrator needs to see that.

**`partial_state` size cap.** When the worker parses the sentinel, it serializes the `partial_state` field to canonical JSON and measures the byte length. If serialized size exceeds **1 MiB**, the dispatch fails with `reason: 'worker-failed'`, detail `'partial_state exceeds 1 MiB cap (got <N> bytes); persist large state externally and pass a reference'`. The cap fires at dispatch-1 end, not at dispatch-2 start, so the orchestrator sees the failure immediately rather than at re-dispatch attempt time. Integrators with larger continuity needs (multi-megabyte analysis trees, full file contents) write the bulk to S3 (or any integrator-controlled storage) and put only a pointer in `partial_state`. The error type surfaced through `DispatchResult.failure` is `PartialStateTooLargeError`.

**Where the sub-agent learns the convention.** The convention itself is agora-level (sentinel file at a documented path), but the content that teaches the sub-agent about it is **adapter-provided**. Each RuntimeAdapter ships an `agora-needs-input-helper` content payload appropriate to its runtime, and the worker overlays the adapter's helper content before any integrator capabilities.

For the MVP `ClaudeCodeRuntimeAdapter`, the helper content is a single Claude Code skill at `.claude/skills/agora-needs-input/SKILL.md`. The skill body embeds the convention instruction and the sentinel path constant:

> *If you cannot proceed without clarification from the operator, do not guess. Write a JSON file to `/workspace/.agora/needs_input.json` with the shape `{question, options?, context?, partial_state?}`. Then stop generating. The dispatch will be paused and resumed with the operator's answer threaded into your input on the next dispatch.*

The SKILL.md form is deliberate for this adapter. Claude Code's skill discovery enumerates `.claude/skills/<name>/SKILL.md` files and surfaces them to the sub-agent's tool reasoning; multiple skills compose without conflict. An integrator's other system-prompt-touching capabilities (other skills, `.claude/settings.json` fragments) coexist with the helper without merge conflict, because no two capabilities collide on the same skill name. Future adapters for other runtimes are responsible for choosing the equivalent format for their runtime's instruction surface (Codex's prompt mechanism, Gemini CLI's configuration, etc.) and reporting the sentinel path via `RuntimeExit.needsInputSentinelPath`.

The helper is **always applied by default** so the convention is present without integrator effort. Integrators who want different behavior set `AGORA_DISABLE_NEEDS_INPUT_HELPER=true` in the dispatch's env (visible config), which suppresses the adapter's helper-overlay step regardless of which adapter is in use. Most integrators benefit from the convention without thinking about it; the rare integrator who wants to handle clarification differently has an explicit knob.

### 6.9.1 The "prior reasoning as partial_state" pattern

A specific pattern worth elevating because it's load-bearing for resume quality: sub-agents that emit substantial prior reasoning as part of `partial_state` give the resumed sub-agent enough context to skip re-doing analytical work. The resumed sub-agent reads the prior reasoning and continues the analytical thread, not the workspace-fetching work.

Recommended `partial_state` shape for analytical continuity:

```json
{
  "considered_options": ["src/foo.ts:42", "src/bar.ts:17"],
  "ruled_out": [
    {"option": "src/baz.ts:9", "reason": "doesn't match symptom"}
  ],
  "tentative_conclusions": {
    "fix_approach": "single-line guard before the existing condition"
  },
  "remaining_work": [
    "apply fix",
    "run tests",
    "commit and push branch"
  ]
}
```

The resumed dispatch receives this in `input.partial_state` (along with the operator's answer in `input.answer`). The subagent's system prompt — typically extended by an `agora-needs-input-helper` companion capability — instructs it to read `partial_state` on resume and pick up from where the prior dispatch left off.

This is what makes the request-stop-restart pattern (Shape A in §6.9 rationale) competitive with snapshot-resume (Shape B, deferred) for most use cases: most of the work is in the analysis, and the analysis can be passed as data without snapshot machinery.

**DispatchResult shape extension:**

```typescript
interface DispatchResult {
  // ... existing fields ...
  needsInput?: {
    question: string;
    options?: string[];
    context?: string;
    partialState?: unknown;
  };
}
```

When `needsInput` is populated, the orchestrator's responsibility is to:

1. Route the question to an answerer (UI prompt, Slack message, internal logic).
2. Once an answer is in hand, call `dispatch()` again with the same subagent + capabilities + env, this time with input enriched by `{ answer, partial_state: result.needsInput.partialState }`.
3. The subagent's prompt is responsible for reading `input.answer` and `input.partial_state` on the resumed dispatch and continuing from there.

**Why not in-flight ask?**

The alternative — sub-agent pauses mid-execution, asks via a bidirectional channel, waits for the answer, continues — was considered and deferred. Three reasons:

1. **Cost.** Long-running blocked workers continue to bill on Fargate while waiting on a human reply. Request-stop-restart releases the worker between asks.
2. **Mechanism cost.** In-flight ask requires bidirectional channel adapter machinery, a sub-agent–reachable `ask()` primitive (MCP server in the worker, or a known file-IPC pattern), correlation, timeout, cancellation. Substantial.
3. **Snapshot-resume is not a free win.** A more aggressive variant — pause the worker, snapshot its state, exit, resume from snapshot on answer — was also considered. Snapshot preserves the worker's analytical state but does not eliminate cold-start (Fargate spin-up still happens on resume). The implementation cost (workspace tarball, Claude session restore via `--resume`, session format coupling) is not justified by the cold-start-elimination story.

The hybrid that gets most of snapshot-resume's value at low cost: have the sub-agent emit its full prior reasoning (alternatives considered, sub-conclusions reached) as part of `partial_state` or `context`. The resumed sub-agent reads the prior reasoning and continues the analytical thread. No snapshot machinery; minimal duplication of work.

These are all deferred (§11): in-flight ask, snapshot-resume, and a future ConversationAdapter interface that would generalize bidirectional human-in-the-loop interaction.

## 7. Security contract

### 7.1 The env/secrets split

`values` in env bundles is for visible config. `secrets` is for ARN references or inline values the SDK stages via the `SecretStore` (§5.9). Agora-client validates `values` (and capability file contents) at register time against credential-shaped patterns. Match throws `CredentialsInEnvError`. Per-bundle opt-out via `allowCredentialPatterns: string[]` for the rare false positive. The patterns cover AWS access/session-key prefixes, JWT shape, common bearer-token prefixes, GitHub tokens, and the API-key families most likely to be fat-fingered into a Claude Code worker's config: Anthropic (`sk-ant-`), OpenAI (`sk-`), Google (`AIza`), Slack (`xox[baprs]-`), Stripe (`sk_live_`/`rk_live_`), and PEM private-key armor. The scanner is heuristic defense-in-depth, not a guarantee — it raises the floor against the obvious mistakes.

**Inline secrets are NOT part of the env bundle's content hash, and they do NOT live in the registry.** When the integrator passes an inline secret to `env.register()`, the SDK stages it via the `SecretStore` (Secrets Manager in cloud, a local file store for local-docker — §5.9; with the auto-computed TTL from §7.6) and stores only the resulting REFERENCE as part of the env bundle's content. The bundle's content hash covers the visible `values` map and the secret references, not the secret VALUES themselves. A regulated buyer asking "what secret value was used for dispatch X" receives the ref — they then correlate it against their own secret-store audit trail (CloudTrail, rotation history, etc.) for the value's lineage. Agora's audit story stops at the ref boundary; the secret-value lineage is the integrator's secret-management system's responsibility.

**Secret-value redaction is complete at the worker.** Every secret value the worker resolves — env-bundle secrets *and* per-dispatch secrets — is registered with the structured logger (along with the callback HMAC key) so it is masked (`<redacted:secret>`) in the worker's log stream, including captured setup-script output and truncated failure detail. This is why per-dispatch secret refs travel to the worker via `AGORA_PER_DISPATCH_SECRET_REFS_JSON` (§6.1) and are resolved *by the worker* rather than injected ambiently by the compute layer: ambient injection would put values in the worker's environment that it never sees as secrets and therefore cannot redact.

### 7.2 Bundle integrity

Every fetched artifact (subagent, capability, env bundle) is verified at the worker against the content hash advertised in `AGORA_BUNDLE_REFS_JSON`. Mismatch fails the dispatch before any sub-agent invocation. This protects against tampering at the storage layer (e.g., compromised S3 bucket) — if someone swaps a capability blob, the hash check fires.

Content hashes are also recorded in the dispatch result and the `dispatch.accepted` lifecycle event, so the audit trail can be cross-referenced against storage independently.

### 7.3 Callback signing

When `callback.url` is configured, the SDK mints a per-dispatch HMAC key, stages it in Secrets Manager with a TTL matching the expected dispatch duration, and passes the secret ARN to the worker as `AGORA_CALLBACK_TOKEN_REF`. The worker signs every callback POST:

```
X-Agora-Signature: sha256=<hex>
X-Agora-Dispatch-Id: <uuid>
X-Agora-Timestamp: <iso>

body_hmac = HMAC-SHA256(key, dispatchId + "." + timestamp + "." + payload)
```

Integrators reject events older than 5 minutes for replay protection.

**One per-dispatch key signs all notification targets in MVP.** The primary callback URL, every `agora-notifications.json` capability-content webhook, and every dispatch-level `notifications` webhook receive POSTs signed with the same HMAC key. This is fine when the integrator owns or trusts all webhook endpoints. It is NOT fine when one of the destinations is third-party — possession of the key by any one recipient grants the ability to forge events to all others. Integrators consuming third-party capability bundles that declare their own notification webhooks should review the destinations before deploying. Per-destination keys are v0.2+.

### 7.4 Image pinning

`FargateProvider` and all future ComputeProviders MUST be configured with a digest-pinned image. Passing `:latest` throws `UnpinnedImageError` unless the integrator passes `allowUnpinnedImage: true` (dev only).

### 7.5 Storage IAM

Agora-client needs write access to the storage prefix. Worker task IAM needs read access to the same prefix.

Recommended setup (Fargate + S3):

- Caller IAM role has `s3:PutObject`, `s3:GetObject`, `s3:ListBucket` on the artifact bucket.
- Worker task role has `s3:GetObject` on the artifact bucket (read-only) and `secretsmanager:GetSecretValue` on per-dispatch-tagged secrets.
- Bucket policy enforces deny on unauthorized principals.

Cross-account scenarios are deferred to v0.2 along with cross-namespace addressing.

### 7.6 Cancellation and TTL

`AgoraClient.cancel(dispatchId)` is best-effort. The provider's stop semantics apply; for Fargate that's `StopTask` with a SIGTERM grace period. The worker traps SIGTERM, attempts to emit `dispatch.cancelled`, releases channel subscriptions, and exits.

Inline secrets are deleted after `awaitExit` returns regardless of cancellation, via the `SecretStore` (§5.9): `cleanupByTag('agora:dispatchId', <id>)` for AWS, or removal of the per-dispatch scratch dir for the local store. The TTL is auto-computed by the SDK from the dispatch's timeout (`(dispatch.timeoutSeconds ?? 7200) + 300` seconds cleanup grace), so integrators don't size it themselves. If the client fails catastrophically before it can clean up, the recorded TTL is the backstop (Secrets Manager auto-deletes the staged secret; the local store's files are short-lived scratch). Explicit `ttlSeconds` overrides apply only when integrators need a shorter compliance-driven lifetime.

### 7.7 Privileged operations are never reachable through an AI tool surface

This is the load-bearing security principle of the deploy-time / run-time split (§4).

**The underlying principle, stated once:** anything that defines what a worker IS, what it CAN DO, or what it has access to is set by humans (or human-reviewed CI). Anything that composes existing artifacts at run-time can be set by orchestrators (human or AI). The three categories below are illustrations of the same principle, not three independent rules.

Operations that create or modify executable artifacts on a worker are **privileged** and only available through the CLI or TypeScript code:

- `capabilities.register()` — defines what the worker CAN do (bash permissions, MCP configs, setup scripts).
- `subagent.register()` / `assign()` — defines what the worker IS (system prompt, model selection, assigned capability set).
- `env.register()` — handles secrets (API keys, credentials) routed through Secrets Manager.

These are **never exposed through `agora-mcp`** and never callable by an LLM. The rationale:

1. **Prompt injection on capability content.** An AI agent that can register capabilities can be tricked (via repo content, document text, or other reasoning-context contamination) into registering a capability that allows dangerous bash patterns, configures a malicious MCP server, or runs an attacker-controlled setup script. The capability defines the worker's authority surface; that authority is set by humans (or human-reviewed CI), not by LLMs.

2. **Prompt injection on subagent prompts.** A registered subagent's system prompt becomes the instruction set every dispatched worker runs. An AI registering a subagent could embed injection payloads that propagate to every future dispatch using that subagent.

3. **Secret exfiltration on env registration.** Even if the SDK redacts secret values in tool-call output, the LLM saw them at register time. Tool-call payloads land in conversation history, transcripts, model logs. The risk is unavoidable if `env.register()` is AI-reachable.

The orchestrator agent's role is **composition over an existing catalog**, not catalog mutation. It picks subagents and capabilities by name, dispatches workers, observes results. The catalog is pre-provisioned by humans or CI pipelines (deploy manifest from §4.5).

This pattern mirrors the AWS IAM model: lambdas don't create their own execution roles; an admin provisions roles and lambdas reference them. The agora pattern is the same — artifacts are provisioned, dispatches reference them.

### 7.8 Dispatch record retention

A dispatch produces records the integrator may need later: the `resolved` content hashes, captured stdout/stderr, lifecycle event log, `needsInput` payload (if applicable), and `failure` detail (if applicable). Retention of these records is configurable, with regulated-industry use cases in mind (construction projects span 18-36 months; litigation retention is often 7-10 years).

**The retention contract:**

| Knob | Where | Default | Cap |
|---|---|---|---|
| `dispatchRetention.defaultDays` | `AgoraClientOptions` | `30` | `2555` (~7 years) |
| `dispatchRetention.maxDays` | `AgoraClientOptions` | `2555` (~7 years) | n/a — this IS the cap |
| `dispatch().retentionDays` (override) | `DispatchWork` | client's `defaultDays` | client's `maxDays` |

```typescript
export interface AgoraClientOptions {
  // ... existing fields ...
  dispatchRetention?: {
    defaultDays?: number;   // default: 30
    maxDays?: number;       // default: 2555 (7 years)
  };
}
```

**What's retained:** the full dispatch record — `resolved.subagent`, `resolved.capabilities`, `resolved.env`, captured `stdout` (subject to the 4 MiB cap), captured `stderr` (subject to the 256 KiB cap), lifecycle events (all six kinds), `needsInput` payload if applicable, `failure` block if applicable, provider task id, dispatch's own timestamps.

**What's NOT retained:**
- Inline secret values (never persisted in dispatch records; only ARNs are recorded).
- Capability or subagent contents at any point (only their content hashes; the integrator fetches contents from the registry separately if needed).
- Full provider log streams (CloudWatch's retention applies independently; agora doesn't duplicate).
- The rendered prompt content (only the subagent's content hash + the input variables that were substituted).

**Storage model:** dispatch records live in the `StorageProvider` (the same one used for the registry), under a separate prefix (`agora://<namespace>/dispatches/<dispatchId>/`). The S3-backed provider uses S3 object lifecycle policies tagged with `agora:retention-days` to expire records at the specified retention. The local-fs-backed provider implements expiry via a simple periodic sweep.

**Expiry behavior:** after retention expires, the full record is purged. `dispatch.describe(expiredDispatchId)` throws `DispatchRecordExpiredError`. The integrator's own audit log (separate from agora's dispatch record) is the source of truth for "did this dispatch exist" beyond the retention window — typical pattern is to record the `dispatchId + resolved.subagent.contentHash + resolved.capabilities[].contentHash + resolved.env[].contentHash` in the integrator's database at dispatch time, so the metadata persists even after agora purges the record.

**Per-dispatch override:** a single dispatch can extend retention beyond the client's `defaultDays` (up to `maxDays`) by setting `retentionDays` on the dispatch. Typical use: a routine dispatch uses the 30-day default; a litigation-relevant submittal review sets `retentionDays: 2555` (full 7 years) at the orchestrator's discretion.

**Why this lives in agora, not in the integrator's database.** The dispatch record is content-addressed to immutable registry artifacts (subagent, capabilities, env bundles). Keeping it adjacent to the registry — same `StorageProvider`, same namespace, same expiry-aware tooling — means the audit story composes from one storage backend. If retention lived in the integrator's database, every integrator would rebuild the same plumbing (object storage + lifecycle policies + expiry semantics + capacity planning). Centralizing it in agora is the smaller burden.

### 7.9 Worker→runtime environment firewall

§7.7 keeps privileged *operations* off the AI surface. This is the complementary control for the worker's *identity*: the env handed to the sub-agent runtime is not the worker's raw `process.env`.

The worker boots with its own environment — the Agora control plane (`AGORA_*`, including `AGORA_CALLBACK_TOKEN_REF`, the bundle refs, the storage URI) and the ambient AWS task-role credential chain it uses to fetch bundles and resolve secrets. Handing that wholesale to the runtime would let a prompt-injected sub-agent (the same threat §7.7 takes seriously) read the callback HMAC reference or — worse — assume the worker's task role to reach other tenants' bundles and secrets.

So before the merge in §6.2 step 6, the worker strips from the base env:

- every `AGORA_*` control-plane variable (the worker has already consumed them), and
- the ambient AWS credential-vending variables: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, `AWS_CONTAINER_CREDENTIALS_FULL_URI`, `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_ARN`. (`AWS_REGION`/`AWS_DEFAULT_REGION` are config, not credentials, and survive.)

Everything else the runtime legitimately needs (PATH, HOME, locale, arbitrary user vars) survives. Credentials the sub-agent genuinely requires — including AWS credentials, when that is the deliberate intent — are supplied **explicitly via an env bundle**, which is merged on top of the firewalled base; the sub-agent's authority is thus declared by humans (an env bundle is a deploy-time artifact, §4) rather than inherited ambiently from the worker.

## 8. Packages and dependency direction

```
@quarry-systems/agora-core                       (types-only)
   ▲
   ├── @quarry-systems/agora-client              (caller-side; depends on agora-core)
   │     ▲
   │     ├── @quarry-systems/agora-cli           (depends on agora-client; binary `agora`)
   │     └── @quarry-systems/agora-mcp           (depends on agora-client; stdio MCP server,
   │                                              run-time tools only — never register/assign)
   ├── @quarry-systems/agora-worker              (container-side; depends on agora-core)
   ├── @quarry-systems/agora-runtime-claude-code (RuntimeAdapter impl; depends on agora-core;
   │                                              bundled into the stock worker OCI image)
   ├── @quarry-systems/agora-providers-fargate   (depends on agora-core, AWS SDK)
   ├── @quarry-systems/agora-providers-local-docker  (depends on agora-core, dockerode)
   ├── @quarry-systems/agora-providers-aws-creds (depends on agora-core, AWS SDK)
   ├── @quarry-systems/agora-storage-s3          (depends on agora-core, AWS SDK)
   ├── @quarry-systems/agora-storage-local       (depends on agora-core)
   └── @quarry-systems/agora-secret-store        (SecretStore impls — §5.9; depends on agora-core,
                                                  AWS SDK; consumed by agora-client + agora-worker)
```

Twelve packages in MVP. No package depends on Stoa, Bedrock, RaState, or any other Quarry Systems library. Enforced via package.json + a CI allowlist check.

The published OCI image bundles agora-worker + Claude Code CLI + Node runtime + the storage provider crates the worker needs at runtime (S3, local). Integrators that need provider variants the stock image doesn't include extend it: `FROM ghcr.io/quarry-systems/agora-worker:<digest>; COPY ./my-provider-add-on ./`.

## 9. MVP deliverables

To call MVP done, all of the following must ship:

1. `agora-core` published with all interface signatures.
2. `agora-client` with `dispatch()`, `cancel()`, `capabilities.register()`, `subagent.register()` + `assign()`, `env.register()`, including credential-pattern enforcement in env values and capability file contents.
3. `agora-cli` with `capabilities`, `subagent`, `env`, `dispatch` subcommands and `deploy --from <manifest>` reconciler.
4. `agora-mcp` stdio server exposing the six run-time tools from §4.6 (never register/assign).
5. `agora-worker` (npm + OCI image) with overlay engine, integrity verification, secret resolution, RuntimeAdapter invocation, lifecycle event emission, channel subscription opt-in, setup-script execution, notification firing. The published OCI image bundles the `agora-runtime-claude-code` adapter as the default runtime; `AGORA_RUNTIME_ADAPTER=claude-code` is the default. The adapter's `agora-needs-input-helper` content is overlaid before user capabilities (suppressible per dispatch via `AGORA_DISABLE_NEEDS_INPUT_HELPER=true`).
6. `agora-runtime-claude-code` (RuntimeAdapter implementation): renders prompts via Mustache substitution, spawns `claude --print`, applies adapter-specific merge rules for `.claude/settings.json` + `.claude/skills/<name>/SKILL.md` + `agora-plugins.json`, ships the `agora-needs-input-helper` SKILL.md, detects the sentinel file and reports `needsInputSentinelPath` in `RuntimeExit`.
7. `agora-providers-fargate` and `agora-providers-local-docker`.
8. `agora-providers-aws-creds`.
9. `agora-storage-s3` and `agora-storage-local`, plus `agora-secret-store` with `AwsSecretStore` + `LocalSecretStore` (§5.9) — the seam through which the client stages inline + per-dispatch secrets and the worker resolves + redaction-registers them.
10. End-to-end test suite:
   - Register + dispatch (local-docker + local storage); result returned via stdout sink.
   - Register + dispatch (Fargate + S3, live AWS gated behind a CI secret); result returned with `resolved` audit block populated correctly.
   - Manifest-driven deploy reconciles registry state from `agora-manifest.yaml`.
   - Idempotent re-register returns existing ref; changed content creates new entry.
   - Subagent `.assign()` produces a new subagent version with a different content hash.
   - Multiple env bundles merged with later-wins precedence.
   - Inline secret lifecycle: created, resolved by worker, deleted after exit.
   - Bundle integrity verification: tampered storage fails dispatch with `integrity-failed`.
   - Callback signing roundtrip.
   - Credentials-in-env rejection (both env values and capability file contents) — caught at `register()` time.
   - **Runtime secret redaction**: a sub-agent that emits a literal env-bundle secret value to stdout has the value redacted to `<redacted:secret>` in `DispatchResult.stdout`. Tests the literal-string-match redaction path documented in §6.7.
   - Channel subscription opt-in (test with a stub adapter shipped in tests).
   - Cancel during execution.
   - File-editing dispatch produces a real git push to a stub remote.
   - agora-mcp end-to-end: an MCP client (test harness) lists tools, calls `agora_dispatch` against a pre-registered subagent, verifies that `agora_*_register` and `agora_*_assign` tools are NOT exposed.
   - **agora-mcp tool-allowlist CI check** (architectural enforcement of the deploy-time / run-time boundary, §7.7). A CI step runs the agora-mcp server in test mode, dumps its exposed tool names, and asserts the set equals exactly the six run-time tool names from §4.6: `{agora_dispatch, agora_dispatch_describe, agora_dispatch_cancel, agora_capabilities_list, agora_subagents_list, agora_envs_list}`. Any addition is a CI failure. Any tool name matching the patterns `agora_*_register` or `agora_*_assign` is a CI failure regardless of intent. This is the load-bearing check — without it, the security boundary is policy, not architecture, and policy decays as code evolves.
   - `needs_input` re-dispatch convention round-trip (Shape A from §6.9): sub-agent writes sentinel, worker emits `dispatch.needs_input` event with parsed payload, orchestrator re-dispatches with `input.answer`, second dispatch reads partial_state and completes.
   - Malformed `needs_input` sentinel fails dispatch with `reason: 'worker-failed'` (not silently treated as completed).
   - `agora-needs-input-helper` is applied by default and the sub-agent's effective system prompt contains the convention; opt-out via `AGORA_DISABLE_NEEDS_INPUT_HELPER=true` removes the overlay.
   - Both notification sources fire on lifecycle events: capability-content notifications AND dispatch-level `notifications` field; HMAC signatures verify on both.
   - **RuntimeAdapter seam smoke test:** a stub `MockRuntimeAdapter` (test-only) is selectable via `AGORA_RUNTIME_ADAPTER=mock`. The mock returns a fixed `RuntimeExit`. Worker boots, fetches bundles, overlays, invokes the adapter, surfaces the fixed result. Proves the worker is genuinely runtime-agnostic — no Claude-specific code path is required for the lifecycle to complete.
11. README + Hello World example (§4.4) + worked manifest example (§4.5).

Acceptance criterion: a new integrator clones the example, replaces credentials + bucket name, and dispatches successfully within 30 minutes via both the CLI and through agora-mcp.

## 10. Open questions

All seven open questions from the prior revision have been resolved. Resolutions are recorded in §10.1 below:

1. ~~Package scope~~ → resolved as `@quarry-systems/agora-*`.
2. ~~Repo location~~ → resolved as a dedicated repo (preserves orthogonality physically as well as architecturally).
3. ~~Inline secret default TTL~~ → resolved: SDK auto-computes from dispatch timeout + 5min grace; explicit override available.
4. ~~Stdout cap~~ → resolved at 4 MiB with explicit truncation marker.
5. ~~`cancel()` in MVP or v0.2~~ → resolved: included in MVP.
6. ~~Capability size cap~~ → resolved at 50 MiB hard cap, rejected at register time.
7. ~~Cross-namespace primitive~~ → resolved: defer entirely; MVP is single-namespace.

This section is left intentionally empty so future open questions can be added without renumbering.

## 10.1 Decisions deliberately made (not open questions)

- **Package scope is `@quarry-systems/agora-*`.** Originally weighed against `@agora-mcp/*` for "easier OSS spinout later." Spinouts happen when they happen regardless of npm scope; the orthogonality principle is enforced architecturally (CI allowlist on dependencies), not via separate scopes. Consistent platform story + easier release coordination + room to add `@quarry-systems/bedrock-*` and `@quarry-systems/stoa-*` alongside without scope thrash.
- **Notifications have two homes by design.** Capability-content notifications (`agora-notifications.json`) are behavior-tied — the capability author mandates alerts whenever the capability is in scope (e.g., "alert if this dangerous capability fires"). Dispatch-level notifications (`notifications: NotificationConfig[]` on `DispatchWork`) are operational — the SRE team owns where alerts for a specific dispatch go (PagerDuty, Slack, internal webhook). Both flow through the same HMAC-signing path; the worker merges both sources at boot. The redundancy is the point: two distinct concerns with two distinct homes. (This supersedes an earlier decision that put notifications only in capability content.)
- **No `agora.workflow()` / `agora.procedure()` primitive.** Named pre-composed dispatch templates are sugar that integrators implement as wrapper functions around `dispatch()`. Revisit in v0.2 if multiple integrators independently reinvent the wrapper.
- **No `entrypoint` override at dispatch time.** Container-level customization is handled by extending the worker image. Per-dispatch setup is handled by `agora-setup.sh` content in capability bundles — versioned, content-addressable, audit-friendly. Dispatch-time entrypoint override would lose those properties.
- **Privileged operations are never reachable through `agora-mcp`.** `capabilities.register()`, `subagent.register()` / `assign()`, and `env.register()` are CLI- and TypeScript-only. The MCP surface exposes only run-time, orchestration-safe operations (dispatch + read-only catalog lookups). Rationale: prompt injection on capability content or subagent prompts is as dangerous as secret exfiltration on env; the entire artifact-creation surface stays out of the AI loop. See §7.7. This is the AWS IAM pattern: workloads reference pre-provisioned artifacts, not create them.
- **Sub-agent "needs input" handled by exit-and-redispatch (Shape A), not in-flight ask (Shape B).** Documented as §6.9. In-flight ask, snapshot-resume, and a future ConversationAdapter are all v0.2+ topics. Reasons: cost (blocked workers continue to bill), mechanism cost (bidirectional adapter + sub-agent–reachable ask primitive), and that snapshot-resume doesn't eliminate cold start.
- **`needs_input` signaled by sentinel file at `/workspace/.agora/needs_input.json`, not by exit code.** Exit codes are pollutable (signals, OS quirks, Claude Code's own non-interactive exit behavior). A sentinel file is a documented contract the sub-agent produces deliberately via its `Write` tool; the worker checks for file presence regardless of `claude --print` exit code. See §6.9.
- **Lifecycle event vocabulary is closed at six for MVP, extensible at minor versions.** Five-event closed-vocabulary commitment retired. Sixth event (`dispatch.needs_input`) added because squeezing it into `dispatch.finished` muddied downstream semantics. Future kinds (potentially `dispatch.heartbeat`, `dispatch.warning`) reserved. Integrators implementing telemetry hooks MUST handle unknown event kinds gracefully (log + skip).
- **Dedicated repo.** Agora lives in its own repo, not as another Nx app inside the existing `quarry-systems` monorepo and not inside a future `quarry-systems-platform` reference-orchestrator repo. Rationale: the orthogonality principle is enforced more durably when physical proximity to other Quarry Systems libraries can't introduce accidental coupling. The CI allowlist check (§8) catches dependency-level coupling; repo separation catches everything else (shared scripts, shared tsconfig fragments, shared utilities that drift into cross-references).
- **Inline secret TTL is auto-computed from dispatch timeout + 5-minute cleanup grace.** Default `dispatch.timeoutSeconds` (when unspecified) is 7200 seconds (2 hours). Integrators don't size TTLs themselves; the `ttlSeconds` field is an override for compliance-driven shorter lifetimes only. This supersedes the prior "size to 2x expected duration" guidance.
- **Stdout capped at 4 MiB, stderr at 256 KiB, with explicit truncation markers.** 1 MiB stdout was too tight for typical agentic outputs (multi-file syntheses, long-form reports). 4 MiB covers virtually all reasonable cases while keeping `DispatchResult` payloads manageable. Truncation appends a clear marker so consumers see the truncation rather than silently believing the output was complete. The compute provider's full log stream is unaffected — the cap is only on the in-memory `DispatchResult`.
- **`cancel()` is in MVP, not v0.2.** Implementation cost is bounded (~1-2 days across provider stop implementations + agora-client + worker SIGTERM handling, all already partially specced). The audit/operational story benefits significantly; regulated buyers expect "stop a runaway dispatch" as table-stakes.
- **Capability size cap is 50 MiB, rejected at `register()` time.** Above this, integrators are probably packaging the wrong thing (model files, vendor binaries, fat library bundles); those should be fetched at runtime via `agora-setup.sh`, not baked into the capability. No soft-warning tier in MVP (e.g., warn above 10 MiB); add one in v0.2 if integrators consistently hit unintentional bloat.
- **MVP is strictly single-namespace.** No public cross-namespace addressing, no read-only cross-namespace primitive. Integrators who want to share capability libraries across namespaces use a shared deploy pipeline (CI job that registers the same artifacts into N namespaces in parallel) or republish manually. The internal storage URI scheme (`agora://<namespace>/...`) is structured to support cross-namespace later, but the public API surfaces none of it in MVP.
- **RuntimeAdapter seam is introduced at MVP rather than deferred.** Even though MVP ships only one adapter (Claude Code), the abstraction exists in v0.1. The cost of adding the seam now is significantly lower than retrofitting it after Claude-specific assumptions calcify in the worker. The cost of *not* shipping it now is that every Claude-specific helper, merge rule, and invocation path becomes load-bearing worker code that future runtimes have to extract from. Adding the adapter interface plus one implementation is bounded work; extracting Claude-specific knowledge from a mature worker after the fact is significantly larger. The seam also makes the worker contract sharper: the worker is exactly the runtime-agnostic concerns (fetch, integrity, overlay engine, secrets, env, setup, channel, notifications, lifecycle), and the adapter is exactly the runtime-specific concerns (prompt rendering, runtime invocation, runtime-specific merge rules, needs_input signaling). Sharper boundaries mean fewer subtle bugs at the worker/runtime interface.
- **`agora-mcp` authentication is "whoever launched the server."** There is no per-call authentication, no per-orchestrator scoping, no granular MCP-level ACL. Anyone who can launch the agora-mcp stdio server (typically by virtue of being able to run a process on the host) has full access to all six run-time tools and can dispatch against any artifact in the registry. Limiting who can launch the MCP server is the integrator's IAM concern — controlled by host filesystem permissions, container orchestration policy, and the IAM credentials available to the launching process. The orchestrator's environment IS the trust boundary. Per-call auth, per-orchestrator scoping, and granular MCP-level ACLs (e.g., "this orchestrator can only dispatch with the `code-reviewer` subagent") are all v0.2+. For the construction-buyer demo and most early integrations, host-IAM scoping is sufficient; for hosted or multi-tenant agora, more is required.

### Recommended: extract these to ADRs at repo scaffold time

This list has grown to twelve substantive decisions and will accumulate more during implementation. The decisions are findable here for now, but as contributors arrive they'll be hard to locate inside a long design spec. When the repo is scaffolded (DAG 1), the recommended pattern is:

- Create `docs/decisions/` in the agora repo.
- Each entry above becomes a short ADR file: `0001-package-scope.md`, `0002-dedicated-repo.md`, etc.
- Each ADR follows the "context / decision / consequences" structure (see Michael Nygard's ADR template).
- This spec references ADRs by number going forward: *"(see ADR-007 for package scope rationale)"*.

The ADR content is mostly already written — copy from each §10.1 bullet, expand the "context" with what was being weighed, and add a brief "consequences" section noting downstream impact. ~30 minutes per ADR. Worth doing once before contributors arrive; expensive to do retroactively after the spec drifts from the decision record.

## 11. Out of scope (deferred past MVP)

- Cross-namespace registration and addressing.
- ARN/URI-style public refs (internal storage URIs only for MVP).
- Multi-region deployment from a single client instance. Integrators run multiple clients.
- Drift-as-payload format. Capabilities are filesystem overlays, not graph definitions. Drift compatibility (workers running Drift graphs inside the sub-agent) is emergent if the integrator wires it.
- RaState integration. The worker's sub-agent may call into RaState in integrator code; the SDK does not know about RaState.
- Additional `RuntimeAdapter` implementations (Codex, Gemini CLI, custom harnesses). The multi-runtime architecture is in MVP (§5.8); only additional adapter implementations beyond the Claude Code adapter are deferred to v0.2+.
- Queue / pull model. Workers do not poll. Each dispatch is one explicit call.
- Built-in retry / backoff. Integrator wraps `dispatch()`.
- Workflow primitives (fan-out, branching). Out of scope forever.
- Hosted agora offering. MVP is self-hosted.
- Signed capability bundles (publisher signatures separate from content hashes). v0.2+ if a multi-publisher ecosystem emerges.
- Capability deprecation / archival semantics. Old versions accumulate indefinitely in MVP.
- **In-flight sub-agent ask (Shape B from §6.9 reasoning).** Bidirectional ask/answer during dispatch via a future `ConversationAdapter` interface. MVP handles this via exit-and-redispatch (the `needs_input` convention in §6.9).
- **Snapshot-resume for paused dispatches.** Persisting full worker state (workspace + Claude session) so a resumed dispatch picks up exactly where the previous one left off. Doesn't eliminate cold start and adds significant machinery (Claude `--resume`, session format coupling, snapshot storage); deferred until a use case justifies the complexity.
- **`ConversationAdapter` interface.** Generalized bidirectional human-in-the-loop interaction (Slack threads with replies, Teams threaded conversations, web UI form workflows). Distinct from ChannelAdapter's receive-only event-stream shape.
- **Capability introspection tooling.** `agora capability explain <name>` and `agora subagent explain <name>` commands showing resolved overlay order, effective filesystem mutations, effective runtime-adapter configuration (Claude Code permissions, MCP server config, etc.) or whichever adapter is in use, and any path collisions surfaced as warnings. v0.2 deliverable; the tooling becomes important once integrators have built up enough capability surface to need debugging help. The MVP §6.3 merge rules are intentionally conservative precisely because this debugging tooling doesn't exist yet.
