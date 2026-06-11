// Result sink contract (§5.4).
//
// A `ResultSink` is the seam between a provider's terminal `TaskExit` and
// the runtime's `DispatchResult`. The runtime calls `collect` once per
// dispatch, handing the sink the provider's `TaskHandle`, the raw
// `TaskExit`, and a `SinkContext` carrying the dispatch id, the resolved
// ref bundle, and an optional telemetry hook.
//
// Sinks own any post-processing of stdout/stderr, attribution of failure
// reasons, and detection of the needs-input sentinel. Different providers
// emit different metadata; the sink is where that variance is normalized
// into the uniform `DispatchResult` shape.

import type { TaskHandle, TaskExit } from './providers.js';
import type { DispatchResult } from './dispatch.js';
import type { TelemetryHook } from './telemetry.js';

/**
 * Per-invocation context handed to a `ResultSink`. `resolved` mirrors the
 * shape on `DispatchResult` so the sink can echo it back unchanged when
 * no additional resolution is required.
 */
export interface SinkContext {
  dispatchId: string;
  resolved: DispatchResult['resolved'];
  telemetry?: TelemetryHook;
}

/**
 * A `ResultSink` normalizes a provider's terminal `TaskExit` into a
 * `DispatchResult`. The runtime calls `collect` exactly once per
 * dispatch, after `ComputeProvider.awaitExit` returns.
 */
export interface ResultSink {
  readonly name: string;
  collect(
    handle: TaskHandle,
    exit: TaskExit,
    ctx: SinkContext,
  ): Promise<DispatchResult>;
}
