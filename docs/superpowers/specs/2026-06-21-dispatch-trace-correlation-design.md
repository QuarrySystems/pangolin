# Dispatch trace correlation — design

**Date:** 2026-06-21
**Status:** approved (design) — pending implementation plan
**Scope:** `pangolin-core` (the `TraceContext` type + an optional `trace` field on `DispatchWork` and every `LifecycleEvent`), `pangolin-client` (thread `trace` through the dispatch path + default it), `pangolin-orchestrator` (populate `trace` from run/item at fire time).

> This is sub-project **3b** of the deferred "#3 health/readiness + tracing" observability work — the **tracing** half. It delivers lightweight end-to-end **correlation**, not span export to a tracing backend. Health/readiness + the metrics endpoint shipped as **3a** (PR #80, merged).

## Problem

A dispatch's telemetry is correlatable *within itself* but not *across* the layers it belongs to. Every `LifecycleEvent` carries a `dispatchId` (minted by the client, injected into the worker as `PANGOLIN_DISPATCH_ID`, tagged on the provider task), so the ~5 events of a single dispatch already group by `dispatchId`. But:

- Lifecycle events carry **only** `dispatchId` — no `runId`/`itemId` and no trace identity. A consumer watching the telemetry stream cannot tell which **run** a dispatch belongs to, or group the many dispatches of one orchestrated run, without a side join against the dispatch record/manifest in storage.
- The orchestrator *knows* `runId` and `itemId` at fire time (it writes them into the audit manifest) but does not thread them onto the telemetry stream.

The result: no live "follow one logical unit of work — run → item → dispatch" view. This spec closes that with a small, pure-data correlation context carried on the events that already exist.

## Goals

1. A tiny, dependency-free `TraceContext` in `pangolin-core` carried on the dispatch input and on every `LifecycleEvent`.
2. A single **uniform `traceId`** present on every event in both modes — orchestrated (`traceId = runId`) and standalone (`traceId = dispatchId`), so a consumer always has one group-by key.
3. Correlation rides the **live event stream** (no consumer-side storage joins); also stamped into the dispatch record for after-the-fact joins.
4. Additive and backward-compatible — existing consumers (`MetricsTelemetryHook`, `ConsoleTelemetryHook`) keep compiling and working untouched. Zero new dependencies.

## Non-goals (explicit scope boundaries)

- **Worker-side propagation** — no new `PANGOLIN_TRACE_ID`/`PANGOLIN_RUN_ID`/`PANGOLIN_ITEM_ID` env, no worker-image change, no tagging of the worker's own `blocks[]`/stdout events. The worker stays reachable via the existing `dispatchId` (the dispatch record carries `runId`/`itemId`/`traceId`, so a consumer can still join down by `dispatchId`). A separable future increment.
- **W3C `traceparent` hex format** — `traceId` reuses the existing readable ids (`runId`/`dispatchId`), not 16-byte hex. A future OTel adapter can hash them into W3C form if needed; forcing hex now adds opacity for no present benefit.
- **OpenTelemetry / span export** — no spans, no OTel SDK, no exporter, no tracing backend. This produces correlation identity on the existing telemetry/audit streams, which a future adapter could map to spans.
- **High-cardinality metric labels** — `traceId`/`runId`/`dispatchId` stay OUT of the metrics layer (its bounded-cardinality rule is unchanged); trace identity lives on the *telemetry* stream, not on counters/gauges.

## Decisions (from brainstorming)

- **Correlation, not span export** — lightweight, dependency-light, matching how telemetry/metrics shipped.
- **Client + orchestrator scope** — no worker-image change; the worker is already reachable by `dispatchId`.
- **Uniform `traceId`** (+ optional `runId`/`itemId`) — one always-present group-by key; readable ids, no W3C hex.
- **(A) Trace context as an optional field on the dispatch input + each `LifecycleEvent`** — threaded the way `dispatchId` already flows. (Rejected: B — consumer-side record joins, defeats live-stream correlation; C — a separate trace-mapping event/registry, two streams to stitch.)

## Design

### The seam (`pangolin-core`)

A new `trace.ts`, consumed by both `lifecycle.ts` (events) and `dispatch.ts` (the `DispatchWork` input):

```ts
/**
 * Correlation identity for a dispatch — the lightweight "tracing" surface. Pure data;
 * carried on DispatchWork and every LifecycleEvent so a consumer can follow one logical
 * unit of work (run -> item -> dispatch) on the live telemetry stream. Not OTel spans.
 */
export interface TraceContext {
  /** The logical operation this dispatch belongs to. Orchestrated: the runId.
   *  Standalone client.dispatch: defaults to the dispatchId (a single-dispatch trace). */
  traceId: string;
  /** Set when the dispatch is part of an orchestrated run. */
  runId?: string;
  /** The run item that produced this dispatch (an item may retry -> several dispatches share itemId). */
  itemId?: string;
}
```

Changes:
- `DispatchWork` gains an optional `trace?: TraceContext` (the caller-supplied correlation context).
- Each of the six `LifecycleEvent` variants gains an optional `trace?: TraceContext`. (Additive optional field — no existing consumer breaks.)
- `TraceContext` is exported from the core barrel.

### Client threading + default (`pangolin-client`)

- `fireWork` resolves the effective trace **once**, next to where it mints the dispatchId: `const trace = work.trace ?? { traceId: dispatchId }`. So a standalone dispatch (no `trace` supplied) always gets `traceId = dispatchId`.
- The resolved `trace` is carried on the returned `InFlightDispatch` (a new `readonly trace: TraceContext`), so `reconcile()` (which emits `finished`/`failed`/`needs_input`) and the `awaitExit` rejection path (`failed`) have it without re-deriving.
- Every `emitLifecycleEvent(...)` call in the dispatch path attaches `trace`: `accepted` + `started` (in `fireWork`), `finished`/`failed`/`needs_input` (in `reconcile`), and the `awaitExit`-rejection `failed`.
- The dispatch record (`writeDispatchRecord`) stamps `trace` so an after-the-fact join by `dispatchId → trace` is possible without replaying the stream.
- **Cancellation (`cancel.ts`):** `cancelDispatch` is record-based (it reaps from the persisted dispatch record). It reads `trace` from that record and attaches it to the `cancelled` event; if a record predates this change and has no `trace`, it defaults to `{ traceId: dispatchId }`. (Consistent with the existing record-driven cancel path — no new shared state between fire and cancel.)

### Orchestrator population (`pangolin-orchestrator`)

`DispatchExecutor.fire` already has the run/item context (`ctx?.runId`, `item.id`). It passes a `trace` into `client.dispatch.fire` **only when a `runId` is present**:

```ts
trace: ctx?.runId ? { traceId: ctx.runId, runId: ctx.runId, itemId: item.id } : undefined,
```

When `runId` is absent (the defensive `ctx?.runId ?? ''` path), `trace` is left unset and the client defaults `traceId = dispatchId` — never an empty `traceId`. Both consumption paths get correct correlation because they share the one client fire path: the blocking `client.dispatch()` (standalone → `traceId = dispatchId`) and the orchestrator's `DispatchExecutor` (→ `traceId = runId`, with `runId`/`itemId`).

### Why this is the whole change

`traceId` is always populated (orchestrator sets it, or the client defaults it), so the rule "every event carries a `traceId`" holds without a non-optional field on the wire type (keeping the change additive/backward-compatible). The orchestrated dimension (`runId`/`itemId`) is present exactly when meaningful.

## Error handling

No new failure modes. `trace` is pure data on an already-guarded, fire-and-forget emission — `emitLifecycleEvent`'s try/catch is unchanged, and a malformed/absent `trace` cannot break a dispatch (the client always has the `{ traceId: dispatchId }` default). The orchestrator never throws on a missing `runId` — it simply omits `trace`.

## Testing plan (TDD, unit-level)

- **`pangolin-client`:** a supplied `work.trace` appears on every emitted event (`accepted`/`started`/`finished`/`failed`/`needs_input`) via a `RecordingTelemetryHook`; an unsupplied `trace` defaults `traceId = dispatchId` on every event; the `cancelled` event carries the trace read from the record (and defaults when the record lacks one); the dispatch record contains `trace`.
- **`pangolin-orchestrator`:** a dispatch driven through `DispatchExecutor` with a run context emits events carrying `{ traceId: runId, runId, itemId }`; a fire with no `runId` yields events with `traceId = dispatchId` and no `runId`/`itemId`.
- **Backward-compat:** an existing telemetry consumer (e.g. the metrics hook) still receives and processes events unchanged when `trace` is present (it ignores the field).

No new integration surface required.

## Risks / edge cases

- **An item that retries** produces multiple dispatches sharing `itemId` (and `runId`/`traceId`) with distinct `dispatchId`s — correct and intended (the retries are part of the same logical item).
- **Older dispatch records** (pre-change) have no `trace`; the cancel path defaults `{ traceId: dispatchId }`, so correlation degrades gracefully to dispatch-only rather than erroring.
- **`traceId` never empty** — guaranteed by the client default; the orchestrator omits `trace` rather than passing an empty `runId`.
- **Cardinality** — these ids are deliberately confined to the telemetry/audit streams; they must never leak into metric labels (the metrics layer's bounded-cardinality rule stands).
