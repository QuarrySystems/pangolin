# Metrics Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dependency-light metrics layer — a `MetricsRecorder` seam + in-memory reference impl in `pangolin-core`, a dispatch-metrics telemetry bridge + hook combinator in `pangolin-client`, and orchestrator-engine instrumentation — collecting the spec's 10-metric set through one shared recorder with no double-counting.

**Architecture:** A 3-primitive `MetricsRecorder` interface (counter/gauge/histogram) with a guarded `recordMetric` call wrapper. Two sources feed one shared recorder: dispatch-level via a `MetricsTelemetryHook` over the existing telemetry spine, and orchestrator-level via an `orchestrator.metrics` option instrumented in `tick` + the seal path. Exposure (HTTP `/metrics`) and Prometheus/OTel backends are explicitly out of scope.

**Tech Stack:** TypeScript, Vitest, the existing `@quarry-systems/pangolin-core` types, the `pangolin-client` telemetry seam (`TelemetryHook`/`LifecycleEvent`/`emitLifecycleEvent`), the `pangolin-orchestrator` engine.

**Spec:** `docs/superpowers/specs/2026-06-19-metrics-layer-design.md`

## Global Constraints

- **Dependency-light:** NO new runtime dependency (no Prometheus/OTel/HTTP client). The seam + in-memory impl use only stdlib.
- **Bounded-cardinality labels only:** dimension metrics by `outcome` / `queue` ONLY — never `dispatchId`/`runId`.
- **Naming:** metric names are `pangolin_`-prefixed `snake_case`; counters end `_total`; durations end `_seconds`.
- **Guarded recording:** EVERY instrumentation call site goes through `recordMetric(recorder, (m) => …)` — a throwing recorder must never break a tick or dispatch; it is caught + logged to **stderr** (`console.error`, `[pangolin metrics] …`) and never rethrown.
- **No double-count:** dispatch-outcome metrics come ONLY from `MetricsTelemetryHook`; orchestrator metrics come ONLY from the engine. (The deadline overrun intentionally bumps both `dispatch_completed_total{outcome=failed}` via telemetry and `dispatch_deadline_exceeded_total` via the engine.)
- **Default `NoopMetricsRecorder`** everywhere `metrics` is unset.
- **TDD; frequent commits.**
- **STALE-DIST:** `pangolin-client` and `pangolin-orchestrator` import `pangolin-core` from its built `dist`. After any `pangolin-core` change, run `pnpm --filter @quarry-systems/pangolin-core build` BEFORE running client/orchestrator tests.
- **Per-task gate:** the touched package's `pnpm --filter <pkg> test`. **Before declaring the plan done:** `pnpm -r typecheck` + `pnpm -r lint`; and because Task 4 touches the engine, run `pnpm --filter @quarry-systems/pangolin-orchestrator test` + `pnpm test:e2e`.

## File Structure

- **Create** `packages/pangolin-core/src/metrics.ts` — the `MetricsRecorder` seam, `MetricsSnapshot` type, `NoopMetricsRecorder`, `recordMetric`.
- **Create** `packages/pangolin-core/src/metrics-in-memory.ts` — `InMemoryMetricsRecorder` (aggregation + `snapshot()`).
- **Modify** `packages/pangolin-core/src/index.ts` — export both new modules.
- **Create** `packages/pangolin-core/test/metrics.test.ts`, `packages/pangolin-core/test/metrics-in-memory.test.ts`.
- **Modify** `packages/pangolin-client/src/bundled-impls.ts` — add `MetricsTelemetryHook`.
- **Modify** `packages/pangolin-client/src/lifecycle-emit.ts` — add `combineTelemetryHooks`.
- **Modify** `packages/pangolin-client/src/index.ts` — export both.
- **Create** `packages/pangolin-client/test/metrics-telemetry-hook.test.ts`.
- **Modify** `packages/pangolin-orchestrator/src/orchestrator.ts` — `metrics` option + seal-path instrumentation.
- **Modify** `packages/pangolin-orchestrator/src/engine/tick.ts` — engine instrumentation.
- **Modify** `packages/pangolin-orchestrator/test/tick.test.ts` (+ a small orchestrator test) — assertions.
- **Modify** `docs-site/src/content/docs/reference/config.md` — document the metrics wiring.

---

### Task 1: `MetricsRecorder` seam + `NoopMetricsRecorder` + `recordMetric` (core)

