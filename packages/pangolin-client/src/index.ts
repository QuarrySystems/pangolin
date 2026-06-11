// @quarry-systems/pangolin-client — public barrel
//
// Re-exports every public symbol and wires the namespaced sub-API
// (`client.capabilities.*`, `client.subagent.*`, `client.env.*`,
// `client.dispatch(...)`) onto `PangolinClient` via prototype extension so
// callers never need sub-path imports.

// ── Core class + option types ──────────────────────────────────────────────
export {
  PangolinClient,
  type PangolinClientOptions,
  type TargetConfig,
  type DispatchRetentionConfig,
} from './client.js';

// ── Self-verify config (re-exported from pangolin-core for consumers) ─────────
export type { VerifyConfig } from '@quarry-systems/pangolin-core';

// ── Credential-pattern scanner ─────────────────────────────────────────────
export {
  assertNoCredentialPattern,
  type CredentialPatternCheckOpts,
} from './credential-pattern.js';

// ── Inline-secret TTL helper ──────────────────────────────────────────────
export { computeInlineSecretTtl } from './secret-ttl.js';

// ── Errors ─────────────────────────────────────────────────────────────────
export { SecretStoreMismatchError } from './errors.js';

// ── Callback HMAC ──────────────────────────────────────────────────────────
export {
  mintCallbackHmac,
  signCallback,
} from './callback-hmac.js';

// ── Capabilities registration ──────────────────────────────────────────────
export {
  registerCapability,
  type RegisterCapabilityOpts,
} from './capabilities-register.js';

// ── Subagent registration ──────────────────────────────────────────────────
export {
  registerSubagent,
  type RegisterSubagentOpts,
} from './subagent-register.js';

// ── Pipeline registration ──────────────────────────────────────────────────
export {
  registerPipeline,
  type PipelineRef,
} from './pipeline-register.js';

// ── Env registration ───────────────────────────────────────────────────────
export {
  registerEnv,
  type RegisterEnvOpts,
} from './env-register.js';

// ── Catalog (list / get) ───────────────────────────────────────────────────
export {
  listCapabilities,
  getCapability,
  listSubagents,
  getSubagent,
  listEnvs,
  getEnv,
} from './catalog.js';

// ── Dispatch ───────────────────────────────────────────────────────────────
export {
  fireWork,
  dispatchWork,
  type InFlightDispatch,
  type ClientDispatchOpts,
} from './dispatch.js';

// ── Describe ──────────────────────────────────────────────────────────────
export {
  describeDispatch,
  DispatchRecordExpiredError,
} from './describe.js';

// ── Cancel ────────────────────────────────────────────────────────────────
export { cancelDispatch } from './cancel.js';

// ── Retention ─────────────────────────────────────────────────────────────
export {
  writeDispatchRecord,
  readDispatchRecord,
  type DispatchRecord,
} from './retention.js';

// ── Bundled default implementations ───────────────────────────────────────
export {
  StdoutResultSink,
  NoopCredentialProvider,
  NoopTelemetryHook,
} from './bundled-impls.js';

// ─────────────────────────────────────────────────────────────────────────
// Namespaced sub-API — wired onto PangolinClient via prototype extension.
//
// After this module is imported, every PangolinClient instance exposes:
//   client.capabilities.register / .list / .get
//   client.subagent.register / .assign / .list / .get
//   client.env.register / .list / .get
//   client.dispatch(work & opts)         — callable
//   client.dispatch.describe(id)         — method on the callable
//   client.dispatch.cancel(id)           — method on the callable
// ─────────────────────────────────────────────────────────────────────────

import type { CapabilityRef, DispatchResult, SubagentRef, SubagentHandle, PipelineSpec } from '@quarry-systems/pangolin-core';
import { PangolinClient } from './client.js';
import { registerCapability, type RegisterCapabilityOpts } from './capabilities-register.js';
import { listCapabilities, getCapability, listSubagents, getSubagent, listEnvs, getEnv } from './catalog.js';
import { registerSubagent, type RegisterSubagentOpts } from './subagent-register.js';
import { registerPipeline, type PipelineRef } from './pipeline-register.js';
import { registerEnv, type RegisterEnvOpts } from './env-register.js';
import { dispatchWork, fireWork, type ClientDispatchOpts, type InFlightDispatch } from './dispatch.js';
import { describeDispatch } from './describe.js';
import { cancelDispatch } from './cancel.js';
import type { DispatchWork } from '@quarry-systems/pangolin-core';

// ── Type aliases for the namespaced sub-objects ───────────────────────────

/** Shape of `client.capabilities`. */
export interface PangolinClientCapabilitiesAPI {
  register(opts: RegisterCapabilityOpts): Promise<CapabilityRef>;
  list(): Promise<CapabilityRef[]>;
  get(name: string): Promise<CapabilityRef | null>;
}

/** Shape of `client.subagent`. */
export interface PangolinClientSubagentAPI {
  register(opts: RegisterSubagentOpts): Promise<SubagentHandle>;
  assign(handle: SubagentHandle, capabilities: Array<string | CapabilityRef>): Promise<SubagentRef>;
  list(): Promise<SubagentRef[]>;
  get(name: string): Promise<SubagentRef | null>;
}

