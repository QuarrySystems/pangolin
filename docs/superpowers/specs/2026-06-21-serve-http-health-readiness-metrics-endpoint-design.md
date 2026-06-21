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
3. **Readiness that reflects the ability to complete a control tick** without per-backend probe interfaces: `serve()` also records the last *error-free* tick; `/readyz` degrades (503) when ticks are still running but the iteration's dependency-touching work is failing — specifically a SQLite read/write (via `orchestrator.tick`) or a mailbox `publish` throwing. (Note: this is the *control-loop* signal, not a full backend health board — a transient failure inside an individual dispatch is reconciled into item state, not thrown, so it does not by itself flip readiness. See the readiness-nuance note in the Design.)
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

This reuses the loop's existing error boundary as the dependency-health signal (DRY) — no new probe surface. The signal is therefore "can the control loop reach SQLite + the mailbox and finish a tick", not a per-backend health board (a failure *inside* a dispatch is reconciled, not thrown — it does not degrade readiness); the RUNBOOK must state this so `/readyz` is not misread.

**Concurrency:** the `health` record is written by the loop and read by HTTP handlers, but no lock is needed — Node runs JS single-threaded, and both the loop's field writes and a handler's reads are synchronous with no `await` interleaved between them. To keep that invariant robust against future edits, a handler MUST snapshot the three fields into locals at entry (before any branching) rather than re-reading `health.*` across an `await`.

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