**Files:**
- Create: `packages/pangolin-core/src/metrics.ts`
- Create: `packages/pangolin-core/test/metrics.test.ts`
- Modify: `packages/pangolin-core/src/index.ts` (add `export * from './metrics.js';` beside the other `export * from './telemetry.js';` lines)

**Interfaces:**
- Produces: `interface MetricsRecorder { readonly name: string; counter(name: string, value?: number, labels?: Record<string,string>): void; gauge(name: string, value: number, labels?: Record<string,string>): void; histogram(name: string, value: number, labels?: Record<string,string>): void; }`; `interface MetricsSnapshot { counters: Record<string,number>; gauges: Record<string,number>; histograms: Record<string, { count: number; sum: number; buckets: Record<string,number> }>; }`; `class NoopMetricsRecorder implements MetricsRecorder`; `function recordMetric(recorder: MetricsRecorder | undefined, record: (r: MetricsRecorder) => void): void`.

- [ ] **Step 1: Write the failing test** — `packages/pangolin-core/test/metrics.test.ts`

```typescript
import { it, expect, vi } from 'vitest';
import { NoopMetricsRecorder, recordMetric } from '../src/metrics.js';
import type { MetricsRecorder } from '../src/metrics.js';

it('NoopMetricsRecorder drops every call without throwing', () => {
  const r = new NoopMetricsRecorder();
  expect(r.name).toBe('noop');
  expect(() => {
    r.counter('x');
    r.gauge('y', 1);
    r.histogram('z', 2);
  }).not.toThrow();
});

it('recordMetric is a no-op when the recorder is undefined', () => {
  expect(() => recordMetric(undefined, () => { throw new Error('should not run'); })).not.toThrow();
});

it('recordMetric forwards to the recorder', () => {
  const calls: string[] = [];
  const r: MetricsRecorder = {
    name: 'rec',
    counter: (n) => calls.push(`counter:${n}`),
    gauge: () => {},
    histogram: () => {},
  };
  recordMetric(r, (m) => m.counter('pangolin_x_total'));
  expect(calls).toEqual(['counter:pangolin_x_total']);
});

it('recordMetric swallows a throwing recorder and logs to stderr (never breaks the caller)', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const r: MetricsRecorder = {
      name: 'boom',
      counter: () => { throw new Error('rec down'); },
      gauge: () => {},
      histogram: () => {},
    };
    expect(() => recordMetric(r, (m) => m.counter('x'))).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]![0])).toContain('boom');
  } finally {
    spy.mockRestore();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @quarry-systems/pangolin-core exec vitest run test/metrics.test.ts`
Expected: FAIL — `metrics.js` does not exist (import/resolution error).

- [ ] **Step 3: Create the seam** — `packages/pangolin-core/src/metrics.ts`

```typescript
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
```

- [ ] **Step 4: Export from the core index** — `packages/pangolin-core/src/index.ts`

Add, beside the existing `export * from './telemetry.js';`:

```typescript
export * from './metrics.js';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @quarry-systems/pangolin-core exec vitest run test/metrics.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/pangolin-core/src/metrics.ts packages/pangolin-core/test/metrics.test.ts packages/pangolin-core/src/index.ts
git commit -m "feat(metrics): MetricsRecorder seam + NoopMetricsRecorder + guarded recordMetric"
```

---

### Task 2: `InMemoryMetricsRecorder` reference impl (core)

**Files:**
- Create: `packages/pangolin-core/src/metrics-in-memory.ts`
- Create: `packages/pangolin-core/test/metrics-in-memory.test.ts`
- Modify: `packages/pangolin-core/src/index.ts` (add `export * from './metrics-in-memory.js';`)

**Interfaces:**
- Consumes: `MetricsRecorder`, `MetricsSnapshot` (Task 1).
- Produces: `class InMemoryMetricsRecorder implements MetricsRecorder { constructor(buckets?: number[]); snapshot(): MetricsSnapshot }`. Default buckets `[0.5, 1, 5, 10, 30, 60, 300, 900, 1800, 3600, 7200]`. Series key: `name` with no labels, else `name{k="v",…}` sorted by key. Histogram buckets in the snapshot are cumulative (`le` bound → count of observations ≤ bound), plus a `+Inf` bucket equal to `count`.

- [ ] **Step 1: Write the failing test** — `packages/pangolin-core/test/metrics-in-memory.test.ts`

