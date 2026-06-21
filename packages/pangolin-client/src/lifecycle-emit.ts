import type { LifecycleEvent, TelemetryHook } from '@quarry-systems/pangolin-core';

/**
 * Guarded dispatch-lifecycle emit: routes an event to the configured `TelemetryHook`. A throwing
 * hook must NEVER break the dispatch path, so a throw is caught and logged loudly (matching the
 * repo's `[pangolin …]` prefix + loud-by-default surfacing) and never rethrown. A `undefined`
 * telemetry hook is a no-op. This is the single chokepoint all dispatch-lifecycle emission flows
 * through.
 */
export function emitLifecycleEvent(
  telemetry: TelemetryHook | undefined,
  event: LifecycleEvent,
): void {
  if (!telemetry) return;
  try {
    telemetry.emit(event);
  } catch (err) {
    console.error(
      `[pangolin telemetry] hook '${telemetry.name}' threw on ${event.kind}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
