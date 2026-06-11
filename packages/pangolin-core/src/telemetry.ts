// Telemetry hook contract (§5.7).
//
// A `TelemetryHook` is a named consumer of the `LifecycleEvent` stream.
// Hooks are the only out-of-band observability surface the runtime
// exposes; they are intentionally synchronous and fire-and-forget so the
// dispatch path cannot be blocked by a slow observer.
//
// Implementations are expected to be cheap and non-throwing. Errors raised
// inside `emit` are the implementation's responsibility to handle; the
// runtime does not catch them.

import type { LifecycleEvent } from './lifecycle.js';

export interface TelemetryHook {
  readonly name: string;
  emit(event: LifecycleEvent): void;
}