```typescript
import { it, expect } from 'vitest';
import { InMemoryMetricsRecorder } from '../src/metrics-in-memory.js';

it('counter sums by series key; labels produce a sorted series key', () => {
  const r = new InMemoryMetricsRecorder();
  r.counter('pangolin_x_total');
  r.counter('pangolin_x_total', 2);
  r.counter('pangolin_done_total', 1, { b: '2', a: '1' });
  const s = r.snapshot();
  expect(s.counters['pangolin_x_total']).toBe(3);
  expect(s.counters['pangolin_done_total{a="1",b="2"}']).toBe(1);
});

it('gauge is last-write-wins per series', () => {
  const r = new InMemoryMetricsRecorder();
  r.gauge('pangolin_queue_depth', 5, { queue: 'default' });
  r.gauge('pangolin_queue_depth', 2, { queue: 'default' });
  expect(r.snapshot().gauges['pangolin_queue_depth{queue="default"}']).toBe(2);
});

it('histogram accumulates count, sum, and cumulative buckets (+Inf = count)', () => {
  const r = new InMemoryMetricsRecorder([1, 10]);
  r.histogram('pangolin_dispatch_duration_seconds', 0.5); // <= 1 and <= 10
  r.histogram('pangolin_dispatch_duration_seconds', 5); // <= 10 only
  r.histogram('pangolin_dispatch_duration_seconds', 50); // neither bounded bucket
  const h = r.snapshot().histograms['pangolin_dispatch_duration_seconds'];
  expect(h.count).toBe(3);
  expect(h.sum).toBe(55.5);
  expect(h.buckets['1']).toBe(1);
  expect(h.buckets['10']).toBe(2);
  expect(h.buckets['+Inf']).toBe(3);
});

it('snapshot returns an independent copy (mutating after snapshot does not change it)', () => {
  const r = new InMemoryMetricsRecorder();
  r.counter('pangolin_x_total');
  const s = r.snapshot();
  r.counter('pangolin_x_total');
  expect(s.counters['pangolin_x_total']).toBe(1); // snapshot frozen at time of call
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @quarry-systems/pangolin-core exec vitest run test/metrics-in-memory.test.ts`
Expected: FAIL — `metrics-in-memory.js` does not exist.

- [ ] **Step 3: Implement** — `packages/pangolin-core/src/metrics-in-memory.ts`

```typescript
import type { MetricsRecorder, MetricsSnapshot } from './metrics.js';

const DEFAULT_BUCKETS = [0.5, 1, 5, 10, 30, 60, 300, 900, 1800, 3600, 7200];

/** Prometheus-style series id: `name` alone, or `name{k="v",…}` with labels sorted by key. Label
 *  VALUES are assumed simple identifiers (the metric set uses only bounded `outcome`/`queue`); no
 *  escaping is performed, so callers must not pass values containing `"`, `,`, or `}`. */
function seriesKey(name: string, labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k]}"`);
  return `${name}{${parts.join(',')}}`;
}

interface Hist {
  count: number;
  sum: number;
  cumulative: number[]; // aligned to `buckets`; cumulative[i] = #observations <= buckets[i]
}

/** In-memory aggregating recorder. The reference impl: collection only, no exposure. Read the
 *  current values via `snapshot()`; a future /metrics endpoint or a Prometheus/OTel adapter renders. */
export class InMemoryMetricsRecorder implements MetricsRecorder {
  readonly name = 'in-memory';
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly hists = new Map<string, Hist>();

  constructor(private readonly buckets: number[] = DEFAULT_BUCKETS) {}

  counter(name: string, value = 1, labels?: Record<string, string>): void {
    const k = seriesKey(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + value);
  }

  gauge(name: string, value: number, labels?: Record<string, string>): void {
    this.gauges.set(seriesKey(name, labels), value);
  }