The liveness/readiness **decision** is a pure function, separated from the HTTP plumbing (SRP — mirrors the repo's pure-logic/IO split, e.g. `audit-canon.ts` and `renderPrometheus`), so the load-bearing live-but-not-ready case is testable as a table of inputs without sockets:

```ts
export interface HealthVerdict {
  live: boolean;   // false when !started or lastTickAt stale
  ready: boolean;  // false when !started or lastTickOkAt stale
  reason: 'starting' | 'stale' | 'not-ready' | 'ok';
}
export function evaluateHealth(
  health: ServeHealth,
  now: number,
  t: { livenessTimeoutMs: number; readinessTimeoutMs: number },
): HealthVerdict;
```

The HTTP handlers call `evaluateHealth` and map its verdict to status codes/bodies below; the listener tests then only cover HTTP plumbing (codes, methods, content-type, `/metrics`).

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

- Every handler is wrapped so it **never throws out of the server**; an unexpected internal error returns `500` and is logged `[pangolin serve] http handler error: <msg>` to stderr (reusing the existing `[pangolin serve]` prefix — the HTTP server is part of the serve seam, not a new namespace — matching the repo's one-prefix-per-seam convention alongside `[pangolin metrics]` / `[pangolin telemetry]`).
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

### The series-key format contract (`pangolin-core`) — single-sourced

The recorder builds a series key with the private `seriesKey(name, labels)` helper (`metrics-in-memory.ts`) as `name` or `name{k="v",…}` (labels sorted, **no escaping** — documented assumption: label values are simple identifiers, only `outcome`/`queue`). The renderer must do the *inverse* — recover bare-name + labels to emit one `# TYPE` line per family and to inject `le` into histogram buckets. Two functions encoding/decoding one wire format is a DRY/coupling risk (if escaping is ever added to the builder, a naïve split-on-`{` parser silently corrupts output).

**Resolution:** promote the format to a single-sourced, tested contract. Export `seriesKey(name, labels)` and add its inverse `parseSeriesKey(key): { name: string; labels: Record<string,string> }` **beside it** (same module, or a small shared `metrics-series-key.ts`); `renderPrometheus` consumes `parseSeriesKey`. A round-trip unit test asserts `parseSeriesKey(seriesKey(n, l))` deep-equals `{ name: n, labels: l }`, so the inverse can never drift from the builder. The "no-escaping / simple-identifier label values" invariant is documented on both functions.

### The Prometheus renderer (`pangolin-core/src/metrics-prometheus.ts`)

A pure function, dependency-free, exported from the core index:

```ts
export function renderPrometheus(snapshot: MetricsSnapshot): string;
```

Rules (Prometheus text exposition format, version 0.0.4):

- A `# TYPE <bare-name> <counter|gauge|histogram>` line is emitted **once per metric family**, keyed by the *bare* metric name (obtained via `parseSeriesKey`, not an ad-hoc split). Counters, gauges, and histograms are grouped so each family's TYPE line appears exactly once even across multiple label-series. (Bare names are unique per type in the current metric set; the renderer does not attempt to reconcile a name colliding across two type maps — not a real case, and forcing it would mask a naming bug.)
- **Counters / gauges:** one line per series — `<seriesKey> <value>` (the seriesKey already carries any labels).
- **Histograms:** for each histogram series `{count, sum, buckets}` (where `buckets` maps an `le`-bound string → cumulative count, e.g. `"0.5"`, `"1"`, `"10"` — verbatim from the recorder's `String(bound)`):
  - one `<name>_bucket{<labels>,le="<bound>"} <cumulativeCount>` line per bound, in ascending **numeric** bound order, **plus** a `<name>_bucket{<labels>,le="+Inf"} <count>` line;
  - a `<name>_sum{<labels>} <sum>` line and a `<name>_count{<labels>} <count>` line.
  - Label injection via `parseSeriesKey`: given a series key `name{a="1"}` and an extra `le="0.5"`, the bucket line is `name_bucket{a="1",le="0.5"}`; for an unlabeled series `name`, it is `name_bucket{le="0.5"}`. `_sum`/`_count` carry the series' original labels (no `le`).
- **Non-finite values:** any numeric value (a gauge, a histogram `_sum`, etc.) that is non-finite renders as the Prometheus literals `+Inf` / `-Inf` / `NaN` — **never** JS `String(Infinity)` (`"Infinity"`), which is invalid exposition format and would cause a scraper to reject the entire scrape.
- Deterministic output: families in insertion order of the snapshot maps; histogram bounds in ascending numeric order with `+Inf` last. An empty snapshot renders to an empty string.

Rationale for core placement: the renderer depends only on `MetricsSnapshot` (already core) and produces a string — no new dependency — keeping the snapshot and its canonical text rendering together and unit-testable in core, reusable by a future standalone exporter. Heavier OTel/`prom-client` adapters stay out of core.

### `deploy/serve-stack` wiring (first consumer)

- **`serve-entrypoint.mjs` + `pangolin.config.mjs`** — the deploy config does **not** construct a metrics recorder today (no `metrics:`/telemetry wiring exists in `deploy/serve-stack/pangolin.config.mjs`). This change **adds** a shared `InMemoryMetricsRecorder`, wires it to the orchestrator (`metrics:`) and — to populate dispatch metrics — to the client telemetry (`telemetry: combineTelemetryHooks(new MetricsTelemetryHook(recorder), …)`), then the entrypoint reads `PANGOLIN_HTTP_PORT` (default `9464`) and passes `http: { port, metricsSnapshot: () => recorder.snapshot() }` into `serve()` — the same recorder feeding all three.
- **`Dockerfile`** — add `EXPOSE 9464` and a `HEALTHCHECK` that probes `/healthz` using Node itself (no `curl`/`wget` in `node:20-slim`). **Also update the file's existing header comment** "No EXPOSE — the serve container opens no inbound port" (and the matching `docker-compose.yml` "No `ports:` — serve exposes no inbound port" comment) — these now contradict the change; leaving them is exactly the stale-comment drift the repo's audit history repeatedly flags:
  ```dockerfile
  HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PANGOLIN_HTTP_PORT||9464)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
  ```
  (`start-period` covers startup before the first tick, when `/healthz` returns `503 starting`.)
- **`docker-compose.yml`** — the `serve` service relies on the image `HEALTHCHECK` (or an equivalent compose `healthcheck:` block). The container `HEALTHCHECK` **intentionally probes only `/healthz`**, never `/readyz`: driving container restarts off readiness would reintroduce the dependency-outage restart storm this design exists to avoid. `/readyz` is for a load-balancer/scraper to pull the instance from rotation, not for Docker to restart it. The metrics port is **not published to the host** — within the compose network a Prometheus scraper reaches `serve:9464` by service name. Document the trusted-interface expectation: do not expose `/metrics` to the public internet; for laptop access use the existing SSH tunnel rather than a host port.
- **`RUNBOOK.md`** — document the three routes, the liveness-vs-readiness distinction (a red `/readyz` with green `/healthz` means "deps unreachable, not a wedged loop — do not restart, investigate S3/SQLite"), the port, and the no-auth/trusted-interface posture.

## Error handling

- Handlers never throw out of the server (wrapped → `500` + stderr log). A throwing `metricsSnapshot` provider yields `500` on `/metrics` only; the server stays up.
- `startHealthServer` rejects on bind failure → `serve()` propagates it (fail fast at startup; an unbindable health port is a misconfiguration the operator must see).
- The HTTP server is closed on serve shutdown (signal abort) via `finally`. `close()` must stay prompt under SIGTERM: `http.Server.close()` only resolves once existing (keep-alive) connections drain, so `close()` also calls `server.closeIdleConnections()` (present on `node:20`) — a lingering scraper keep-alive must not stall shutdown.
- Liveness keys off `lastTickAt`, readiness off `lastTickOkAt` — never swapped — to avoid dependency-outage restart storms.

## Testing plan

- **`parseSeriesKey` round-trip (core):** `parseSeriesKey(seriesKey(n, l))` deep-equals `{ name: n, labels: l }` across no-label and multi-label cases — locks the inverse to the builder so the format can't drift.
- **`evaluateHealth` (core/orchestrator, pure):** table of inputs — `!started` → `{live:false, ready:false, reason:'starting'}`; fresh both → `ok`; `lastTickAt` stale → `live:false reason:'stale'`; **`lastTickAt` fresh but `lastTickOkAt` stale → `{live:true, ready:false, reason:'not-ready'}`** (the load-bearing live-but-not-ready case, tested without a socket).
- **`renderPrometheus` (core):** counters and gauges (with and without labels); a histogram renders `_bucket` lines (cumulative, ascending, `+Inf` = count) + `_sum` + `_count`; `# TYPE` appears exactly once per family even with multiple label-series; label injection puts `le` last; **non-finite values render as `+Inf`/`-Inf`/`NaN`, never `"Infinity"`**; an empty snapshot → empty string; output is deterministic.
- **`startHealthServer` (orchestrator):** HTTP plumbing over a real listener on port `0` (ephemeral) + global `fetch` — `/healthz` maps `evaluateHealth` verdicts to `200`/`503 stale`/`503 starting`; `/readyz` maps to `200`/`503 not-ready`/`503 starting`; `/metrics` renders a provided snapshot, `404` with no provider, `500` when the provider throws; unknown path → `404`; non-GET → `405`. (The verdict *logic* is covered by the `evaluateHealth` table above; these tests assert the HTTP mapping only.)
- **`serve()` integration:** with the `http` option, a fake transport, and an injected clock, assert `started` flips after the first tick and `lastTickAt`/`lastTickOkAt` advance per iteration; an iteration whose `tick` throws advances `lastTickAt` but **not** `lastTickOkAt` (readiness degrades while liveness holds — the core semantic); the server closes when the signal aborts.

## Risks / edge cases

- **Restart storms** — avoided by the liveness/readiness timestamp split (documented, tested).
- **Flapping** — staleness windows default to several `tickIntervalMs` and are configurable; the `HEALTHCHECK` uses `--start-period` + `--retries`.
- **Slow ticks** — a single tick slower than `tickIntervalMs` must not trip liveness; the default window is ≥4 intervals (and ≥60s).
- **Port exposure** — unauthenticated v1; documented trusted-interface expectation; the serve-stack does not publish the port to the host.
- **`HEALTHCHECK` requires global `fetch`** — present on `node:20` (Node 18+); the image is already `node:20-slim`.
- **`metricsSnapshot` cost** — `InMemoryMetricsRecorder.snapshot()` deep-copies; at scrape frequency (seconds) this is negligible, but the provider is called per `/metrics` request, so a pathological scrape rate is the operator's concern (standard Prometheus practice).
