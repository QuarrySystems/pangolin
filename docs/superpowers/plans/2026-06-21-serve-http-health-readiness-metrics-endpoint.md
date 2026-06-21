# Serve HTTP health/readiness/metrics endpoint — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in HTTP server to the orchestrator `serve()` loop exposing `/healthz` (heartbeat liveness), `/readyz` (last-error-free-tick readiness), and `/metrics` (Prometheus text), and wire it into `deploy/serve-stack` so the existing serve container becomes self-monitoring.

**Architecture:** A pure Prometheus-text renderer + a single-sourced series-key format live in `pangolin-core`. A new `serve/http.ts` in `pangolin-orchestrator` holds a pure `evaluateHealth` predicate and a Node-built-in-`http` server (`startHealthServer`). `serve()` threads a `ServeHealth` heartbeat through its loop and starts/stops the server when an opt-in `http` option is set. `deploy/serve-stack` is the first consumer (shared metrics recorder + Dockerfile `HEALTHCHECK`).

**Tech Stack:** TypeScript (NodeNext ESM), Node built-in `http`, vitest. pnpm workspace monorepo. Zero new runtime dependencies.

## Global Constraints

- **Zero new runtime dependencies.** `pangolin-core` stays dependency-free; the HTTP server uses only Node's built-in `http`. No `prom-client`/OTel/Express.
- **Opt-in / off by default.** No `http` key on `ServeOptions` → no server, no open port (unchanged behaviour for embedded library users).
- **Liveness keys off `lastTickAt`; readiness off `lastTickOkAt` — never swapped.** Driving restarts off readiness would cause dependency-outage restart storms.
- **Bounded-cardinality labels only** (`outcome`, `queue`) — never `dispatchId`/`runId`. (Inherited from the metrics layer; this plan only renders existing metrics.)
- **No auth in v1.** Endpoints bind to a trusted/internal interface; documented in the RUNBOOK. The metrics payload carries no secrets/audit material.
- **Operator logging prefix is `[pangolin serve]`** (reuse the existing serve prefix; do NOT introduce `[pangolin serve-http]`).
- **Prometheus text exposition format, version 0.0.4.** `# TYPE` once per metric family; histogram buckets cumulative + `+Inf`; `_sum`/`_count`; non-finite numbers render as `+Inf`/`-Inf`/`NaN` (never JS `"Infinity"`).
- **TDD throughout**, frequent commits. Tests run via `pnpm --filter <pkg> exec vitest run <file>`. The Stop-hook ESLint is stricter than `pnpm -r lint` on test files — avoid `as any` / unused bindings.
- **Build dependency order:** after touching `pangolin-core`, run `pnpm --filter @quarry-systems/pangolin-core build` so `pangolin-orchestrator` and the deploy config (which import built `dist`) resolve the new exports.

---

### Task 1: Single-sourced series-key format (`parseSeriesKey`)

The Prometheus renderer (Task 2) must decode the series keys the metrics recorder builds. Today `seriesKey` is a **private** function in `metrics-in-memory.ts`. Extract it to a shared module with its inverse, locked together by a round-trip test, so the format cannot drift.

**Files:**
- Create: `packages/pangolin-core/src/metrics-series-key.ts`
- Create: `packages/pangolin-core/test/metrics-series-key.test.ts`
- Modify: `packages/pangolin-core/src/metrics-in-memory.ts` (delete the private `seriesKey`, import the shared one)
- Modify: `packages/pangolin-core/src/index.ts:14` (add the new export after `metrics-in-memory.js`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `export function seriesKey(name: string, labels?: Record<string,string>): string` and `export function parseSeriesKey(key: string): { name: string; labels: Record<string,string> }`.

- [ ] **Step 1: Write the failing test** — `packages/pangolin-core/test/metrics-series-key.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { seriesKey, parseSeriesKey } from '../src/metrics-series-key.js';

describe('series-key format', () => {
  it('builds `name` alone and `name{k="v",…}` with labels sorted', () => {
    expect(seriesKey('pangolin_x_total')).toBe('pangolin_x_total');
    expect(seriesKey('pangolin_y_total', { queue: 'default', outcome: 'finished' })).toBe(
      'pangolin_y_total{outcome="finished",queue="default"}',
    );
  });

  it('parseSeriesKey is the exact inverse of seriesKey (round-trip)', () => {
    expect(parseSeriesKey(seriesKey('pangolin_x_total'))).toEqual({
      name: 'pangolin_x_total',
      labels: {},
    });
    const labels = { outcome: 'finished', queue: 'default' };
    expect(parseSeriesKey(seriesKey('pangolin_y_total', labels))).toEqual({
      name: 'pangolin_y_total',
      labels,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @quarry-systems/pangolin-core exec vitest run test/metrics-series-key.test.ts`
Expected: FAIL — `metrics-series-key.js` does not exist (import error).

- [ ] **Step 3: Create the shared module** — `packages/pangolin-core/src/metrics-series-key.ts`

```typescript
// The Prometheus-style series-key format, single-sourced. The recorder BUILDS keys with
// seriesKey(); the Prometheus renderer DECODES them with parseSeriesKey(). Keeping the builder
// and its inverse together (with a round-trip test) prevents the two from drifting.
//
// Label VALUES are assumed simple identifiers — the metric set uses only bounded outcome/queue —
// so NO escaping is performed; callers must not pass values containing `"`, `,`, or `}`.

/** `name` alone, or `name{k="v",…}` with labels sorted by key. */
export function seriesKey(name: string, labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k]}"`);
  return `${name}{${parts.join(',')}}`;
}