  histogram(name: string, value: number, labels?: Record<string, string>): void {
    const k = seriesKey(name, labels);
    let h = this.hists.get(k);
    if (!h) {
      h = { count: 0, sum: 0, cumulative: this.buckets.map(() => 0) };
      this.hists.set(k, h);
    }
    h.count += 1;
    h.sum += value;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]!) h.cumulative[i]! += 1;
    }
  }

  snapshot(): MetricsSnapshot {
    const counters: Record<string, number> = {};
    for (const [k, v] of this.counters) counters[k] = v;
    const gauges: Record<string, number> = {};
    for (const [k, v] of this.gauges) gauges[k] = v;
    const histograms: MetricsSnapshot['histograms'] = {};
    for (const [k, h] of this.hists) {
      const buckets: Record<string, number> = {};
      for (let i = 0; i < this.buckets.length; i++) {
        buckets[String(this.buckets[i])] = h.cumulative[i]!;
      }
      buckets['+Inf'] = h.count;
      histograms[k] = { count: h.count, sum: h.sum, buckets };
    }
    return { counters, gauges, histograms };
  }
}
```

- [ ] **Step 4: Export** — `packages/pangolin-core/src/index.ts`: add `export * from './metrics-in-memory.js';`

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @quarry-systems/pangolin-core exec vitest run test/metrics-in-memory.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Build core (so downstream packages see the new exports) and run the core suite**

Run: `pnpm --filter @quarry-systems/pangolin-core build && pnpm --filter @quarry-systems/pangolin-core test`
Expected: build clean; full core suite PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/pangolin-core/src/metrics-in-memory.ts packages/pangolin-core/test/metrics-in-memory.test.ts packages/pangolin-core/src/index.ts
git commit -m "feat(metrics): InMemoryMetricsRecorder reference impl + snapshot()"
```

---

### Task 3: `MetricsTelemetryHook` + `combineTelemetryHooks` (client)

**Files:**
- Modify: `packages/pangolin-client/src/bundled-impls.ts` (add `MetricsTelemetryHook` after `ConsoleTelemetryHook`)
- Modify: `packages/pangolin-client/src/lifecycle-emit.ts` (add `combineTelemetryHooks`)
- Modify: `packages/pangolin-client/src/index.ts` (export both, beside `ConsoleTelemetryHook`)
- Create: `packages/pangolin-client/test/metrics-telemetry-hook.test.ts`

**Interfaces:**
- Consumes: `MetricsRecorder`, `recordMetric`, `InMemoryMetricsRecorder` (core, Tasks 1-2); `TelemetryHook`, `LifecycleEvent`, `emitLifecycleEvent` (existing).
- Produces: `class MetricsTelemetryHook implements TelemetryHook { constructor(recorder: MetricsRecorder); name = 'metrics' }`; `function combineTelemetryHooks(...hooks: TelemetryHook[]): TelemetryHook`.

- [ ] **Step 1: Write the failing test** — `packages/pangolin-client/test/metrics-telemetry-hook.test.ts`

```typescript
import { it, expect } from 'vitest';
import { MetricsTelemetryHook, combineTelemetryHooks } from '../src/index.js';
import { InMemoryMetricsRecorder } from '@quarry-systems/pangolin-core';
import type { LifecycleEvent, TelemetryHook } from '@quarry-systems/pangolin-core';

const AT = '2026-01-01T00:00:00.000Z';

it('maps lifecycle events to dispatch metrics (outcome label + duration on finished/needs_input)', () => {
  const rec = new InMemoryMetricsRecorder();
  const hook = new MetricsTelemetryHook(rec);
  hook.emit({ kind: 'dispatch.accepted', dispatchId: 'd', target: 't', resolved: [], at: AT });
  hook.emit({ kind: 'dispatch.started', dispatchId: 'd', providerTaskId: 'p', at: AT });
  hook.emit({ kind: 'dispatch.finished', dispatchId: 'd', exitCode: 0, durationMs: 2000, at: AT });
  hook.emit({ kind: 'dispatch.failed', dispatchId: 'd', reason: 'x', at: AT });
  hook.emit({ kind: 'dispatch.cancelled', dispatchId: 'd', at: AT });
  const s = rec.snapshot();
  expect(s.counters['pangolin_dispatch_started_total']).toBe(1);
  expect(s.counters['pangolin_dispatch_completed_total{outcome="finished"}']).toBe(1);
  expect(s.counters['pangolin_dispatch_completed_total{outcome="failed"}']).toBe(1);
  expect(s.counters['pangolin_dispatch_completed_total{outcome="cancelled"}']).toBe(1);
  // accepted produces no metric:
  expect(s.counters['pangolin_dispatch_accepted_total']).toBeUndefined();
  // duration observed once (from finished; failed/cancelled carry no durationMs):
  expect(s.histograms['pangolin_dispatch_duration_seconds'].count).toBe(1);
  expect(s.histograms['pangolin_dispatch_duration_seconds'].sum).toBe(2);
});

it('combineTelemetryHooks fans out to all hooks and isolates a throwing one', () => {
  const seenA: string[] = [];
  const hookA: TelemetryHook = { name: 'a', emit: (e) => seenA.push(e.kind) };
  const hookB: TelemetryHook = {
    name: 'boom',
    emit: () => {
      throw new Error('b down');
    },
  };
  const seenC: string[] = [];
  const hookC: TelemetryHook = { name: 'c', emit: (e) => seenC.push(e.kind) };
  const combined = combineTelemetryHooks(hookA, hookB, hookC);
  const started: LifecycleEvent = { kind: 'dispatch.started', dispatchId: 'd', providerTaskId: 'p', at: AT };
  expect(() => combined.emit(started)).not.toThrow();
  expect(seenA).toEqual(['dispatch.started']);
  expect(seenC).toEqual(['dispatch.started']); // C still ran despite B throwing
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @quarry-systems/pangolin-core build && pnpm --filter @quarry-systems/pangolin-client exec vitest run test/metrics-telemetry-hook.test.ts`
Expected: FAIL — `MetricsTelemetryHook` / `combineTelemetryHooks` are not exported.