/** Shape of `client.env`. */
export interface PangolinClientEnvAPI {
  register(opts: RegisterEnvOpts): Promise<import('@quarry-systems/pangolin-core').EnvRef>;
  list(): Promise<import('@quarry-systems/pangolin-core').EnvRef[]>;
  get(name: string): Promise<import('@quarry-systems/pangolin-core').EnvRef | null>;
}

/** Shape of `client.pipeline`. */
export interface PangolinClientPipelineAPI {
  register(spec: PipelineSpec): Promise<PipelineRef>;
}

/**
 * A callable dispatch function that also has `.describe` and `.cancel`
 * properties. `work` merges the fields from `DispatchWork` and
 * `ClientDispatchOpts` so a single object covers both.
 */
export interface PangolinClientDispatchFn {
  (work: DispatchWork & ClientDispatchOpts): Promise<DispatchResult>;
  fire(work: DispatchWork & ClientDispatchOpts): Promise<InFlightDispatch>;
  describe(dispatchId: string): Promise<DispatchResult>;
  cancel(dispatchId: string): Promise<void>;
}

// ── Module augmentation — extend PangolinClient with namespaced properties ───

declare module './client.js' {
  interface PangolinClient {
    /** Namespaced capabilities API (register / list / get). */
    readonly capabilities: PangolinClientCapabilitiesAPI;
    /** Namespaced subagent API (register / assign / list / get). */
    readonly subagent: PangolinClientSubagentAPI;
    /** Namespaced env API (register / list / get). */
    readonly env: PangolinClientEnvAPI;
    /** Namespaced pipeline API (register). */
    readonly pipeline: PangolinClientPipelineAPI;
    /**
     * Callable dispatch function. Also exposes `.describe(id)` and
     * `.cancel(id)` as direct properties so callers can use the compact
     * `client.dispatch.describe(id)` form without an extra import.
     */
    readonly dispatch: PangolinClientDispatchFn;
  }
}

// ── Prototype installation ─────────────────────────────────────────────────
//
// Each property is installed as a non-enumerable, configurable getter so:
//   1. The sub-object is constructed lazily (avoids paying for closures that
//      most callers won't use on every construction path).
//   2. Tests can override an individual property if needed.
//   3. The installed API is per-instance (captures `this` from the getter).

Object.defineProperty(PangolinClient.prototype, 'capabilities', {
  configurable: true,
  enumerable: false,
  get(this: PangolinClient): PangolinClientCapabilitiesAPI {
    return {
      register: (opts: RegisterCapabilityOpts) => registerCapability(this, opts),
      list: () => listCapabilities(this),
      get: (name: string) => getCapability(this, name),
    };
  },
});

Object.defineProperty(PangolinClient.prototype, 'subagent', {
  configurable: true,
  enumerable: false,
  get(this: PangolinClient): PangolinClientSubagentAPI {
    return {
      register: (opts: RegisterSubagentOpts) => registerSubagent(this, opts),
      assign: (handle: SubagentHandle, capabilities: Array<string | CapabilityRef>) =>
        handle.assign(capabilities),
      list: () => listSubagents(this),
      get: (name: string) => getSubagent(this, name),
    };
  },
});

Object.defineProperty(PangolinClient.prototype, 'env', {
  configurable: true,
  enumerable: false,
  get(this: PangolinClient): PangolinClientEnvAPI {
    return {
      register: (opts: RegisterEnvOpts) => registerEnv(this, opts),
      list: () => listEnvs(this),
      get: (name: string) => getEnv(this, name),
    };
  },
});

Object.defineProperty(PangolinClient.prototype, 'pipeline', {
  configurable: true,
  enumerable: false,
  get(this: PangolinClient): PangolinClientPipelineAPI {
    return {
      register: (spec: PipelineSpec) => registerPipeline(this, spec),
    };
  },
});

Object.defineProperty(PangolinClient.prototype, 'dispatch', {
  configurable: true,
  enumerable: false,
  get(this: PangolinClient): PangolinClientDispatchFn {
    // Build the callable with methods attached. The merged arg shape
    // (DispatchWork & ClientDispatchOpts) lets callers pass everything in
    // one object; we split it into the two parameters dispatchWork expects.
    // Arrow functions bind `this` lexically (the getter's instance), so no alias.
    const fn = (workAndOpts: DispatchWork & ClientDispatchOpts): Promise<DispatchResult> => {
      const { workerImage, defaultDispatchTimeoutSeconds, ...work } = workAndOpts;
      return dispatchWork(this, work as DispatchWork, {
        workerImage,
        defaultDispatchTimeoutSeconds,
      });
    };
    fn.describe = (dispatchId: string) => describeDispatch(this, dispatchId);
    fn.cancel = (dispatchId: string) => cancelDispatch(this, dispatchId);
    fn.fire = (workAndOpts: DispatchWork & ClientDispatchOpts): Promise<InFlightDispatch> => {
      const { workerImage, defaultDispatchTimeoutSeconds, ...work } = workAndOpts;
      return fireWork(this, work as DispatchWork, { workerImage, defaultDispatchTimeoutSeconds });
    };
    return fn as unknown as PangolinClientDispatchFn;
  },
});