/** Inverse of seriesKey: recover the bare metric name and its labels from a series key. */
export function parseSeriesKey(key: string): { name: string; labels: Record<string, string> } {
  const brace = key.indexOf('{');
  if (brace === -1) return { name: key, labels: {} };
  const name = key.slice(0, brace);
  const inner = key.slice(brace + 1, key.lastIndexOf('}'));
  const labels: Record<string, string> = {};
  if (inner.length > 0) {
    for (const part of inner.split(',')) {
      const eq = part.indexOf('=');
      const k = part.slice(0, eq);
      // value is wrapped in quotes: strip the leading `="` and the trailing `"`.
      const v = part.slice(eq + 2, part.length - 1);
      labels[k] = v;
    }
  }
  return { name, labels };
}
```

- [ ] **Step 4: Rewire `metrics-in-memory.ts` to use the shared `seriesKey`**

In `packages/pangolin-core/src/metrics-in-memory.ts`, DELETE the private `seriesKey` function (the block currently at lines 5-14, including its doc comment) and add an import at the top, immediately under the existing `import type { … } from './metrics.js';` line:

```typescript
import { seriesKey } from './metrics-series-key.js';
```

Leave every `seriesKey(...)` call site in the file unchanged — they now resolve to the imported function.

- [ ] **Step 5: Export from the core barrel** — `packages/pangolin-core/src/index.ts`

Add after line 14 (`export * from './metrics-in-memory.js';`):

```typescript
export * from './metrics-series-key.js';
```

- [ ] **Step 6: Run the test + the existing metrics suite to verify green**

Run: `pnpm --filter @quarry-systems/pangolin-core exec vitest run test/metrics-series-key.test.ts test/metrics-in-memory.test.ts`
Expected: PASS (the new round-trip tests plus the unchanged in-memory recorder tests — the refactor is behaviour-preserving).

- [ ] **Step 7: Build core**

Run: `pnpm --filter @quarry-systems/pangolin-core build`
Expected: exits 0 (downstream packages will import the new export from `dist`).

- [ ] **Step 8: Commit**

```bash
git add packages/pangolin-core/src/metrics-series-key.ts packages/pangolin-core/test/metrics-series-key.test.ts packages/pangolin-core/src/metrics-in-memory.ts packages/pangolin-core/src/index.ts
git commit -m "feat(metrics): single-source the series-key format (seriesKey + parseSeriesKey)"
```

---

### Task 2: Prometheus-text renderer (`renderPrometheus`)

A pure, dependency-free function that renders a `MetricsSnapshot` to Prometheus text exposition format (version 0.0.4).

**Files:**
- Create: `packages/pangolin-core/src/metrics-prometheus.ts`
- Create: `packages/pangolin-core/test/metrics-prometheus.test.ts`
- Modify: `packages/pangolin-core/src/index.ts` (add the export after `metrics-series-key.js`)

**Interfaces:**
- Consumes: `MetricsSnapshot` (from `./metrics.js`), `parseSeriesKey` (Task 1, from `./metrics-series-key.js`).
- Produces: `export function renderPrometheus(snapshot: MetricsSnapshot): string`.

- [ ] **Step 1: Write the failing test** — `packages/pangolin-core/test/metrics-prometheus.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { renderPrometheus } from '../src/metrics-prometheus.js';
import type { MetricsSnapshot } from '../src/metrics.js';