- [ ] **Step 3: Add `MetricsTelemetryHook`** — `packages/pangolin-client/src/bundled-impls.ts`, after the `ConsoleTelemetryHook` class

First ensure the imports at the top of the file include (add to the existing `@quarry-systems/pangolin-core` import group): `MetricsRecorder`, `recordMetric`.

```typescript
/**
 * `TelemetryHook` that records dispatch-lifecycle metrics into a `MetricsRecorder`. Dispatch-outcome
 * classification lives here (one place), derived from the lifecycle stream — not re-derived in the
 * engine. Wire as the client's telemetry hook (with `combineTelemetryHooks` if you also want
 * `ConsoleTelemetryHook`).
 */
export class MetricsTelemetryHook implements TelemetryHook {
  readonly name = 'metrics';

  constructor(private readonly recorder: MetricsRecorder) {}

  emit(event: LifecycleEvent): void {
    switch (event.kind) {
      case 'dispatch.started':
        recordMetric(this.recorder, (m) => m.counter('pangolin_dispatch_started_total'));
        break;
      case 'dispatch.finished':
        recordMetric(this.recorder, (m) => {
          m.counter('pangolin_dispatch_completed_total', 1, { outcome: 'finished' });
          m.histogram('pangolin_dispatch_duration_seconds', event.durationMs / 1000);
        });
        break;
      case 'dispatch.needs_input':
        recordMetric(this.recorder, (m) => {
          m.counter('pangolin_dispatch_completed_total', 1, { outcome: 'needs_input' });
          m.histogram('pangolin_dispatch_duration_seconds', event.durationMs / 1000);
        });
        break;
      case 'dispatch.failed':
        recordMetric(this.recorder, (m) =>
          m.counter('pangolin_dispatch_completed_total', 1, { outcome: 'failed' }),
        );
        break;
      case 'dispatch.cancelled':
        recordMetric(this.recorder, (m) =>
          m.counter('pangolin_dispatch_completed_total', 1, { outcome: 'cancelled' }),
        );
        break;
      // 'dispatch.accepted' produces no metric (the set tracks started, not accepted).
    }
  }
}
```

- [ ] **Step 4: Add `combineTelemetryHooks`** — `packages/pangolin-client/src/lifecycle-emit.ts`, after `emitLifecycleEvent`

```typescript
import type { TelemetryHook } from '@quarry-systems/pangolin-core';

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
```

