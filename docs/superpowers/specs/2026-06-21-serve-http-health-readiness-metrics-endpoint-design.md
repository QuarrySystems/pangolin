# Serve HTTP endpoint — health, readiness, metrics exposure — design

**Date:** 2026-06-21
**Status:** approved (design) — pending implementation plan
**Scope:** `pangolin-orchestrator` (an opt-in HTTP server on the `serve` loop + a heartbeat threaded through the loop), `pangolin-core` (a pure Prometheus-text renderer for `MetricsSnapshot`), and `deploy/serve-stack` (the first consumer: Dockerfile `HEALTHCHECK` + compose wiring).

> This is sub-project **3a** of the deferred "#3 health/readiness + tracing" observability work. **3b — tracing / correlation-ID propagation — is split into its own later spec** and is out of scope here.

## Problem

A deployable orchestration container already exists (`deploy/serve-stack/`): a hardened multi-stage image running the `serve()` tick+inbox loop, non-root, with persisted SQLite run-state + signer seed, launching sibling workers over the Docker socket. It is production-shaped in every way **except observability** — it is a black box:

- The `serve` service has **no healthcheck** (only MinIO and LocalStack do). Its sole liveness mechanism is compose's `restart: unless-stopped`, which fires only when the **process exits**. If the tick loop *wedges* (a hung poll, a deadlocked `await`) while PID 1 stays alive, nothing notices — Docker reports healthy, nothing restarts it, no alert fires.
- The Dockerfile deliberately opens **no inbound port** ("No EXPOSE — the serve container opens no inbound port").
- The metrics layer (PR #79) collects counters/gauges/histograms into `InMemoryMetricsRecorder.snapshot()`, but there is **no scrape surface** — the snapshot is unreachable from outside the process.

Both the telemetry and metrics specs explicitly deferred the HTTP `/metrics` endpoint and health/readiness to "#3". This spec delivers that endpoint and makes the existing serve container genuinely self-monitoring.

## Goals

1. An **opt-in HTTP server** on `serve()` exposing three routes — `/healthz` (liveness), `/readyz` (readiness), `/metrics` (Prometheus text) — using only Node's built-in `http` (zero new dependencies).
2. **Heartbeat liveness** that detects a *wedged* loop, not just a dead process: `serve()` records a last-completed-tick timestamp; `/healthz` goes stale (503) when the loop stops progressing.
3. **Readiness that reflects dependency health** without per-backend probe interfaces: `serve()` also records the last *error-free* tick; `/readyz` degrades (503) when ticks are still running but failing (e.g. S3/SQLite down).
4. A pure, dependency-free **Prometheus-text renderer** for `MetricsSnapshot` in `pangolin-core`, reusable by any future exporter.
5. Wire the endpoint into `deploy/serve-stack` as the first consumer (Dockerfile `EXPOSE` + `HEALTHCHECK`, compose), making the existing container production-grade.

## Non-goals (explicit scope boundaries)

- **Tracing / correlation-ID propagation (3b)** — its own later spec. No spans, no trace IDs here.
- **OpenTelemetry / `prom-client` / any metrics SDK** — the renderer is a pure string function over the existing snapshot; heavier OTel/push adapters remain out-of-core, built on this surface later.
- **Authentication / TLS on the endpoints** — v1 is unauthenticated, expected to bind to a trusted/internal interface (documented). The metrics payload is bounded-cardinality and carries no secrets or audit material by design; health routes carry nothing sensitive.
- **Per-dependency probe breakdown** (which *specific* backend is down) — readiness infers aggregate dependency health from tick success (option B below). A `probe()` contract on every transport/store/storage is deferred (option C, future, only if a deployment needs it).
- **A published/versioned `pangolin-serve` GHCR image, Helm chart, multi-tenancy** — larger deployment-packaging work, separate from this endpoint.
- **Endpoints for non-`serve` contexts** (e.g. the blocking `client.dispatch`) — health/readiness only make sense for the long-running loop.

## Decisions (from brainstorming)

- **(A)** The HTTP server lives in the orchestrator `serve` module as an **opt-in `serve()` option** — not a new package (B, rejected: forces a cross-package contract to expose loop-owned heartbeat state, no isolation gain) and not deploy-only (C, rejected: not reusable/testable; any other embedder re-implements it). The serve-stack is the first *consumer*, not the owner.
- **Heartbeat liveness** — `/healthz` keys off the last *attempted* tick; detects a wedged loop. (Shallow "process responds" liveness rejected — it duplicates `restart: unless-stopped`.)
- **(B) Readiness = last error-free tick** — `/readyz` keys off the last tick that completed without a caught error; catches "loop still spinning but every tick throwing (deps down)". No new per-backend probe interfaces. (C, active per-dependency probes, deferred.)
- **No auth for v1**, trusted-interface expectation documented.
- **Liveness and readiness use different timestamps by design** — liveness MUST NOT key off the error-free timestamp, or a dependency outage would trigger restart storms (restarting a container never fixes a downstream S3 outage). Correct Kubernetes semantics: a dependency outage pulls the instance from rotation (readiness red) but does **not** restart it (liveness green).

## Design

### The serve heartbeat (`pangolin-orchestrator/src/serve/driver.ts`)

`serve()` maintains one mutable record, shared by reference with the HTTP handler:

```ts
export interface ServeHealth {
  /** True once the reconcile-first tick before the main loop has completed. */
  started: boolean;
  /** Epoch ms of the most recent loop iteration that finished (success OR caught error). */
  lastTickAt: number;
  /** Epoch ms of the most recent iteration that finished with NO outer-catch error. */
  lastTickOkAt: number;
}
```

Threading (minimal change to the existing loop):

- Initialize `const health: ServeHealth = { started: false, lastTickAt: 0, lastTickOkAt: 0 }` before `recoverStranded`.
- After the reconcile-first `await opts.orchestrator.tick(queue)` succeeds: set `started = true` and `lastTickAt = lastTickOkAt = now()`.
- In the loop body, the existing structure is `try { …poll/submit/control/scheduler/tick/publish… } catch (err) { onError(err) }`. Set `health.lastTickOkAt = now()` as the **last statement inside the `try`** (reached only when the iteration's core work — including `orchestrator.tick` and the status `publish` — did not throw). Set `health.lastTickAt = now()` **after** the catch (every completed iteration, success or handled error).
- The existing **inner** per-envelope / per-control / per-scheduler `catch`es (poison submissions → dead-letter, etc.) are unchanged and do **not** flip `lastTickOkAt`: a poison run must not make the instance "not ready". Only an outer-level failure (a throwing `tick` or `publish` — the dependency-touching operations) degrades readiness.

This reuses the loop's existing error boundary as the dependency-health signal (DRY) — no new probe surface.

### The HTTP server (`pangolin-orchestrator/src/serve/http.ts`)

```ts
import type { MetricsSnapshot } from '@quarry-systems/pangolin-core';

export interface HealthServerOptions {
  port: number;
  host?: string;                          // default '0.0.0.0'
  health: ServeHealth;                    // shared by reference with serve()
  livenessTimeoutMs: number;
  readinessTimeoutMs: number;
  now: () => number;
  /** When omitted, /metrics returns 404 (metrics not enabled for this serve). */
  metricsSnapshot?: () => MetricsSnapshot;
}

export interface HealthServerHandle {
  /** Resolves once the listener is closed. */
  close(): Promise<void>;
  /** The bound port (useful when port 0 was requested in tests). */
  readonly port: number;
}

export function startHealthServer(opts: HealthServerOptions): Promise<HealthServerHandle>;
```

Routes (all GET; any other method → `405`; unknown path → `404`):

| Route | Condition | Status | Body (JSON unless noted) |
|---|---|---|---|
| `/healthz` | `!started` | `503` | `{status:'starting'}` |
| | `now - lastTickAt > livenessTimeoutMs` | `503` | `{status:'stale', lastTickAt}` |
| | otherwise | `200` | `{status:'ok', lastTickAt}` |
| `/readyz` | `!started` | `503` | `{status:'starting'}` |
| | `now - lastTickOkAt > readinessTimeoutMs` | `503` | `{status:'not-ready', lastTickOkAt}` |
| | otherwise | `200` | `{status:'ready', lastTickOkAt}` |
| `/metrics` | no `metricsSnapshot` provider | `404` | `{status:'metrics-disabled'}` |
| | provider throws | `500` | `{status:'error'}` (logged to stderr) |
| | otherwise | `200` | Prometheus text, `Content-Type: text/plain; version=0.0.4` |

- Every handler is wrapped so it **never throws out of the server**; an unexpected internal error returns `500` and is logged `[pangolin serve-http] handler error: <msg>` to stderr (repo's operator-output-on-stderr convention).
- `startHealthServer` **rejects** on a bind failure (e.g. `EADDRINUSE`) so a misconfigured deploy fails fast and visibly — a serve container whose health port cannot bind is broken (its `HEALTHCHECK` would never pass).

### Integration in `serve()`

`ServeOptions` gains:

```ts
http?: {
  port: number;
  host?: string;
  livenessTimeoutMs?: number;   // default: max(tickIntervalMs * 4, 60_000)
  readinessTimeoutMs?: number;  // default: max(tickIntervalMs * 4, 60_000)
  metricsSnapshot?: () => MetricsSnapshot;
};
```

When `opts.http` is set, `serve()` starts the HTTP server **immediately after initializing `health` — before `recoverStranded` and the reconcile-first tick** — so probes are live throughout startup (returning `503 starting` until the first tick completes; a hung startup is then caught by the `HEALTHCHECK` `start-period`). The startup-and-loop body is wrapped so the server is closed in a `finally` when the loop exits (signal aborted) **or** if startup throws. When `opts.http` is unset, behaviour is unchanged (no server, no open port) — embedded library users never get a surprise listener. Defaults for the staleness windows derive from `tickIntervalMs` (generous — several intervals — to avoid flapping on a single slow tick) and are overridable.

The `metricsSnapshot` provider is supplied by the integrator as `() => recorder.snapshot()`, using the **same** shared `InMemoryMetricsRecorder` already wired to client telemetry and the orchestrator (the established "one shared recorder" pattern from the metrics spec). The HTTP server depends only on the snapshot shape, not on any concrete recorder.

### The Prometheus renderer (`pangolin-core/src/metrics-prometheus.ts`)

A pure function, dependency-free, exported from the core index:

```ts
export function renderPrometheus(snapshot: MetricsSnapshot): string;
```

Rules (Prometheus text exposition format, version 0.0.4):

- A `# TYPE <bare-name> <counter|gauge|histogram>` line is emitted **once per metric family**, keyed by the *bare* metric name. The snapshot's series keys are either `name` or `name{k="v",…}`; the bare name is the substring before `{`. Counters, gauges, and histograms are grouped so each family's TYPE line appears exactly once even across multiple label-series.
- **Counters / gauges:** one line per series — `<seriesKey> <value>` (the seriesKey already carries any labels).
- **Histograms:** for each histogram series `{count, sum, buckets}` (where `buckets` maps an `le`-bound string → cumulative count):
  - one `<name>_bucket{<labels>,le="<bound>"} <cumulativeCount>` line per bound, in ascending bound order, **plus** a `<name>_bucket{<labels>,le="+Inf"} <count>` line;
  - a `<name>_sum{<labels>} <sum>` line and a `<name>_count{<labels>} <count>` line.
  - Label injection: given a series key `name{a="1"}` and an extra `le="0.5"`, the bucket line is `name_bucket{a="1",le="0.5"}`; for an unlabeled series `name`, it is `name_bucket{le="0.5"}`. `_sum`/`_count` carry the series' original labels (no `le`).
- Deterministic output: families in insertion order of the snapshot maps; histogram bounds in ascending numeric order with `+Inf` last. An empty snapshot renders to an empty string.

Rationale for core placement: the renderer depends only on `MetricsSnapshot` (already core) and produces a string — no new dependency — keeping the snapshot and its canonical text rendering together and unit-testable in core, reusable by a future standalone exporter. Heavier OTel/`prom-client` adapters stay out of core.

### `deploy/serve-stack` wiring (first consumer)

- **`serve-entrypoint.mjs`** — read `PANGOLIN_HTTP_PORT` (default `9464`), and pass `http: { port, metricsSnapshot: () => recorder.snapshot() }` into `serve()`, using the config's shared metrics recorder. (The metrics recorder is added to the deploy config alongside the existing client/orchestrator wiring.)
- **`Dockerfile`** — add `EXPOSE 9464` and a `HEALTHCHECK` that probes `/healthz` using Node itself (no `curl`/`wget` in `node:20-slim`):
  ```dockerfile
  HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PANGOLIN_HTTP_PORT||9464)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
  ```
  (`start-period` covers startup before the first tick, when `/healthz` returns `503 starting`.)
- **`docker-compose.yml`** — the `serve` service relies on the image `HEALTHCHECK` (or an equivalent compose `healthcheck:` block). The metrics port is **not published to the host** — within the compose network a Prometheus scraper reaches `serve:9464` by service name. Document the trusted-interface expectation: do not expose `/metrics` to the public internet; for laptop access use the existing SSH tunnel rather than a host port.
- **`RUNBOOK.md`** — document the three routes, the liveness-vs-readiness distinction (a red `/readyz` with green `/healthz` means "deps unreachable, not a wedged loop — do not restart, investigate S3/SQLite"), the port, and the no-auth/trusted-interface posture.

## Error handling

- Handlers never throw out of the server (wrapped → `500` + stderr log). A throwing `metricsSnapshot` provider yields `500` on `/metrics` only; the server stays up.
- `startHealthServer` rejects on bind failure → `serve()` propagates it (fail fast at startup; an unbindable health port is a misconfiguration the operator must see).
- The HTTP server is closed on serve shutdown (signal abort) via `finally`.
- Liveness keys off `lastTickAt`, readiness off `lastTickOkAt` — never swapped — to avoid dependency-outage restart storms.

## Testing plan

- **`renderPrometheus` (core):** counters and gauges (with and without labels); a histogram renders `_bucket` lines (cumulative, ascending, `+Inf` = count) + `_sum` + `_count`; `# TYPE` appears exactly once per family even with multiple label-series; label injection puts `le` last; an empty snapshot → empty string; output is deterministic.
- **`startHealthServer` (orchestrator):** drive a hand-built `ServeHealth` + injected `now`. Assert `/healthz` = `200` when `lastTickAt` fresh, `503 stale` when old, `503 starting` when `!started`; `/readyz` keyed off `lastTickOkAt` **independently** of `lastTickAt` — the load-bearing case: `lastTickAt` fresh but `lastTickOkAt` stale → `/healthz 200` **and** `/readyz 503` (live but not ready); `/metrics` renders a provided snapshot, `404` with no provider, `500` when the provider throws; unknown path → `404`; non-GET → `405`. Use a real listener on port `0` (ephemeral) + global `fetch`.
- **`serve()` integration:** with the `http` option, a fake transport, and an injected clock, assert `started` flips after the first tick and `lastTickAt`/`lastTickOkAt` advance per iteration; an iteration whose `tick` throws advances `lastTickAt` but **not** `lastTickOkAt` (readiness degrades while liveness holds — the core semantic); the server closes when the signal aborts.

## Risks / edge cases

- **Restart storms** — avoided by the liveness/readiness timestamp split (documented, tested).
- **Flapping** — staleness windows default to several `tickIntervalMs` and are configurable; the `HEALTHCHECK` uses `--start-period` + `--retries`.
- **Slow ticks** — a single tick slower than `tickIntervalMs` must not trip liveness; the default window is ≥4 intervals (and ≥60s).
- **Port exposure** — unauthenticated v1; documented trusted-interface expectation; the serve-stack does not publish the port to the host.
- **`HEALTHCHECK` requires global `fetch`** — present on `node:20` (Node 18+); the image is already `node:20-slim`.
- **`metricsSnapshot` cost** — `InMemoryMetricsRecorder.snapshot()` deep-copies; at scrape frequency (seconds) this is negligible, but the provider is called per `/metrics` request, so a pathological scrape rate is the operator's concern (standard Prometheus practice).