describe('renderPrometheus', () => {
  it('renders an empty snapshot as the empty string', () => {
    expect(renderPrometheus({ counters: {}, gauges: {}, histograms: {} })).toBe('');
  });

  it('renders counters and gauges, TYPE once per family across label-series', () => {
    const snap: MetricsSnapshot = {
      counters: {
        'pangolin_dispatch_completed_total{outcome="finished"}': 3,
        'pangolin_dispatch_completed_total{outcome="failed"}': 1,
      },
      gauges: { 'pangolin_queue_depth{queue="default"}': 5 },
      histograms: {},
    };
    const out = renderPrometheus(snap);
    // exactly one TYPE line for the counter family:
    expect(out.match(/# TYPE pangolin_dispatch_completed_total counter/g)).toHaveLength(1);
    expect(out).toContain('pangolin_dispatch_completed_total{outcome="finished"} 3');
    expect(out).toContain('pangolin_dispatch_completed_total{outcome="failed"} 1');
    expect(out).toContain('# TYPE pangolin_queue_depth gauge');
    expect(out).toContain('pangolin_queue_depth{queue="default"} 5');
  });

  it('renders a histogram: cumulative buckets + +Inf, _sum, _count', () => {
    const snap: MetricsSnapshot = {
      counters: {},
      gauges: {},
      histograms: {
        pangolin_dispatch_duration_seconds: {
          count: 2,
          sum: 7,
          buckets: { '1': 1, '10': 2, '+Inf': 2 },
        },
      },
    };
    const out = renderPrometheus(snap).split('\n');
    expect(out).toContain('# TYPE pangolin_dispatch_duration_seconds histogram');
    expect(out).toContain('pangolin_dispatch_duration_seconds_bucket{le="1"} 1');
    expect(out).toContain('pangolin_dispatch_duration_seconds_bucket{le="10"} 2');
    expect(out).toContain('pangolin_dispatch_duration_seconds_bucket{le="+Inf"} 2');
    expect(out).toContain('pangolin_dispatch_duration_seconds_sum 7');
    expect(out).toContain('pangolin_dispatch_duration_seconds_count 2');
  });

  it('injects le into a labelled histogram series and keeps it last', () => {
    const snap: MetricsSnapshot = {
      counters: {},
      gauges: {},
      histograms: {
        'h_seconds{queue="default"}': { count: 1, sum: 2, buckets: { '5': 1, '+Inf': 1 } },
      },
    };
    const out = renderPrometheus(snap);
    expect(out).toContain('h_seconds_bucket{queue="default",le="5"} 1');
    expect(out).toContain('h_seconds_sum{queue="default"} 2');
  });

  it('renders non-finite numbers as Prometheus literals, never "Infinity"', () => {
    const snap: MetricsSnapshot = {
      counters: {},
      gauges: { g: Infinity, n: NaN, neg: -Infinity },
      histograms: {},
    };
    const out = renderPrometheus(snap);
    expect(out).toContain('g +Inf');
    expect(out).toContain('n NaN');
    expect(out).toContain('neg -Inf');
    expect(out).not.toContain('Infinity');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @quarry-systems/pangolin-core exec vitest run test/metrics-prometheus.test.ts`
Expected: FAIL — `metrics-prometheus.js` does not exist.

- [ ] **Step 3: Implement the renderer** — `packages/pangolin-core/src/metrics-prometheus.ts`

```typescript
// Pure Prometheus text-exposition renderer (version 0.0.4) for a MetricsSnapshot. Dependency-free;
// the only core companion to the snapshot. Heavier OTel/prom-client adapters stay out of core.

import type { MetricsSnapshot } from './metrics.js';
import { parseSeriesKey } from './metrics-series-key.js';

/** Render a number as Prometheus requires: +Inf / -Inf / NaN literals for non-finite values.
 *  JS `String(Infinity)` === 'Infinity' is INVALID exposition format and poisons the whole scrape. */
function fmt(n: number): string {
  if (Number.isFinite(n)) return String(n);
  if (Number.isNaN(n)) return 'NaN';
  return n > 0 ? '+Inf' : '-Inf';
}

/** `{k="v",…}` (sorted) for a label record, or '' when empty. */
function fmtLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return `{${keys.map((k) => `${k}="${labels[k]}"`).join(',')}}`;
}

/** `{k="v",…,extraKey="extraVal"}` — existing labels (sorted) plus one trailing label (e.g. le). */
function fmtLabelsWith(labels: Record<string, string>, extraKey: string, extraVal: string): string {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k]}"`);
  parts.push(`${extraKey}="${extraVal}"`);
  return `{${parts.join(',')}}`;
}

/** Group a snapshot map's entries by bare metric name, preserving first-seen order. */
function groupByName<T>(
  record: Record<string, T>,
): Array<{ name: string; series: Array<{ key: string; labels: Record<string, string>; value: T }> }> {
  const order: string[] = [];
  const groups = new Map<string, Array<{ key: string; labels: Record<string, string>; value: T }>>();
  for (const [key, value] of Object.entries(record)) {
    const { name, labels } = parseSeriesKey(key);
    let bucket = groups.get(name);
    if (!bucket) {
      bucket = [];
      groups.set(name, bucket);
      order.push(name);
    }
    bucket.push({ key, labels, value });
  }
  return order.map((name) => ({ name, series: groups.get(name)! }));
}

export function renderPrometheus(snapshot: MetricsSnapshot): string {
  const lines: string[] = [];

  for (const type of [
    { kind: 'counter' as const, record: snapshot.counters },
    { kind: 'gauge' as const, record: snapshot.gauges },
  ]) {
    for (const { name, series } of groupByName(type.record)) {
      lines.push(`# TYPE ${name} ${type.kind}`);
      for (const s of series) lines.push(`${s.key} ${fmt(s.value)}`);
    }
  }

  for (const { name, series } of groupByName(snapshot.histograms)) {
    lines.push(`# TYPE ${name} histogram`);
    for (const { labels, value: h } of series) {
      const bounds = Object.keys(h.buckets)
        .filter((b) => b !== '+Inf')
        .sort((a, b) => Number(a) - Number(b));
      for (const b of bounds) {
        lines.push(`${name}_bucket${fmtLabelsWith(labels, 'le', b)} ${fmt(h.buckets[b]!)}`);
      }
      lines.push(`${name}_bucket${fmtLabelsWith(labels, 'le', '+Inf')} ${fmt(h.buckets['+Inf'] ?? h.count)}`);
      lines.push(`${name}_sum${fmtLabels(labels)} ${fmt(h.sum)}`);
      lines.push(`${name}_count${fmtLabels(labels)} ${fmt(h.count)}`);
    }
  }

  return lines.length === 0 ? '' : lines.join('\n') + '\n';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @quarry-systems/pangolin-core exec vitest run test/metrics-prometheus.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Export from the core barrel** — `packages/pangolin-core/src/index.ts`

Add after the `metrics-series-key.js` export line:

```typescript
export * from './metrics-prometheus.js';
```

- [ ] **Step 6: Build core**

Run: `pnpm --filter @quarry-systems/pangolin-core build`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/pangolin-core/src/metrics-prometheus.ts packages/pangolin-core/test/metrics-prometheus.test.ts packages/pangolin-core/src/index.ts
git commit -m "feat(metrics): pure Prometheus-text renderer for MetricsSnapshot"
```

---

### Task 3: Health types + pure `evaluateHealth` predicate

The liveness/readiness decision is a pure function of the heartbeat record, separated from HTTP plumbing (SRP + table-testable without sockets). This task creates `serve/http.ts` with the types and the predicate only; Task 4 adds the server to the same file.

**Files:**
- Create: `packages/pangolin-orchestrator/src/serve/http.ts`
- Create: `packages/pangolin-orchestrator/test/serve-health-eval.test.ts`
- Modify: `packages/pangolin-orchestrator/src/index.ts:18-19` (export the new types + function alongside `serve`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `interface ServeHealth { started: boolean; lastTickAt: number; lastTickOkAt: number }`; `interface HealthVerdict { live: boolean; ready: boolean; reason: 'starting'|'stale'|'not-ready'|'ok' }`; `function evaluateHealth(health: ServeHealth, now: number, t: { livenessTimeoutMs: number; readinessTimeoutMs: number }): HealthVerdict`.

- [ ] **Step 1: Write the failing test** — `packages/pangolin-orchestrator/test/serve-health-eval.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { evaluateHealth, type ServeHealth } from '../src/serve/http.js';

const T = { livenessTimeoutMs: 100, readinessTimeoutMs: 100 };

describe('evaluateHealth', () => {
  it('reports starting before the first tick', () => {
    const h: ServeHealth = { started: false, lastTickAt: 0, lastTickOkAt: 0 };
    expect(evaluateHealth(h, 1_000, T)).toEqual({ live: false, ready: false, reason: 'starting' });
  });

  it('reports ok when both timestamps are fresh', () => {
    const h: ServeHealth = { started: true, lastTickAt: 1_000, lastTickOkAt: 1_000 };
    expect(evaluateHealth(h, 1_050, T)).toEqual({ live: true, ready: true, reason: 'ok' });
  });

  it('reports stale (not live) when lastTickAt is too old', () => {
    const h: ServeHealth = { started: true, lastTickAt: 1_000, lastTickOkAt: 1_000 };
    expect(evaluateHealth(h, 1_500, T)).toEqual({ live: false, ready: false, reason: 'stale' });
  });

  it('LIVE BUT NOT READY when ticks progress yet the last one errored (deps down)', () => {
    // lastTickAt fresh (loop still iterating), lastTickOkAt stale (every tick throwing).
    const h: ServeHealth = { started: true, lastTickAt: 1_500, lastTickOkAt: 1_000 };
    expect(evaluateHealth(h, 1_550, T)).toEqual({ live: true, ready: false, reason: 'not-ready' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @quarry-systems/pangolin-orchestrator exec vitest run test/serve-health-eval.test.ts`
Expected: FAIL — `serve/http.js` does not exist.

- [ ] **Step 3: Create `serve/http.ts` with the types + predicate**

```typescript
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @quarry-systems/pangolin-orchestrator exec vitest run test/serve-health-eval.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Export from the orchestrator barrel** — `packages/pangolin-orchestrator/src/index.ts`

After line 19 (`export type { ServeOptions } from './serve/driver.js';`), add:

```typescript
export { evaluateHealth } from './serve/http.js';
export type { ServeHealth, HealthVerdict } from './serve/http.js';
```

- [ ] **Step 6: Commit**

```bash
git add packages/pangolin-orchestrator/src/serve/http.ts packages/pangolin-orchestrator/test/serve-health-eval.test.ts packages/pangolin-orchestrator/src/index.ts
git commit -m "feat(serve): ServeHealth + pure evaluateHealth liveness/readiness predicate"
```

---

### Task 4: `startHealthServer` (the HTTP listener)

Add the Node-`http` server to `serve/http.ts`. It maps `evaluateHealth` verdicts to HTTP responses and renders `/metrics` via the core renderer.

**Files:**
- Modify: `packages/pangolin-orchestrator/src/serve/http.ts` (append the server below the predicate)
- Create: `packages/pangolin-orchestrator/test/serve-http-server.test.ts`
- Modify: `packages/pangolin-orchestrator/src/index.ts` (export `startHealthServer` + its option/handle types)

**Interfaces:**
- Consumes: `ServeHealth`, `evaluateHealth` (Task 3); `MetricsSnapshot`, `renderPrometheus` (Task 2, from `@quarry-systems/pangolin-core`).
- Produces: `interface HealthServerOptions { port: number; host?: string; health: ServeHealth; livenessTimeoutMs: number; readinessTimeoutMs: number; now: () => number; metricsSnapshot?: () => MetricsSnapshot }`; `interface HealthServerHandle { close(): Promise<void>; readonly port: number }`; `function startHealthServer(opts: HealthServerOptions): Promise<HealthServerHandle>`.

- [ ] **Step 1: Write the failing test** — `packages/pangolin-orchestrator/test/serve-http-server.test.ts`

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import {
  startHealthServer,
  type HealthServerHandle,
  type ServeHealth,
} from '../src/serve/http.js';
import type { MetricsSnapshot } from '@quarry-systems/pangolin-core';

let handle: HealthServerHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

const TIMEOUTS = { livenessTimeoutMs: 100, readinessTimeoutMs: 100 };

async function start(
  health: ServeHealth,
  now: number,
  metricsSnapshot?: () => MetricsSnapshot,
): Promise<HealthServerHandle> {
  handle = await startHealthServer({
    port: 0,
    health,
    now: () => now,
    metricsSnapshot,
    ...TIMEOUTS,
  });
  return handle;
}

const fresh = (): ServeHealth => ({ started: true, lastTickAt: 1_000, lastTickOkAt: 1_000 });

describe('startHealthServer', () => {
  it('/healthz 200 when live, 503 when stale, 503 starting before first tick', async () => {
    const h = await start(fresh(), 1_050);
    expect((await fetch(`http://127.0.0.1:${h.port}/healthz`)).status).toBe(200);
    await h.close();
    const h2 = await start({ started: false, lastTickAt: 0, lastTickOkAt: 0 }, 5_000);
    expect((await fetch(`http://127.0.0.1:${h2.port}/healthz`)).status).toBe(503);
    await h2.close();
    const h3 = await start(fresh(), 9_999);
    expect((await fetch(`http://127.0.0.1:${h3.port}/healthz`)).status).toBe(503);
  });

  it('/readyz tracks lastTickOkAt INDEPENDENTLY of lastTickAt (live but not ready)', async () => {
    // lastTickAt fresh (loop alive), lastTickOkAt stale (deps down): healthz 200, readyz 503.
    const h = await start({ started: true, lastTickAt: 1_500, lastTickOkAt: 1_000 }, 1_550);
    expect((await fetch(`http://127.0.0.1:${h.port}/healthz`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${h.port}/readyz`)).status).toBe(503);
  });

  it('/metrics renders a provided snapshot; 404 with no provider; 500 when it throws', async () => {
    const snap: MetricsSnapshot = { counters: { c: 2 }, gauges: {}, histograms: {} };
    const h = await start(fresh(), 1_050, () => snap);
    const ok = await fetch(`http://127.0.0.1:${h.port}/metrics`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('text/plain; version=0.0.4');
    expect(await ok.text()).toContain('c 2');
    await h.close();

    const h2 = await start(fresh(), 1_050); // no provider
    expect((await fetch(`http://127.0.0.1:${h2.port}/metrics`)).status).toBe(404);
    await h2.close();

    const h3 = await start(fresh(), 1_050, () => {
      throw new Error('snapshot boom');
    });
    expect((await fetch(`http://127.0.0.1:${h3.port}/metrics`)).status).toBe(500);
  });

  it('404 for unknown paths and 405 for non-GET', async () => {
    const h = await start(fresh(), 1_050);
    expect((await fetch(`http://127.0.0.1:${h.port}/nope`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${h.port}/healthz`, { method: 'POST' })).status).toBe(405);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @quarry-systems/pangolin-orchestrator exec vitest run test/serve-http-server.test.ts`
Expected: FAIL — `startHealthServer` is not exported.

- [ ] **Step 3: Append the server to `serve/http.ts`**

Add to the TOP of `packages/pangolin-orchestrator/src/serve/http.ts` (imports):

```typescript
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { renderPrometheus, type MetricsSnapshot } from '@quarry-systems/pangolin-core';
```

Append BELOW `evaluateHealth`:

```typescript
export interface HealthServerOptions {
  port: number;
  host?: string;
  /** Shared by reference with serve(); read on each request. */
  health: ServeHealth;
  livenessTimeoutMs: number;
  readinessTimeoutMs: number;
  now: () => number;
  /** When omitted, /metrics returns 404 (metrics not enabled for this serve). */
  metricsSnapshot?: () => MetricsSnapshot;
}

export interface HealthServerHandle {
  /** Resolves once the listener is closed (idle connections are dropped first). */
  close(): Promise<void>;
  /** The bound port (resolves an ephemeral port when 0 was requested). */
  readonly port: number;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function handle(req: IncomingMessage, res: ServerResponse, opts: HealthServerOptions): void {
  if (req.method !== 'GET') {
    json(res, 405, { status: 'method-not-allowed' });
    return;
  }
  const path = (req.url ?? '').split('?')[0];
  // Snapshot the heartbeat fields into a local at entry — keeps the read race-free even if a
  // future edit introduces an `await` between field reads (Node is single-threaded today).
  const h: ServeHealth = { ...opts.health };
  const now = opts.now();

  if (path === '/healthz') {
    const v = evaluateHealth(h, now, opts);
    json(res, v.live ? 200 : 503, { status: v.live ? 'ok' : v.reason, lastTickAt: h.lastTickAt });
    return;
  }
  if (path === '/readyz') {
    const v = evaluateHealth(h, now, opts);
    json(res, v.ready ? 200 : 503, {
      status: v.ready ? 'ready' : v.reason,
      lastTickOkAt: h.lastTickOkAt,
    });
    return;
  }
  if (path === '/metrics') {
    if (!opts.metricsSnapshot) {
      json(res, 404, { status: 'metrics-disabled' });
      return;
    }
    let text: string;
    try {
      text = renderPrometheus(opts.metricsSnapshot());
    } catch (err) {
      console.error(
        `[pangolin serve] http metrics error: ${err instanceof Error ? err.message : String(err)}`,
      );
      json(res, 500, { status: 'error' });
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.end(text);
    return;
  }
  json(res, 404, { status: 'not-found' });
}

export function startHealthServer(opts: HealthServerOptions): Promise<HealthServerHandle> {
  const server = createServer((req, res) => {
    try {
      handle(req, res, opts);
    } catch (err) {
      console.error(
        `[pangolin serve] http handler error: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('{"status":"error"}');
      }
    }
  });

  return new Promise<HealthServerHandle>((resolve, reject) => {
    server.once('error', reject); // bind failure (e.g. EADDRINUSE) → reject (fail fast)
    server.listen(opts.port, opts.host ?? '0.0.0.0', () => {
      server.removeListener('error', reject);
      const addr = server.address();
      const boundPort = typeof addr === 'object' && addr !== null ? addr.port : opts.port;
      resolve({
        port: boundPort,
        close: () =>
          new Promise<void>((res) => {
            // Drop idle keep-alive connections so a lingering scraper can't stall shutdown.
            server.closeIdleConnections();
            server.close(() => res());
          }),
      });
    });
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @quarry-systems/pangolin-orchestrator exec vitest run test/serve-http-server.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Export from the orchestrator barrel** — `packages/pangolin-orchestrator/src/index.ts`

Add beside the Task 3 exports:

```typescript
export { startHealthServer } from './serve/http.js';
export type { HealthServerOptions, HealthServerHandle } from './serve/http.js';
```

- [ ] **Step 6: Commit**

```bash
git add packages/pangolin-orchestrator/src/serve/http.ts packages/pangolin-orchestrator/test/serve-http-server.test.ts packages/pangolin-orchestrator/src/index.ts
git commit -m "feat(serve): startHealthServer — /healthz /readyz /metrics over node:http"
```

---

### Task 5: Thread the heartbeat + HTTP server into `serve()`

Add the opt-in `http` option to `ServeOptions`, record the heartbeat each iteration, and start/stop the server around the loop.

**Files:**
- Modify: `packages/pangolin-orchestrator/src/serve/driver.ts`
- Create: `packages/pangolin-orchestrator/test/serve-driver-http.test.ts`

**Interfaces:**
- Consumes: `startHealthServer`, `ServeHealth`, `HealthServerHandle` (Task 4, from `./http.js`); `MetricsSnapshot` (core).
- Produces: `ServeOptions.http?: { port: number; host?: string; livenessTimeoutMs?: number; readinessTimeoutMs?: number; metricsSnapshot?: () => MetricsSnapshot }`.

- [ ] **Step 1: Write the failing test** — `packages/pangolin-orchestrator/test/serve-driver-http.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { serve } from '../src/serve/driver.js';

/** Find a free TCP port by binding :0, reading it, and releasing it. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

/** Poll `fn` until it returns true or the timeout elapses. */
async function waitFor(fn: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function fakeOrch(opts: { tickThrowsAfter?: number } = {}) {
  let ticks = 0;
  return {
    recoverStranded() {},
    async tick() {
      ticks += 1;
      if (opts.tickThrowsAfter !== undefined && ticks > opts.tickThrowsAfter) {
        throw new Error('dep down');
      }
    },
    getStatus() {
      return [];
    },
    getAuditExport() {
      return { root: undefined };
    },
    cancelRun() {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const noTransport = {
  async pollInbox() {
    return [];
  },
  async ack() {},
  async deadLetter() {},
  async publish() {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

describe('serve() HTTP integration', () => {
  it('serves /healthz and /readyz 200 once the loop is ticking', async () => {
    const port = await freePort();
    const ac = new AbortController();
    const p = serve({
      orchestrator: fakeOrch(),
      transport: noTransport,
      signal: ac.signal,
      tickIntervalMs: 10,
      onError: () => {},
      http: { port },
    });
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/healthz`)).status === 200);
    expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
    ac.abort();
    await p;
  });

  it('degrades /readyz to 503 while /healthz stays 200 when ticks start failing', async () => {
    const port = await freePort();
    const ac = new AbortController();
    const p = serve({
      orchestrator: fakeOrch({ tickThrowsAfter: 1 }), // reconcile-first tick ok; loop ticks throw
      transport: noTransport,
      signal: ac.signal,
      tickIntervalMs: 10,
      onError: () => {},
      http: { port, livenessTimeoutMs: 5_000, readinessTimeoutMs: 50 },
    });
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/readyz`)).status === 503);
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200); // live, not ready
    ac.abort();
    await p;
  });

  it('opens no port when http is unset', async () => {
    const port = await freePort();
    const ac = new AbortController();
    const p = serve({
      orchestrator: fakeOrch(),
      transport: noTransport,
      signal: ac.signal,
      tickIntervalMs: 10,
      onError: () => {},
    });
    await new Promise((r) => setTimeout(r, 50));
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
    ac.abort();
    await p;
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @quarry-systems/pangolin-orchestrator exec vitest run test/serve-driver-http.test.ts`
Expected: FAIL — `ServeOptions` has no `http` field / no server is started (the first two tests' fetches never reach 200).

- [ ] **Step 3: Add the `http` option to `ServeOptions`** — `packages/pangolin-orchestrator/src/serve/driver.ts`

Add imports at the top of the file (below the existing `import type` lines):

```typescript
import { startHealthServer, type ServeHealth, type HealthServerHandle } from './http.js';
import type { MetricsSnapshot } from '@quarry-systems/pangolin-core';
```

Add to the `ServeOptions` interface (after the `scheduler?` field):

```typescript
  /** Opt-in HTTP observability endpoint. When unset, no server is started and no port opens. */
  http?: {
    port: number;
    host?: string;
    /** Liveness staleness window; default max(tickIntervalMs * 4, 60_000). */
    livenessTimeoutMs?: number;
    /** Readiness staleness window; default max(tickIntervalMs * 4, 60_000). */
    readinessTimeoutMs?: number;
    /** Provider for /metrics; when omitted /metrics returns 404. */
    metricsSnapshot?: () => MetricsSnapshot;
  };
```

- [ ] **Step 4: Thread the heartbeat + server through `serve()`** — replace the body of `serve()` in `driver.ts`

Replace the whole function body (the current lines 38-110, from `const queue = …` through the closing `}`) with:

```typescript
  const queue = opts.queue ?? 'default';
  const interval = opts.tickIntervalMs ?? 2000;
  const onError = opts.onError ?? defaultServeOnError;
  const now = () => opts.now?.() ?? Date.now();

  // Liveness/readiness heartbeat, shared by reference with the HTTP server (if enabled).
  const health: ServeHealth = { started: false, lastTickAt: 0, lastTickOkAt: 0 };

  let healthServer: HealthServerHandle | undefined;
  if (opts.http) {
    const window = Math.max(interval * 4, 60_000);
    healthServer = await startHealthServer({
      port: opts.http.port,
      host: opts.http.host,
      health,
      livenessTimeoutMs: opts.http.livenessTimeoutMs ?? window,
      readinessTimeoutMs: opts.http.readinessTimeoutMs ?? window,
      now,
      metricsSnapshot: opts.http.metricsSnapshot,
    });
  }

  try {
    // Crash recovery: re-ready items left `running` by a crashed process
    opts.orchestrator.recoverStranded(now());

    // Reconcile-first: one tick before the main loop
    await opts.orchestrator.tick(queue);
    health.started = true;
    health.lastTickAt = now();
    health.lastTickOkAt = now();

    // Tracks runs whose audit export has already been published — persists across
    // iterations so each run's audit export is emitted exactly once (idempotent).
    const publishedAudit = new Set<string>();

    while (!opts.signal?.aborted) {
      try {
        for (const env of await opts.transport.pollInbox()) {
          try {
            await opts.orchestrator.submitRun(env.run, env.actor, env.submittedAt);
            await opts.transport.ack(env.run.id); // consume it
          } catch (err) {
            onError(err);
            await opts.transport.deadLetter(env.run.id); // poison -> dead-letter, NOT infinite re-poll
          }
        }
        for (const ctl of (await opts.transport.pollControl?.()) ?? []) {
          try {
            if (ctl.kind === 'cancel') opts.orchestrator.cancelRun(ctl.target, ctl.actor);
            await opts.transport.ackControl?.(ctl.target);
          } catch (err) {
            onError(err);
          }
        }
        if (opts.scheduler) {
          try {
            for (const env of opts.scheduler.dueSubmissions()) {
              try {
                await opts.transport.submit(env);
              } catch (err) {
                onError(err);
              }
            }
          } catch (err) {
            onError(err);
          }
        }
        await opts.orchestrator.tick(queue);

        const at = new Date(now()).toISOString();

        // Group status items by runId — one OutboxRecord per run
        const byRun = new Map<string, unknown[]>();
        for (const s of opts.orchestrator.getStatus()) {
          let arr = byRun.get(s.runId);
          if (!arr) {
            arr = [];
            byRun.set(s.runId, arr);
          }
          arr.push(s);
        }

        for (const [runId, items] of byRun) {
          await opts.transport.publish({ runId, kind: 'status', body: items, at });
        }

        // Publish sealed audit exports — once per run, after the epoch seals (root defined).
        for (const runId of byRun.keys()) {
          if (publishedAudit.has(runId)) continue;
          const exp = opts.orchestrator.getAuditExport(runId);
          if (exp.root === undefined) continue; // not sealed yet
          await opts.transport.publish({ runId, kind: 'audit', body: exp, at });
          publishedAudit.add(runId);
        }

        // Reached the end of the iteration with no outer-catch error → deps are reachable.
        health.lastTickOkAt = now();
      } catch (err) {
        onError(err);
      }

      // Every completed iteration (success OR caught error) advances the liveness heartbeat.
      health.lastTickAt = now();

      await sleep(interval, opts.signal);
    }
  } finally {
    if (healthServer) await healthServer.close();
  }
```

> Note: this preserves the existing loop logic verbatim; the only additions are the `now()` helper (replacing the two inline `opts.now?.() ?? Date.now()` uses at the old lines 43 and 79), the `health` record + its three assignments, the `startHealthServer` call, and the `try/finally` wrapping. The server is started **before** the `try`, so the `finally` closes it when the loop exits or when `recoverStranded`/the reconcile-first tick throws — but a `startHealthServer` **bind failure** rejects before the server is ever tracked, so it correctly propagates (fail-fast) without a dangling listener.

- [ ] **Step 5: Run the integration test to verify it passes**

Run: `pnpm --filter @quarry-systems/pangolin-orchestrator exec vitest run test/serve-driver-http.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the full orchestrator suite (no regressions in the existing serve tests)**

Run: `pnpm --filter @quarry-systems/pangolin-orchestrator test`
Expected: PASS (existing serve/driver tests plus the new health/http tests).

- [ ] **Step 7: Commit**

```bash
git add packages/pangolin-orchestrator/src/serve/driver.ts packages/pangolin-orchestrator/test/serve-driver-http.test.ts
git commit -m "feat(serve): thread heartbeat + opt-in HTTP endpoint through serve()"
```

---

### Task 6: Wire the endpoint into `deploy/serve-stack`

Make the existing serve container the first consumer: a shared metrics recorder feeds the orchestrator, the client telemetry, and the `/metrics` provider; the Dockerfile gains `EXPOSE` + a Node-`fetch` `HEALTHCHECK`; stale "no inbound port" comments are corrected; the RUNBOOK documents the endpoint.

**Files:**
- Modify: `deploy/serve-stack/package.json` (add the `@quarry-systems/pangolin-core` dependency)
- Modify: `deploy/serve-stack/pangolin.config.mjs` (shared `InMemoryMetricsRecorder` → orchestrator `metrics` + client `telemetry` + `orch.metrics`)
- Modify: `deploy/serve-stack/serve-entrypoint.mjs` (pass the `http` option; fix the header comment)
- Modify: `deploy/serve-stack/Dockerfile` (`EXPOSE` + `HEALTHCHECK`; fix the "No EXPOSE" comment)
- Modify: `deploy/serve-stack/docker-compose.yml` (fix the "No ports" comment; note the internal port)
- Modify: `deploy/serve-stack/RUNBOOK.md` (document the three routes + posture)

**Interfaces:**
- Consumes: `InMemoryMetricsRecorder` (core), `MetricsTelemetryHook` + `combineTelemetryHooks` (client), `serve` + the `http` option (Task 5).
- Produces: `orch.metrics` — the shared `InMemoryMetricsRecorder` instance (so the entrypoint can build `() => orch.metrics.snapshot()`).

- [ ] **Step 1: Write the failing verification check** — `deploy/serve-stack/check-metrics-wiring.mjs`

This package has no vitest setup (only a `smoke` script), so verify the wiring with an import-safe assertion script.

```javascript
// deploy/serve-stack/check-metrics-wiring.mjs
// Import-safe verification that the config exposes a shared metrics recorder whose
// snapshot has the MetricsSnapshot shape. Run: node deploy/serve-stack/check-metrics-wiring.mjs
import { orch } from './pangolin.config.mjs';

const snap = orch.metrics.snapshot();
const ok =
  snap &&
  typeof snap.counters === 'object' &&
  typeof snap.gauges === 'object' &&
  typeof snap.histograms === 'object';
if (!ok) {
  console.error('FAIL: orch.metrics.snapshot() is not a MetricsSnapshot');
  process.exit(1);
}
console.log('ok: orch.metrics.snapshot() shape verified');
```

- [ ] **Step 2: Run the check to verify it fails**

Run: `node deploy/serve-stack/check-metrics-wiring.mjs`
Expected: FAIL — `orch.metrics` is `undefined` (`Cannot read properties of undefined (reading 'snapshot')`).

- [ ] **Step 3: Add the core dependency + the wiring-check script** — `deploy/serve-stack/package.json`

In `dependencies`, add (keep alphabetical-ish with the other `@quarry-systems/*` entries):

```json
    "@quarry-systems/pangolin-core": "workspace:*",
```

And in `scripts`, add the wiring check beside `smoke` so it is discoverable/runnable (not an orphan file):

```json
    "check:metrics-wiring": "node check-metrics-wiring.mjs"
```

Then refresh the workspace link:

Run: `pnpm install`
Expected: exits 0 (adds the workspace link; no lockfile churn beyond the new dep).

- [ ] **Step 4: Wire the shared recorder into the config** — `deploy/serve-stack/pangolin.config.mjs`

(a) Add the core import after the existing client import (line 25):

```javascript
import { InMemoryMetricsRecorder } from '@quarry-systems/pangolin-core';
```

(b) Extend the client import (line 25) to also bring in the metrics hook + the combinator:

```javascript
import { PangolinClient, NoopCredentialProvider, StdoutResultSink, MetricsTelemetryHook, combineTelemetryHooks } from '@quarry-systems/pangolin-client';
```

(c) Construct the shared recorder at module level — add immediately after the `workerImage` const (line 62):

```javascript
// One shared in-memory recorder feeds three places: the client telemetry (dispatch metrics),
// the orchestrator (engine/seal metrics), and the serve /metrics endpoint (orch.metrics.snapshot()).
const metrics = new InMemoryMetricsRecorder();
```

(d) Add `telemetry` to the `PangolinClient` config — inside `new PangolinClient({ … })`, after the `resultSink:` line:

```javascript
  // Dispatch-lifecycle metrics: the lifecycle stream → the shared recorder. Wrapped in
  // combineTelemetryHooks (per spec) so adding a second hook (e.g. ConsoleTelemetryHook) later
  // never silently overwrites this one — a single-slot telemetry field otherwise would.
  telemetry: combineTelemetryHooks(new MetricsTelemetryHook(metrics)),
```

(e) Pass `metrics` to the orchestrator — in `createOrchestrator()`, in the `new PangolinOrchestrator({ … })` call, after `auditLog,`:

```javascript
    metrics,
```

(f) Expose the recorder on the `orch` export — add `metrics,` to the exported object:

```javascript
export const orch = {
  transport,
  anchor,
  storage,
  verifySignature,
  createOrchestrator,
  metrics,
};
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `node deploy/serve-stack/check-metrics-wiring.mjs`
Expected: `ok: orch.metrics.snapshot() shape verified` (requires `pnpm -r build` first if the workspace `dist` is stale — see Step 9).

- [ ] **Step 6: Pass the `http` option from the entrypoint** — `deploy/serve-stack/serve-entrypoint.mjs`

Replace the final `serve(...)` call (line 27) with:

```javascript
const httpPort = Number(process.env.PANGOLIN_HTTP_PORT ?? 9464);
console.log(`[serve] starting tick+inbox loop; health/metrics on :${httpPort}…`);
await serve({
  orchestrator,
  transport: orch.transport,
  signal: ac.signal,
  http: { port: httpPort, metricsSnapshot: () => orch.metrics.snapshot() },
});
```

Also fix the now-stale header comment in the same file — replace the block at lines 6-8:

```javascript
// An HTTP observability port (PANGOLIN_HTTP_PORT, default 9464) serves /healthz, /readyz,
// and /metrics. The serve container remains the sole SQLite writer and the only caller of
// orchestrator.tick(); workers are launched as Docker siblings via the mounted socket
// (wired in docker-compose, not here).
```

- [ ] **Step 7: Add `EXPOSE` + `HEALTHCHECK` and fix the comment** — `deploy/serve-stack/Dockerfile`

(a) Replace the stale comment at line 19 (`# No EXPOSE — the serve container opens no inbound port.`) with:

```dockerfile
# EXPOSE/HEALTHCHECK below: the serve container opens ONE inbound port — the HTTP
# observability endpoint (/healthz, /readyz, /metrics). All run-submission traffic
# still flows over the S3 mailbox, not this port.
```

(b) Add immediately before the final `CMD` line (line 84):

```dockerfile
# HTTP observability port (overridable via PANGOLIN_HTTP_PORT; default 9464).
EXPOSE 9464

# Liveness probe: hit /healthz with Node's global fetch (no curl/wget in node:20-slim).
# Probes /healthz ONLY — never /readyz: restarting on readiness would storm-restart on a
# dependency outage. start-period covers startup before the first tick (/healthz 503 starting).
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PANGOLIN_HTTP_PORT||9464)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
```

- [ ] **Step 8: Fix the compose comment + note the internal port** — `deploy/serve-stack/docker-compose.yml`

Replace the stale comment at line 161 (`# No `ports:` — serve exposes no inbound port.  It communicates exclusively / # via the MinIO mailbox (S3 object put/get).`) with:

```yaml
    # The serve container exposes ONE inbound port — the HTTP observability endpoint
    # (/healthz, /readyz, /metrics, default 9464). It is intentionally NOT published to
    # the host: a Prometheus scraper on this compose network reaches it at `serve:9464`
    # by service name. Do not add a host `ports:` mapping for it — keep /metrics on a
    # trusted interface (use the existing SSH tunnel for laptop access). Run submissions
    # still flow exclusively over the MinIO mailbox (S3 object put/get).
```

(No `ports:` entry is added — the port stays internal. The image's `HEALTHCHECK` provides the compose-visible health status.)

- [ ] **Step 9: Build the workspace and re-run the wiring check**

Run: `pnpm -r build && node deploy/serve-stack/check-metrics-wiring.mjs`
Expected: build exits 0; check prints `ok: orch.metrics.snapshot() shape verified`.

> Note: this check verifies the recorder is *exposed* on `orch.metrics`. The orchestrator actually *consuming* it (Step 4e's `metrics,` in `new PangolinOrchestrator({…})`) is verified by `pnpm -r typecheck` + manual review + the final e2e (which exercises the dispatch path) — `createOrchestrator()` opens SQLite, so the check script intentionally does not call it.

- [ ] **Step 10: Document the endpoint** — `deploy/serve-stack/RUNBOOK.md`

Add a new section (place it after the existing health-check / smoke content):

```markdown
## HTTP observability endpoint

The serve container exposes an HTTP port (`PANGOLIN_HTTP_PORT`, default `9464`):

| Route | Meaning |
|---|---|
| `GET /healthz` | **Liveness.** `200` while the tick loop is progressing; `503 stale` if the loop has wedged (no completed tick within the staleness window); `503 starting` before the first tick. The Docker `HEALTHCHECK` probes this route. |
| `GET /readyz` | **Readiness.** `200` when the most recent tick completed without error; `503 not-ready` when ticks are still running but failing (SQLite/S3 mailbox unreachable). |
| `GET /metrics` | Prometheus text exposition of the run/dispatch metrics (counters, gauges, histograms). |

**Liveness vs readiness — operator rule:** a **red `/readyz` with a green `/healthz`** means "the loop is alive but a dependency (SQLite / S3) is unreachable — do NOT restart the container; investigate the backend." The container `HEALTHCHECK` deliberately drives restarts off `/healthz` only, never `/readyz`, to avoid restart storms during a dependency outage.

**Security posture (v1):** the endpoint is **unauthenticated**. It is not published to the host and must stay on a trusted/internal interface — a Prometheus scraper reaches `serve:9464` over the compose network; for laptop access use the existing SSH tunnel. Never expose `/metrics` to the public internet. The payload carries operational counters only (bounded-cardinality labels, no secrets, no audit material).
```

- [ ] **Step 11: Final verification + commit**

Run: `pnpm -r typecheck && pnpm -r lint`
Expected: both exit 0.

```bash
git add deploy/serve-stack/package.json deploy/serve-stack/pangolin.config.mjs deploy/serve-stack/serve-entrypoint.mjs deploy/serve-stack/Dockerfile deploy/serve-stack/docker-compose.yml deploy/serve-stack/RUNBOOK.md deploy/serve-stack/check-metrics-wiring.mjs pnpm-lock.yaml
git commit -m "feat(serve-stack): wire HTTP health/readiness/metrics endpoint into the deploy container"
```

---

## Final verification (after all tasks)

- [ ] `pnpm --filter @quarry-systems/pangolin-core build` — exits 0 (new core exports compiled).
- [ ] `pnpm -r typecheck` — exits 0.
- [ ] `pnpm -r lint` — exits 0.
- [ ] `pnpm --filter @quarry-systems/pangolin-core test` — green (series-key + prometheus + existing metrics).
- [ ] `pnpm --filter @quarry-systems/pangolin-orchestrator test` — green (health-eval + http-server + driver-http + existing serve tests).
- [ ] `pnpm test:e2e` — green (the serve/dispatch path is exercised end-to-end; no regression).
- [ ] `node deploy/serve-stack/check-metrics-wiring.mjs` — prints `ok`.
- [ ] Grep check: `grep -rn "pangolin serve-http" packages/` returns nothing (the `[pangolin serve]` prefix is reused, per Global Constraints).
