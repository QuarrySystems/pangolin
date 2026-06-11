// Dispatch input/output contracts (§4.2 / §4.3).
//
// `DispatchWork` is the request the caller submits to the runtime: which
// subagent to run, against which target, with which capabilities, env,
// secrets, and lifecycle webhooks. `DispatchResult` is the terminal
// payload the runtime returns once the dispatch reaches a terminal state.
//
// `NotificationConfig` ties a webhook URL to a subset of the closed
// `LifecycleEvent` taxonomy (see `./lifecycle.ts`). The caller chooses
// which kinds it cares about; the runtime fires the webhook on each
// matching event.
//
// The `resolved` block on `DispatchResult` echoes the bound artifact refs
// back to the caller so they can audit exactly which capability/subagent/
// env bytes ran — `name`-only identity is not enough once a registry
// allows mutable updates.

import type {
  CapabilityRef,
  SubagentRef,
  EnvRef,
  InlineSecret,
  SecretRef,
} from './refs.js';
import type { LifecycleEvent } from './lifecycle.js';

/**
 * Webhook subscription for a slice of the lifecycle event stream. The
 * runtime fires `webhook` for every event whose `kind` appears in `when`.
 */
export interface NotificationConfig {
  when: LifecycleEvent['kind'][];
  webhook: string;
}

/**
 * The full input shape for a single dispatch. `subagent` and `target` are
 * required; everything else is optional and defaulted by the runtime.
 *
 * `capabilities` replaces the subagent's bound set; `addCapabilities`
 * augments it. Callers typically pick one or the other, not both.
 *
 * `secrets` is a map of env-var name to either a `SecretRef` (resolved
 * out-of-band against a secrets manager) or an `InlineSecret` (literal
 * value bound for the lifetime of this one dispatch).
 *
 * `model` is the authorized model level or provider-native id for this
 * dispatch (spec §2 grammar). Reserved levels: `fast` | `standard` | `max`
 * — adapters map these to adapter-native models (e.g. claude-code maps them
 * to haiku/sonnet/opus). Anything else is passed through as a provider-native
 * id. Pin-optional: nothing fails for lack of a model field; the adapter
 * falls back to its default. Not a secret.
 */
export interface DispatchWork {
  subagent: string | SubagentRef;
  env?: string | EnvRef | Array<string | EnvRef>;
  capabilities?: Array<string | CapabilityRef>;
  addCapabilities?: Array<string | CapabilityRef>;
  input?: Record<string, unknown>;
  target: string;
  /** Authorized model level or provider-native id. See interface doc for grammar. */
  model?: string;
  dispatchId?: string;
  callback?: { url: string; signatureAlgorithm?: 'sha256' };
  notifications?: NotificationConfig[];
  secrets?: Record<string, SecretRef | InlineSecret>;
  retentionDays?: number;
  timeoutSeconds?: number;
  resources?: { cpu?: number; memory?: number };
  /** Per-dispatch input artifacts by reference: input key -> already-pinned
   *  pangolin://…/sha256:… URI of an upstream product (typed-product handoff, spec §5).
   *  Pass-through refs — the blobs already exist in storage. */
  inputRefs?: Record<string, string>;
  /** Pinned pangolin:// URI of the pipeline definition that triggered this dispatch.
   *  Must be a content-addressed URI (include a sha256:… contentHash segment).
   *  Recorded in bundleRefs.pipeline and the audit manifest so every dispatch is
   *  traceable back to the exact pipeline version that produced it. */
  pipelineRef?: string;
}

/**
 * The terminal payload returned to the caller once a dispatch finishes.
 *
 * `resolved` echoes back the concrete refs that were bound at accept-time
 * — this is the audit trail callers use to prove exactly which bytes ran.
 *
 * `failure` is set when the dispatch did not reach a clean `exitCode: 0`
 * for an infrastructural reason (worker crash, provider failure, timeout,
 * cancellation, fetch failure, integrity check failure). Application-level
 * non-zero exits are reported via `exitCode` alone, with no `failure`.
 *
 * `needsInput` is set when the dispatch paused awaiting external input
 * (see ADR-0008); the caller is expected to resume with the answer.
 */
export interface DispatchResult {
  dispatchId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  resolved: {
    subagent: SubagentRef;
    capabilities: CapabilityRef[];
    env?: EnvRef[];
  };
  failure?: {
    reason:
      | 'worker-failed'
      | 'provider-failed'
      | 'timeout'
      | 'cancelled'
      | 'fetch-failed'
      | 'integrity-failed';
    detail: string;
  };
  needsInput?: {
    question: string;
    options?: string[];
    context?: string;
    partialState?: unknown;
  };
}
