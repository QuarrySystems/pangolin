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

/** Fan a single telemetry slot out to several hooks. Reuses the existing per-emit guard
 *  (`emitLifecycleEvent`) for EACH sub-hook, so a throwing hook is caught + logged and does not
 *  stop the others. Lets an operator run e.g. ConsoleTelemetryHook + MetricsTelemetryHook together. */
export function combineTelemetryHooks(...hooks: TelemetryHook[]): TelemetryHook {
  return {
    name: 'combined',
    emit(event): void {
      for (const h of hooks) emitLifecycleEvent(h, event);
    },
  };
}
