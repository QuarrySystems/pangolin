// packages/pangolin-orchestrator/src/serve/http.ts
//
// Opt-in HTTP observability for the serve() loop: /healthz (heartbeat liveness),
// /readyz (last-error-free-tick readiness), /metrics (Prometheus text). The decision
// logic (evaluateHealth) is pure and lives here; the server (startHealthServer, Task 4)
// is added below it.

/** Liveness/readiness heartbeat, shared BY REFERENCE between serve() and the HTTP server. */
export interface ServeHealth {
  /** True once the reconcile-first tick before the main loop has completed. */
  started: boolean;
  /** Epoch ms of the most recent loop iteration that finished (success OR caught error). */
  lastTickAt: number;
  /** Epoch ms of the most recent iteration that finished with NO outer-catch error. */
  lastTickOkAt: number;
}

export interface HealthVerdict {
  live: boolean;
  ready: boolean;
  reason: 'starting' | 'stale' | 'not-ready' | 'ok';
}

/** Pure decision. Liveness keys off lastTickAt; readiness off lastTickOkAt — NEVER swapped:
 *  driving restarts off readiness would cause dependency-outage restart storms. */
export function evaluateHealth(
  health: ServeHealth,
  now: number,
  t: { livenessTimeoutMs: number; readinessTimeoutMs: number },
): HealthVerdict {
  if (!health.started) return { live: false, ready: false, reason: 'starting' };
  if (now - health.lastTickAt > t.livenessTimeoutMs) {
    return { live: false, ready: false, reason: 'stale' };
  }
  const ready = now - health.lastTickOkAt <= t.readinessTimeoutMs;
  return { live: true, ready, reason: ready ? 'ok' : 'not-ready' };
}
