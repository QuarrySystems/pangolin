// `PangolinClient` — caller-side SDK entry point (§7).
//
// This file is intentionally a thin class shell. The namespaced sub-API
// methods (`capabilities.register`, `subagent.register`, `env.*`,
// `dispatch.*`) are bound by their own tasks via prototype extension or
// barrel-level composition; this constructor just validates the option
// shape and holds the wired-in providers as readonly fields.

import type {
  ComputeProvider,
  CredentialProvider,
  SecretStore,
  StorageProvider,
  TelemetryHook,
  ResultSink,
} from '@quarry-systems/pangolin-core';

/**
 * Declarative mapping from a logical dispatch target (e.g. `'prod'`) to
 * the named compute + credential providers the client should use when a
 * caller targets it. `defaultResources` is a fallback when a specific
 * dispatch does not pin its own resource request.
 */
export interface TargetConfig {
  compute: string;
  credentials: string;
  /** Name of the SecretStore (in secretStores) used for this target's secrets. */
  secretStore?: string;
  defaultResources?: { cpu?: number; memory?: number };
}

/**
 * Dispatch-record retention policy (§7.8). `defaultDays` is the retention
 * applied when a dispatch does not pin its own value; `maxDays` is the
 * upper bound the client refuses to exceed. The 7-year cap (2555 days) is
 * a hard ceiling baked into the constructor.
 */
export interface DispatchRetentionConfig {
  defaultDays?: number;
  maxDays?: number;
}

/**
 * Constructor options for `PangolinClient`. All fields except `namespace`,
 * `compute`, `credentials`, `storage`, and `targets` are optional. The
 * `targets` registry is validated against the `compute` and `credentials`
 * maps at construction time — every target's referenced provider name
 * must resolve.
 */
export interface PangolinClientOptions {
  namespace: string;
  compute: Record<string, ComputeProvider>;
  credentials: Record<string, CredentialProvider>;
  storage: StorageProvider;
  targets: Record<string, TargetConfig>;
  telemetry?: TelemetryHook;
  resultSink?: ResultSink;
  defaultModel?: string;
  dispatchRetention?: DispatchRetentionConfig;
  /** Per-target secret stores. Defaults to {} — no implicit AWS store. */
  secretStores?: Record<string, SecretStore>;
}

const DEFAULT_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 2555; // ~7 years per §7.8

/**
 * Caller-side SDK entry point. Subsequent tasks bind namespaced sub-API
 * methods (`capabilities.register`, `subagent.register`, `env.*`,
 * `dispatch.*`) onto this class; this constructor only validates the
 * option shape and stores the wired-in providers as readonly fields.
 */
export class PangolinClient {
  readonly namespace: string;
  readonly compute: Record<string, ComputeProvider>;
  readonly credentials: Record<string, CredentialProvider>;
  readonly storage: StorageProvider;
  readonly targets: Record<string, TargetConfig>;
  readonly secretStores: Record<string, SecretStore>;
  readonly telemetry?: TelemetryHook;
  readonly resultSink?: ResultSink;
  readonly defaultModel?: string;
  readonly retention: Required<DispatchRetentionConfig>;

  constructor(opts: PangolinClientOptions) {
    if (!opts.namespace) {
      throw new Error('PangolinClient: namespace is required');
    }
    if (!opts.storage) {
      throw new Error('PangolinClient: storage is required');
    }
    const targets = opts.targets ?? {};
    const secretStores = opts.secretStores ?? {};
    for (const targetName of Object.keys(targets)) {
      const t = targets[targetName];
      if (!opts.compute[t.compute]) {
        throw new Error(
          `PangolinClient: target ${targetName} references unknown compute ${t.compute}`,
        );
      }
      if (!opts.credentials[t.credentials]) {
        throw new Error(
          `PangolinClient: target ${targetName} references unknown credentials ${t.credentials}`,
        );
      }
      if (t.secretStore !== undefined && !secretStores[t.secretStore]) {
        throw new Error(
          `PangolinClient: target ${targetName} references unknown secretStore ${t.secretStore}`,
        );
      }
    }
    const defaultDays =
      opts.dispatchRetention?.defaultDays ?? DEFAULT_RETENTION_DAYS;
    const maxDays = opts.dispatchRetention?.maxDays ?? MAX_RETENTION_DAYS;
    if (maxDays > MAX_RETENTION_DAYS) {
      throw new Error(
        `PangolinClient: dispatchRetention.maxDays exceeds 7-year cap (${MAX_RETENTION_DAYS} days)`,
      );
    }
    if (defaultDays > maxDays) {
      throw new Error(
        `PangolinClient: dispatchRetention.defaultDays (${defaultDays}) exceeds maxDays (${maxDays})`,
      );
    }
    this.namespace = opts.namespace;
    this.compute = opts.compute;
    this.credentials = opts.credentials;
    this.storage = opts.storage;
    this.targets = targets;
    this.secretStores = secretStores;
    this.telemetry = opts.telemetry;
    this.resultSink = opts.resultSink;
    this.defaultModel = opts.defaultModel;
    this.retention = { defaultDays, maxDays };
  }
}