(If `lifecycle-emit.ts` already imports `TelemetryHook` from core, reuse that import instead of adding a duplicate; `LifecycleEvent` is the `event` param type and is already in scope via `emitLifecycleEvent`'s signature.)

- [ ] **Step 5: Export both** — `packages/pangolin-client/src/index.ts`

Add `MetricsTelemetryHook` beside the existing `ConsoleTelemetryHook` export, and export `combineTelemetryHooks` from the `lifecycle-emit.js` re-export (or add `export { combineTelemetryHooks } from './lifecycle-emit.js';` if `emitLifecycleEvent` is similarly exported there — match the existing pattern for how `lifecycle-emit` symbols are surfaced).

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @quarry-systems/pangolin-client exec vitest run test/metrics-telemetry-hook.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Run the full client suite**

Run: `pnpm --filter @quarry-systems/pangolin-client test`
Expected: PASS (no regressions).

- [ ] **Step 8: Commit**

```bash
git add packages/pangolin-client/src/bundled-impls.ts packages/pangolin-client/src/lifecycle-emit.ts packages/pangolin-client/src/index.ts packages/pangolin-client/test/metrics-telemetry-hook.test.ts
git commit -m "feat(metrics): MetricsTelemetryHook dispatch bridge + combineTelemetryHooks"
```

---

### Task 4: Orchestrator engine instrumentation + docs

**Files:**
- Modify: `packages/pangolin-orchestrator/src/orchestrator.ts` (the `metrics` option + seal-path metrics)
- Modify: `packages/pangolin-orchestrator/src/engine/tick.ts` (engine metrics)
- Modify: `packages/pangolin-orchestrator/test/tick.test.ts` (assertions)
- Modify: `docs-site/src/content/docs/reference/config.md` (wiring docs)

**Interfaces:**
- Consumes: `MetricsRecorder`, `NoopMetricsRecorder`, `recordMetric`, `InMemoryMetricsRecorder` (core).
- Produces: `PangolinOrchestratorOptions.metrics?: MetricsRecorder`; `tick`'s opts gains `metrics?: MetricsRecorder`. Metrics emitted: `pangolin_queue_depth{queue}`, `pangolin_running{queue}` (gauges), `pangolin_items_retried_total`, `pangolin_items_skipped_total`, `pangolin_dispatch_deadline_exceeded_total`, `pangolin_runs_completed_total` (counters), `pangolin_audit_dropped_appends` (gauge).
- **Limitation (document in the config.md note, Step 7):** `pangolin_runs_completed_total` and `pangolin_audit_dropped_appends` are recorded in the orchestrator's seal block, which only runs when an `AuditLog` is configured — so those two metrics require `auditLog`. The other (tick-level) metrics do not. This is an accepted consequence of detecting run-completion at the seal point; real audited-compute deployments always configure `auditLog`.

- [ ] **Step 1: Write the failing tests** — append to `packages/pangolin-orchestrator/test/tick.test.ts`

Reuse the file's existing `SqliteRunStateStore` + fake-executor harness (see the deadline tests for `setRunning(id, hash, runningSinceMs)` + `tick(store, execs, 'default', undefined, opts)`). Import `InMemoryMetricsRecorder` from `@quarry-systems/pangolin-core`.

```typescript
import { InMemoryMetricsRecorder } from '@quarry-systems/pangolin-core';

it('tick records queue_depth + running gauges and a retried counter', async () => {
  const store = new SqliteRunStateStore();
  store.ensureQueue('default', 5);
  store.saveRun({
    id: 'rm1',
    queue: 'default',
    items: [
      { id: 'a', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: [] },
      { id: 'b', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: [] },
    ],
  });
  store.markReady(['a']); // a ready, b still pending
  // 'a' is running and will be force-failed-then-retried via the deadline path:
  store.setRunning('a', 'h-a', 1000);
  store.acquireLocks('a', []);
  const hung: Executor = {
    id: 'fake',
    async fire(i) { return { dispatchHash: `h-${i.id}` }; },
    async reconcile() { return null; },
  };
  const metrics = new InMemoryMetricsRecorder();
  await tick(store, { fake: hung }, 'default', undefined, {
    now: 1000 + 60_000,
    maxRuntimeMs: 30_000,
    maxAttempts: 2, // attempts remain → 'a' retries
    backoffMs: () => 5_000,
    metrics,
  });
  const s = metrics.snapshot();
  expect(s.counters['pangolin_items_retried_total']).toBe(1);
  expect(s.counters['pangolin_dispatch_deadline_exceeded_total']).toBe(1);
  // gauges are recorded for the queue (exact post-tick depth depends on dep-readying + fire order,
  // so assert the series were recorded rather than a brittle exact value):
  expect(s.gauges).toHaveProperty('pangolin_queue_depth{queue="default"}');
  expect(s.gauges).toHaveProperty('pangolin_running{queue="default"}');
  store.close();
});

it('tick records a skipped counter when a dependency fails and cascades', async () => {
  const store = new SqliteRunStateStore();
  store.ensureQueue('default', 5);
  store.saveRun({
    id: 'rm2',
    queue: 'default',
    items: [
      { id: 'p', executor: 'nonexistent', inputs: {}, depends_on: [], resourceLocks: [] },
      { id: 'c', executor: 'fake', inputs: {}, depends_on: ['p'], resourceLocks: [] },
    ],
  });
  store.markReady(['p']);
  const metrics = new InMemoryMetricsRecorder();
  // 'p' fails (no executor) → 'c' is skipped by the cascade.
  await tick(store, { fake: { id: 'fake', async fire() { return { dispatchHash: 'x' }; }, async reconcile() { return null; } } }, 'default', undefined, { metrics });
  expect(metrics.snapshot().counters['pangolin_items_skipped_total']).toBe(1);
  store.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @quarry-systems/pangolin-core build && pnpm --filter @quarry-systems/pangolin-orchestrator exec vitest run test/tick.test.ts -t "queue_depth" -t "skipped counter"`
Expected: FAIL — `tick` does not accept `metrics` / records nothing yet.

- [ ] **Step 3: Add `metrics` to the tick opts and instrument** — `packages/pangolin-orchestrator/src/engine/tick.ts`

Add the import at the top: `import { recordMetric, type MetricsRecorder } from '@quarry-systems/pangolin-core';`

Add `metrics?: MetricsRecorder;` to the `opts` object type (beside `maxRuntimeMs?: number;`). After the existing `const maxRuntimeMs = opts.maxRuntimeMs;` line add: `const metrics = opts.metrics;`.

In the reconcile loop, inside the `if (overrun) {` block (right after the best-effort `ex.cancel?.()` try/catch, before `res = { status: 'failed' };`), add:

```typescript
      recordMetric(metrics, (m) => m.counter('pangolin_dispatch_deadline_exceeded_total'));
```

In the retry branch (inside `if (res.status === 'failed' && store.getAttempts(it.id) + 1 < maxAttempts) {`, after the `audit({ kind: 'item.retried', … })` line), add:

```typescript
        recordMetric(metrics, (m) => m.counter('pangolin_items_retried_total'));
```

In the cascade loop (step 4 — `for (const id of computeSkipped(currentItems)) { … }`, after the `audit({ kind: 'item.skipped', … })` line), add:

```typescript
    recordMetric(metrics, (m) => m.counter('pangolin_items_skipped_total'));
```

Just before the final `return { readied: …, fired, reconciled };`, record the gauges:

```typescript
  recordMetric(metrics, (m) => {
    const inQueue = store.getItems().filter((i) => i.queue === queue);
    const depth = inQueue.filter((i) => i.status === 'ready' || i.status === 'pending').length;
    m.gauge('pangolin_queue_depth', depth, { queue });
    m.gauge('pangolin_running', store.runningCount(queue), { queue });
  });
```

- [ ] **Step 4: Run the tick tests to verify they pass**

Run: `pnpm --filter @quarry-systems/pangolin-orchestrator exec vitest run test/tick.test.ts -t "queue_depth" -t "skipped counter"`
Expected: PASS.

- [ ] **Step 5: Wire the orchestrator option + seal-path metrics** — `packages/pangolin-orchestrator/src/orchestrator.ts`

Add the import: `import { NoopMetricsRecorder, recordMetric, type MetricsRecorder } from '@quarry-systems/pangolin-core';`

Add `metrics?: MetricsRecorder;` to `PangolinOrchestratorOptions` (beside `maxRuntimeMs?`). Add a private field `private readonly metrics: MetricsRecorder;` and in the constructor: `this.metrics = opts.metrics ?? new NoopMetricsRecorder();`.

In `tick()`, pass it into the engine call (beside `maxRuntimeMs: this.maxRuntimeMs,`): `metrics: this.metrics,`.

In the seal block (inside `if (this.auditLog) {`): after a successful `await this.auditLog.sealEpoch(runId);` (inside that inner `try`, on the line after the seal), record the run completion:

```typescript
              recordMetric(this.metrics, (m) => m.counter('pangolin_runs_completed_total'));
```

And after the `for (const runId of runIds)` loop closes (still inside `if (this.auditLog)`), record the audit-completeness gauge:

```typescript
        recordMetric(this.metrics, (m) =>
          m.gauge('pangolin_audit_dropped_appends', this.auditLog!.droppedAppends),
        );
```

- [ ] **Step 6: Write + run a seal-metrics test** — append to `packages/pangolin-orchestrator/test/tick.test.ts` (or the existing orchestrator audit test file if one fits better)

```typescript
import { PangolinOrchestrator } from '../src/orchestrator.js';
// (reuse the file's existing AuditLog/anchor/signer harness imports if present; otherwise mirror
//  test/audit/audit-log.test.ts's fakeAnchor + fakeSigner + a fresh SqliteRunStateStore.)

it('orchestrator records runs_completed + audit_dropped_appends after a run seals', async () => {
  // Build an orchestrator with an AuditLog, a fake executor that completes one item, an
  // InMemoryMetricsRecorder, and drive ticks until the single-item run seals. Then assert:
  //   snapshot().counters['pangolin_runs_completed_total'] >= 1
  //   typeof snapshot().gauges['pangolin_audit_dropped_appends'] === 'number'
  // Use the same orchestrator construction the file's existing audit/seal tests use
  // (PangolinOrchestrator({ store, executors, triggers, queues, auditLog, metrics })), driving
  // orch.tick('default') until getStatus shows the item done + the audit export root is defined.
});
```

Implement this test concretely by mirroring the nearest existing orchestrator-seal test in the package (look in `test/audit/` and `test/*.int.test.ts`), passing `metrics: new InMemoryMetricsRecorder()` into the orchestrator and asserting the two metrics after the seal. Then run:

Run: `pnpm --filter @quarry-systems/pangolin-orchestrator exec vitest run test/tick.test.ts -t "runs_completed"`
Expected: PASS.

- [ ] **Step 7: Document the wiring** — `docs-site/src/content/docs/reference/config.md`

Near the telemetry opt-in comment added earlier (the `ConsoleTelemetryHook` block), add a metrics example:

```javascript
// Metrics (opt-in; default records nothing). One shared recorder feeds two sources:
//   import { InMemoryMetricsRecorder } from '@quarry-systems/pangolin-core';
//   import { MetricsTelemetryHook, combineTelemetryHooks, ConsoleTelemetryHook } from '@quarry-systems/pangolin-client';
//   const metrics = new InMemoryMetricsRecorder();
//   const client = new PangolinClient({ /* …, */
//     telemetry: combineTelemetryHooks(new ConsoleTelemetryHook(), new MetricsTelemetryHook(metrics)) });
//   const orchestrator = new PangolinOrchestrator({ /* …, */ metrics });  // SAME recorder
//   // read metrics.snapshot() (a /metrics endpoint / Prometheus|OTel adapter is future work)
//   // Note: runs_completed_total + audit_dropped_appends are recorded at the audit seal, so they
//   // require an AuditLog; the dispatch + queue/retry/deadline metrics do not.
```

- [ ] **Step 8: Run the orchestrator suite + build core**

Run: `pnpm --filter @quarry-systems/pangolin-core build && pnpm --filter @quarry-systems/pangolin-orchestrator test`
Expected: PASS (existing 698+ tests plus the new metrics ones).

- [ ] **Step 9: Commit**

```bash
git add packages/pangolin-orchestrator/src/orchestrator.ts packages/pangolin-orchestrator/src/engine/tick.ts packages/pangolin-orchestrator/test/tick.test.ts docs-site/src/content/docs/reference/config.md
git commit -m "feat(metrics): orchestrator engine instrumentation + wiring docs"
```

---

### Final verification (before declaring done)

- [ ] `pnpm --filter @quarry-systems/pangolin-core build` (so client/orchestrator see the metrics exports).
- [ ] `pnpm -r typecheck` — exit 0.
- [ ] `pnpm -r lint` — exit 0.
- [ ] `pnpm --filter @quarry-systems/pangolin-orchestrator test` — green (engine touched).
- [ ] `pnpm test:e2e` — green (the dispatch/engine path is exercised end-to-end).
- [ ] `pnpm --filter docs-site build` — links valid (config.md changed).
- [ ] Sanity: `grep -rn "recordMetric" packages/*/src` shows every metric call routes through the guard (tick.ts, orchestrator.ts, bundled-impls.ts MetricsTelemetryHook) — no raw `.counter(`/`.gauge(`/`.histogram(` outside `recordMetric`/`InMemoryMetricsRecorder`/`NoopMetricsRecorder`.
