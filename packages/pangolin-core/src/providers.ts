// Pluggable provider contracts (§5.1 / §5.2).
//
// Integrators implement these interfaces to plug compute backends and
// credential sources into the dispatch path. The pangolin-client and
// pangolin-worker packages consume these contracts in DAG 2; the core
// package only owns the signatures.
//
// `CredentialProvider` is a one-shot resolver for the secret material a
// task will need at runtime. `ComputeProvider` is the surface a backend
// (Docker, AWS Batch, a remote runner, etc.) exposes to the runtime to
// start, await, and optionally cancel a task. `cancel` is optional
// because some providers (notably batch queues) cannot abort a running
// task; the runtime treats its absence as "best-effort, not supported."

import type { TelemetryHook } from './telemetry.js';

/**
 * Resolved secret material for a task. The `kind` discriminator names the
 * credential family (e.g. `'aws-sts'`, `'static-bearer'`); additional
 * fields are family-specific and intentionally open.
 */
export interface ResolvedCredentials {
  kind: string;
  [key: string]: unknown;
}

/**
 * A `CredentialProvider` resolves the credential bundle for one task
 * invocation. Implementations are expected to be side-effect-free aside
 * from the secret fetch itself; the runtime calls `resolve` once per
 * dispatch.
 */
export interface CredentialProvider {
  readonly name: string;
  resolve(): Promise<ResolvedCredentials>;
}

/**
 * Declarative description of a task the runtime wants the provider to
 * run. `secretRefs` is a map of env-var name -> secret reference string,
 * resolved out-of-band by the provider against its credential context.
 */
export interface TaskSpec {
  image: string;
  env: Record<string, string>;
  secretRefs: Record<string, string>;
  command?: string[];
  resources?: { cpu?: number; memory?: number };
  dispatchId: string;
}

/**
 * Per-invocation context handed to a `ComputeProvider`. The telemetry
 * hook is optional so providers can run unobserved in tests.
 */
export interface ProviderContext {
  credentials: ResolvedCredentials;
  telemetry?: TelemetryHook;
}

/**
 * Opaque handle the provider returns from `run`. The shape is provider-
 * specific aside from `providerTaskId`, which the runtime echoes into
 * the lifecycle event stream.
 */
export interface TaskHandle {
  providerTaskId: string;
}

/**
 * Terminal result the provider returns from `awaitExit`. `exitCode` is
 * 0 for success; non-zero for application failure. `providerFailureReason`
 * is set when the failure is infrastructural (image pull failed, quota
 * exceeded) rather than an application-level non-zero exit.
 */
export interface TaskExit {
  exitCode: number;
  startedAt: Date;
  finishedAt: Date;
  stdout: string;
  stderr: string;
  providerFailureReason?: string;
}

/** A secret staged into a {@link SecretStore}. */
export interface StagedSecret {
  /**
   * Opaque, store-specific reference the worker later passes to
   * {@link SecretStore.resolve}. For the AWS adapter this is a Secrets
   * Manager ARN; for the local adapter it is an opaque `local-secret://`
   * URI. Callers treat it as a string and never parse it.
   */
  ref: string;
  /** Effective TTL in seconds; the store auto-expires the secret after this. */
  ttlSeconds: number;
}

/** Arguments to {@link SecretStore.stage}. */
export interface StageSecretArgs {
  /** Logical name; the store namespaces/sanitizes as needed. */
  name: string;
  /** The secret value to stage. */
  value: string;
  /** Auto-expiry in seconds. */
  ttlSeconds: number;
  /**
   * Tags for bulk cleanup — e.g. `{ 'pangolin:dispatchId': '<id>' }` so a
   * dispatch's per-dispatch secrets can be swept in one
   * {@link SecretStore.cleanupByTag} call.
   */
  tags?: Record<string, string>;
}

/**
 * A pluggable secret store (a.k.a. ENVStore). The caller-side SDK stages
 * inline secrets and the per-dispatch callback HMAC key here at register /
 * dispatch time; the worker resolves refs back to values at boot.
 *
 * Two adapters ship: AWS Secrets Manager (production) and a local
 * file-backed store (dev / `LocalDockerProvider`). The interface exists so
 * resolution authority can live entirely in the worker — ALL secret values
 * (env-bundle and per-dispatch) pass through `resolve`, giving the worker a
 * single chokepoint to register each value for log redaction before the
 * sub-agent runs (§7.1).
 */
export interface SecretStore {
  readonly name: string;
  /**
   * For file-backed stores, the host directory holding staged secret files.
   * The dispatcher reads this to emit PANGOLIN_SECRET_STORE_DIR for the provider
   * bind-mount. Undefined for stores with no on-disk directory (e.g. AWS).
   */
  readonly dir?: string;
  /** Stage a secret value and return an opaque, resolvable reference. */
  stage(args: StageSecretArgs): Promise<StagedSecret>;
  /** Resolve a previously-staged reference back to its secret value. */
  resolve(ref: string): Promise<string>;
  /** Delete every secret carrying the given tag. Best-effort; never throws on a miss. */
  cleanupByTag(tagKey: string, tagValue: string): Promise<void>;
}

/**
 * A `ComputeProvider` is the runtime-facing surface of a compute backend.
 * `run` is non-blocking and returns a handle; `awaitExit` blocks until
 * the task reaches a terminal state. `cancel` is optional — providers
 * that cannot abort in-flight tasks simply omit it, and the runtime
 * treats cancellation as best-effort.
 */
export interface ComputeProvider {
  readonly name: string;
  run(spec: TaskSpec, ctx: ProviderContext): Promise<TaskHandle>;
  awaitExit(handle: TaskHandle, ctx: ProviderContext): Promise<TaskExit>;
  cancel?(handle: TaskHandle, ctx: ProviderContext): Promise<void>;
}
