// Metrics seam — a tiny, backend-agnostic recorder. Mirrors the TelemetryHook pattern: the
// interface lives in core; concrete backends (Prometheus/OTel/HTTP) are operator-chosen adapters,
// never a core dependency. Names are `pangolin_` snake_case (`_total` counters, `_seconds`
// durations); labels MUST be bounded-cardinality (e.g. outcome, queue) — never dispatchId/runId.

export interface MetricsRecorder {
  readonly name: string;
  /** Increment a counter by `value` (default 1). */
  counter(name: string, value?: number, labels?: Record<string, string>): void;
  /** Set a gauge to `value`. */
  gauge(name: string, value: number, labels?: Record<string, string>): void;
  /** Observe a value into a histogram. */
  histogram(name: string, value: number, labels?: Record<string, string>): void;
}

/** Point-in-time view of an aggregating recorder (see InMemoryMetricsRecorder.snapshot()). Keys are
 *  Prometheus-style series ids: `name` alone, or `name{k="v",…}` with labels sorted by key. */
export interface MetricsSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<string, { count: number; sum: number; buckets: Record<string, number> }>;
}

/** Default recorder: drops every metric. Used wherever `metrics` is unset. */
export class NoopMetricsRecorder implements MetricsRecorder {
  readonly name = 'noop';
  counter(): void {
    /* drop */
  }
  gauge(): void {
    /* drop */
  }
  histogram(): void {
    /* drop */
  }
}

/** Guarded recording: a throwing recorder must NEVER break a tick or dispatch. `undefined` is a
 *  no-op; a throw is caught and logged loudly to stderr (repo convention) and never rethrown. */
export function recordMetric(
  recorder: MetricsRecorder | undefined,
  record: (r: MetricsRecorder) => void,
): void {
  if (!recorder) return;
  try {
    record(recorder);
  } catch (err) {
    console.error(
      `[pangolin metrics] recorder '${recorder.name}' threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
