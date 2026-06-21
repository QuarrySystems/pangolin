# Metrics layer — design

**Date:** 2026-06-19
**Status:** approved (design) — pending implementation plan
**Scope:** `pangolin-core` (the seam + reference impl), `pangolin-client` (the dispatch-metrics telemetry bridge + a telemetry-hook combinator), `pangolin-orchestrator` (engine instrumentation).

## Problem

Pangolin Scale has a strong *audit-side* observability story but a thin *operational* one. There is no metrics layer: no counters/gauges/histograms, no way to answer "how deep is the queue / what's my dispatch failure & retry & hang rate / how many runs completed / how long do dispatches take." `AuditLog.droppedAppends` is an in-memory field that nothing exports. The dispatch-lifecycle `TelemetryHook` spine now exists (six `LifecycleEvent`s emitted from the client dispatch path) and is the natural substrate for dispatch-level metrics, but nothing derives metrics from it, and the orchestrator's own signals (queue depth, retries, deadline force-fails, run completion) are unrecorded.

This spec adds a **dependency-light metrics layer**: a `MetricsRecorder` seam, a usable in-memory reference impl, and instrumentation at two sources (the dispatch lifecycle and the orchestrator engine). It deliberately stops at *collection* — *exposure* (an HTTP `/metrics` endpoint) and concrete Prometheus/OTel backends are out of scope (future #3 / adapter packages).

## Goals

1. A small, backend-agnostic `MetricsRecorder` interface (counter/gauge/histogram), mirroring the repo's `TelemetryHook` seam pattern. Default `NoopMetricsRecorder`.
2. A real, usable reference impl (`InMemoryMetricsRecorder`) with a `snapshot()` so it's immediately testable and consumable — not a "defined but dead" seam.
3. Instrument both sources through one shared recorder: dispatch-level (via the telemetry spine) and orchestrator-level (via the engine), with **no double-counting**.
4. Keep the core dependency-light: no Prometheus/OTel/HTTP dependency. Bounded-cardinality labels only.

## Non-goals (explicit scope boundaries)

- **No HTTP `/metrics` endpoint** — exposure is the deferred health/endpoint work (#3). This spec's exposure surface is `snapshot()`.
- **No Prometheus/OTel backend** — those are optional adapter packages built *on top of* this seam later; the core commits to neither.
- **No high-cardinality labels** — metrics are dimensioned only by bounded values (`outcome`, `queue`). Never `dispatchId`/`runId`.
- **No histogram percentile rendering** — the snapshot exposes raw `{count, sum, buckets}`; computing p50/p95 is the adapter's/endpoint's job.

## Decisions (from brainstorming)

- **(A)** A `MetricsRecorder` *seam* + reference impl — not a baked-in Prometheus/OTel backend.
- **(b)** Two sources — dispatch-level (telemetry) **and** orchestrator-level (engine).
- **(i)** In-memory aggregator with `snapshot()`; exposure deferred to #3.
- Bounded-cardinality labels only (hard rule).

## Design

### The seam (`pangolin-core`)

```ts
export interface MetricsRecorder {
  readonly name: string;
  /** Increment a counter by `value` (default 1). */
  counter(name: string, value?: number, labels?: Record<string, string>): void;
  /** Set a gauge to `value`. */
  gauge(name: string, value: number, labels?: Record<string, string>): void;
  /** Observe a value into a histogram. */
  histogram(name: string, value: number, labels?: Record<string, string>): void;
}
```

Contract (documented on the interface): metric names are `pangolin_`-prefixed `snake_case`, counters end `_total`, durations end `_seconds`; labels are bounded-cardinality only. Implementations must be cheap and non-throwing; callers route through a guard regardless (below).

- **`NoopMetricsRecorder`** — `name='noop'`; every method is a no-op. The default everywhere `metrics` is unset.

### Reference impl (`pangolin-core`)

- **`InMemoryMetricsRecorder`** — `name='in-memory'`. Aggregates into three maps keyed by a Prometheus-style **series key**: the metric `name` alone when there are no labels, else `name{k1="v1",k2="v2"}` with labels sorted by key. Counters sum; gauges last-write-wins; histograms accumulate `{count, sum, buckets}` over a configurable bucket boundary list (default seconds boundaries `[0.5, 1, 5, 10, 30, 60, 300, 900, 1800, 3600, 7200]`, covering sub-second to the 2h dispatch deadline).
- **`snapshot(): MetricsSnapshot`** returns a deep-copied plain object:

```ts
export interface MetricsSnapshot {
  counters: Record<string, number>;                                   // seriesKey -> value
  gauges: Record<string, number>;                                     // seriesKey -> value
  histograms: Record<string, { count: number; sum: number; buckets: Record<string, number> }>; // le-bound -> cumulative count
}
```

This is the entire exposure surface. A future `/metrics` endpoint (#3) or a Prometheus/OTel adapter reads `snapshot()` and renders.

### Guarded recording (`pangolin-core`)

```ts
export function recordMetric(recorder: MetricsRecorder | undefined, record: (r: MetricsRecorder) => void): void;
```

`undefined` → no-op; otherwise `record(recorder)` inside try/catch; on throw, log `[pangolin metrics] recorder '<name>' threw: <message>` to **stderr** (`console.error`, repo convention) and never rethrow. Every instrumentation call site uses this helper, so a buggy recorder can never break a tick or a dispatch (same principle as `emitLifecycleEvent`/`AuditLog.onDrop`).

### Source 1 — dispatch-level, via the telemetry spine (`pangolin-client`)

- **`MetricsTelemetryHook implements TelemetryHook`** (`bundled-impls.ts`, sibling of the other hooks). `name='metrics'`; constructed with a `MetricsRecorder`. `emit(event)` maps each `LifecycleEvent` to recorder calls (via `recordMetric`):
  - `started` → `counter('pangolin_dispatch_started_total')`
  - `finished` → `counter('pangolin_dispatch_completed_total', 1, {outcome:'finished'})` + `histogram('pangolin_dispatch_duration_seconds', durationMs/1000)`
  - `needs_input` → `counter(..., {outcome:'needs_input'})` + duration histogram
  - `failed` → `counter(..., {outcome:'failed'})` (no duration — the `failed` event carries no `durationMs`)
  - `cancelled` → `counter(..., {outcome:'cancelled'})`
  - `accepted` → no metric (the set tracks `started`, not `accepted`)

  Dispatch-outcome classification therefore lives in exactly one place (the lifecycle) and is reused, not re-derived.

- **`combineTelemetryHooks(...hooks: TelemetryHook[]): TelemetryHook`** (`pangolin-client`) — since `client.telemetry` is a single slot, this returns a composite hook whose `emit` fans out to each sub-hook by **reusing the existing `emitLifecycleEvent` guard per sub-hook** (DRY — not a new guard): `emit(e) { for (const h of hooks) emitLifecycleEvent(h, e); }`. So a throwing sub-hook is caught + logged and does not stop the others, and an operator can run metrics and `ConsoleTelemetryHook` together: `telemetry: combineTelemetryHooks(new ConsoleTelemetryHook(), new MetricsTelemetryHook(recorder))`.

### Source 2 — orchestrator-level (`pangolin-orchestrator`)

- `PangolinOrchestratorOptions` gains `metrics?: MetricsRecorder` (default `NoopMetricsRecorder`), threaded into `tick`.
- `tick` records (all via `recordMetric`), at points it already computes:
  - `gauge('pangolin_queue_depth', <ready+pending count in queue>, {queue})` and `gauge('pangolin_running', runningCount(queue), {queue})` once per tick.
  - retry branch → `counter('pangolin_items_retried_total')`.
  - deadline overrun branch → `counter('pangolin_dispatch_deadline_exceeded_total')`.
  - cascade skip → `counter('pangolin_items_skipped_total')` per skipped item.
- The orchestrator (in `orchestrator.ts`, where `auditLog` and the seal live) records:
  - on a run sealing/completing → `counter('pangolin_runs_completed_total')`.
  - `gauge('pangolin_audit_dropped_appends', auditLog.droppedAppends)` (the completeness counter, finally exported).

### No double-counting

Dispatch outcomes come **only** from `MetricsTelemetryHook` (the lifecycle); orchestrator signals come **only** from the engine. A deadline force-fail correctly increments **both** `dispatch_completed_total{outcome=failed}` (it produces a `failed` lifecycle event) **and** `dispatch_deadline_exceeded_total` (the engine's specific signal) — total failures vs. specifically-deadline failures, which is the intended, useful distinction.

### The metric set

| Metric | Type | Labels | Source |
|---|---|---|---|
| `pangolin_dispatch_started_total` | counter | — | telemetry |
| `pangolin_dispatch_completed_total` | counter | `outcome` ∈ {finished, failed, needs_input, cancelled} | telemetry |
| `pangolin_dispatch_duration_seconds` | histogram | — | telemetry (finished, needs_input) |
| `pangolin_queue_depth` | gauge | `queue` | tick |
| `pangolin_running` | gauge | `queue` | tick |
| `pangolin_items_retried_total` | counter | — | tick |
| `pangolin_items_skipped_total` | counter | — | tick |
| `pangolin_dispatch_deadline_exceeded_total` | counter | — | tick |
| `pangolin_runs_completed_total` | counter | — | orchestrator |
| `pangolin_audit_dropped_appends` | gauge | — | orchestrator |

## Testing plan

- **`InMemoryMetricsRecorder`** — counter sum, gauge last-write, histogram bucket accumulation + `sum`/`count`; series-key formatting (no-label vs sorted-label); `snapshot()` returns an independent deep copy.
- **`recordMetric`** — `undefined` no-op; forwards to the recorder; a throwing recorder is swallowed + logged.
- **`MetricsTelemetryHook`** — drive each `LifecycleEvent` kind through a hook backed by an `InMemoryMetricsRecorder`, assert the snapshot (correct counters/labels; duration observed on finished/needs_input, not failed/cancelled; nothing on accepted).
- **`combineTelemetryHooks`** — both sub-hooks receive the event; a throwing sub-hook doesn't stop the other.
- **Orchestrator** — reuse the existing `tick`/orchestrator test harness with an injected `InMemoryMetricsRecorder`; assert queue_depth/running gauges, retried/skipped/deadline_exceeded counters at the right transitions, and runs_completed + audit_dropped_appends after a seal.

## Risks / edge cases

- **Cardinality** — enforced by convention + review, not by the type system; the metric set uses only `outcome`/`queue`. Adapter authors must preserve this.
- **Histogram buckets** — the default seconds boundaries are a reasonable spread for agent dispatches; configurable on `InMemoryMetricsRecorder`. Rendering/percentiles are an adapter concern.
- **Double-count** — avoided by the strict source split (documented above); the one intentional overlap (deadline → both failed + deadline_exceeded) is by design.
- **Guard noise** — a persistently-throwing recorder logs every call; acceptable (loud-by-default), and a real recorder shouldn't throw.
