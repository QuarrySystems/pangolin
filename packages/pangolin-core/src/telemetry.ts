// Telemetry hook contract (§5.7).
//
// A `TelemetryHook` is a named consumer of the `LifecycleEvent` stream.
// Hooks are the only out-of-band observability surface the runtime
// exposes; they are intentionally synchronous and fire-and-forget so the
// dispatch path cannot be blocked by a slow observer.
//
// Implementations are expected to be cheap and non-throwing. As a safety net the
// runtime routes every emit through a guarded helper (pangolin-client
// `emitLifecycleEvent`) that catches and loudly logs a throwing hook rather than
// letting it break the dispatch path.

import type { LifecycleEvent } from './lifecycle.js';

export interface TelemetryHook {
  readonly name: string;
  emit(event: LifecycleEvent): void;
}
