// Runtime adapter contract (§5.8).
//
// A `RuntimeAdapter` wraps a model-running binary (Claude Code, Codex,
// a local llama runner, etc.) behind a uniform invocation surface. The
// runtime hands the adapter a workspace directory, a prompt, and an
// environment; the adapter shells out, captures stdout/stderr, and
// returns a `RuntimeExit`.
//
// `reservedPaths` is the set of workspace-relative paths the adapter
// considers its own (config, state files); the runtime treats these as
// off-limits when merging diffs. `mergeRules` lets the adapter declare
// per-file merge semantics — last-write-wins for blobs, deep-merge for
// JSON, union for tag arrays, and so on.
//
// `needsInputSentinelPath` (see ADR-0009) is the file the adapter
// writes when the model has paused awaiting external input. The runtime
// uses its presence (not the exit code) to decide whether to surface a
// `dispatch.needs_input` event.

import type { TelemetryHook } from './telemetry.js';

/**
 * Per-file merge semantics declared by a `RuntimeAdapter`. The runtime
 * applies these rules when reconciling adapter-produced edits against
 * the workspace.
 */
export type MergeRule =
  | { strategy: 'last-write-wins' }
  | { strategy: 'deep-merge'; arrayMode?: 'union' | 'replace' | 'concat' }
  | { strategy: 'array-union' };

/**
 * Inputs to a single adapter invocation. `systemPrompt` and
 * `promptTemplate` are adapter-specific text inputs; `input` is the
 * structured payload the template renders against. `workspaceDir` is the
 * absolute path the adapter is expected to read from and write into.
 */
export interface RuntimeInvocation {
  systemPrompt?: string;
  promptTemplate?: string;
  input?: Record<string, unknown>;
  model?: string;
  workspaceDir: string;
}

/**
 * Per-invocation context handed to a `RuntimeAdapter`. Telemetry is
 * optional so adapters can run unobserved in tests.
 */
export interface RuntimeContext {
  dispatchId: string;
  env: Record<string, string>;
  telemetry?: TelemetryHook;
}

/**
 * Actual model usage reported by the runtime CLI for one invocation.
 * Best-effort: absent whenever the runtime's output is not parseable.
 * `durationMs` is MODEL time as reported by the runtime — distinct from
 * `DispatchResult.durationMs` (worker wall) and `BlockOutcome.durationMs`
 * (block wall).
 */
export interface RuntimeUsage {
  /** Actual model ids that served the invocation (e.g. keys of claude's modelUsage). */
  models: string[];
  costUsd?: number;
  turns?: number;
  durationMs?: number;
}

/**
 * Terminal result of an adapter invocation. `exitCode` is 0 for success.
 * `needsInputSentinelPath` is set when the adapter detected its
 * needs-input sentinel; see ADR-0009.
 */
export interface RuntimeExit {
  exitCode: number;
  stdout: string;
  stderr: string;
  needsInputSentinelPath?: string;
  /** Best-effort usage capture. Optional + additive. */
  usage?: RuntimeUsage;
}

/**
 * A `RuntimeAdapter` is the seam between the dispatch runtime and a
 * concrete model-running binary. Adapters are stateful only in the
 * sense that they own `reservedPaths` and `mergeRules`; each `invoke`
 * is an independent call.
 */
export interface RuntimeAdapter {
  readonly name: string;
  reservedPaths: string[];
  mergeRules?: Record<string, MergeRule>;
  invoke(spec: RuntimeInvocation, ctx: RuntimeContext): Promise<RuntimeExit>;
}
