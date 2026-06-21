# Dispatch trace correlation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry a lightweight `TraceContext { traceId, runId?, itemId? }` on every dispatch `LifecycleEvent` (and the dispatch record) so an operator can follow one logical unit of work — run → item → dispatch — on the live telemetry stream.

**Architecture:** A tiny additive `TraceContext` type in `pangolin-core` becomes an optional `trace?` on `DispatchWork` and on each of the 6 `LifecycleEvent` variants. The `pangolin-client` dispatch path resolves the trace once (defaulting `traceId = dispatchId`), attaches it to every emitted event, and stamps it into the dispatch record. The `pangolin-orchestrator` `DispatchExecutor` populates it from `runId`/`itemId` at fire time. Correlation (sub-project 3b); not OTel span export.

**Tech Stack:** TypeScript (NodeNext ESM), vitest. pnpm workspace monorepo. Zero new runtime dependencies.

## Global Constraints

- **Additive optional fields only — backward-compatible.** Existing telemetry consumers (`MetricsTelemetryHook`, `ConsoleTelemetryHook`) must keep compiling/working untouched. `DispatchResult` is **left unchanged** (the record, not the result, carries trace).
- **`traceId` is never empty.** The client always defaults `{ traceId: dispatchId }` when no `trace` is supplied; the orchestrator **omits** `trace` (rather than passing an empty `runId`) when there is no `runId`.
- **Uniform `traceId`:** orchestrated → `traceId = runId`; standalone → `traceId = dispatchId`. Plus optional `runId`/`itemId` for the orchestrated dimension. Readable ids — **no W3C hex**.
- **Cancellation:** `cancel.ts` emits `dispatch.cancelled` **unconditionally at entry** (before the record read) — do NOT reorder or gate it on the record. The cancelled event carries `{ traceId: dispatchId }`.
- **Cardinality:** trace ids live only on the telemetry/audit streams — never in metric labels (the metrics layer's bounded-cardinality rule stands).
- **Zero new dependencies.** Pure-data type; no OTel/SDK.
- **TDD throughout**, frequent commits. Tests run via `pnpm --filter <pkg> exec vitest run <file>`. The Stop-hook ESLint is stricter than `pnpm -r lint` on test files — avoid `as any` / unused bindings.
- **Build order:** after touching `pangolin-core`, run `pnpm --filter @quarry-systems/pangolin-core build` so `pangolin-client`/`pangolin-orchestrator` (which import built `dist`) resolve the new exports.

---

### Task 1: `TraceContext` type + optional `trace` on `DispatchWork` and `LifecycleEvent` (core)

**Files:**
- Create: `packages/pangolin-core/src/trace.ts`
- Create: `packages/pangolin-core/test/trace.test.ts`
- Modify: `packages/pangolin-core/src/lifecycle.ts` (add `trace?` to each of the 6 variants)
- Modify: `packages/pangolin-core/src/dispatch.ts:54-79` (add `trace?` to `DispatchWork`)
- Modify: `packages/pangolin-core/src/index.ts:11` (export `trace.js` next to `lifecycle.js`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `export interface TraceContext { traceId: string; runId?: string; itemId?: string }`; an optional `trace?: TraceContext` on `DispatchWork` and on every `LifecycleEvent` variant.

- [ ] **Step 1: Write the failing test** — `packages/pangolin-core/test/trace.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import type { TraceContext, LifecycleEvent, DispatchWork } from '../src/index.js';

describe('TraceContext', () => {
  it('carries traceId + optional runId/itemId and rides DispatchWork + LifecycleEvent', () => {
    const trace: TraceContext = { traceId: 'run-1', runId: 'run-1', itemId: 'a' };

    const work: DispatchWork = { subagent: 's', target: 't', trace };
    expect(work.trace?.traceId).toBe('run-1');
    expect(work.trace?.itemId).toBe('a');

    const started: LifecycleEvent = {
      kind: 'dispatch.started',
      dispatchId: 'd',
      providerTaskId: 'p',
      at: '2026-01-01T00:00:00.000Z',
      trace,
    };
    expect(started.trace?.runId).toBe('run-1');

    // traceId-only (standalone) shape is valid:
    const minimal: TraceContext = { traceId: 'd' };
    expect(minimal.runId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @quarry-systems/pangolin-core exec vitest run test/trace.test.ts`
Expected: FAIL — `TraceContext` is not exported (and `trace` is not assignable on `DispatchWork`/`LifecycleEvent`).

- [ ] **Step 3: Create the type** — `packages/pangolin-core/src/trace.ts`

```typescript
// Correlation identity for a dispatch — the lightweight "tracing" surface (observability 3b).
// Pure data; carried on DispatchWork and every LifecycleEvent so a consumer can follow one
// logical unit of work (run -> item -> dispatch) on the LIVE telemetry stream. Not OTel spans.
//
// `traceId` is ALWAYS populated by the producer: the orchestrator sets it to the runId; a
// standalone client.dispatch defaults it to the dispatchId (a single-dispatch trace). Readable
// ids — not W3C traceparent hex. These ids must never leak into metric labels (cardinality).

export interface TraceContext {
  /** The logical operation this dispatch belongs to. Orchestrated: the runId.
   *  Standalone client.dispatch: the dispatchId. */
  traceId: string;
  /** Set when the dispatch is part of an orchestrated run. */
  runId?: string;
  /** The run item that produced this dispatch (an item may retry -> several dispatches share itemId). */
  itemId?: string;
}
```

- [ ] **Step 4: Add `trace?` to each `LifecycleEvent` variant** — `packages/pangolin-core/src/lifecycle.ts`

At the top, add the import (below the existing `import type { CapabilityRef } from './refs.js';`):

```typescript
import type { TraceContext } from './trace.js';
```

Add `trace?: TraceContext;` as the last field of EACH of the six variants in the `LifecycleEvent` union (after `at: string;` in every case). For example the first variant becomes:

```typescript
  | {
      kind: 'dispatch.accepted';
      dispatchId: string;
      target: string;
      resolved: ResolvedRefs;
      at: string;
      trace?: TraceContext;
    }
```

Do the same (`trace?: TraceContext;` after `at`) for `dispatch.started`, `dispatch.finished`, `dispatch.needs_input`, `dispatch.failed`, and `dispatch.cancelled`.

- [ ] **Step 5: Add `trace?` to `DispatchWork`** — `packages/pangolin-core/src/dispatch.ts`

Add the import to the top of the file (group it with existing `import type` lines):

```typescript
import type { TraceContext } from './trace.js';
```

In `interface DispatchWork` (line 54), add after `dispatchId?: string;` (line 63):

```typescript
  /** Correlation context for the telemetry stream. The orchestrator sets `{ traceId: runId, runId,
   *  itemId }`; a standalone caller may omit it (the client defaults `{ traceId: dispatchId }`). */
  trace?: TraceContext;
```

- [ ] **Step 6: Export from the core barrel** — `packages/pangolin-core/src/index.ts`

Add after line 11 (`export * from './lifecycle.js';`):

```typescript
export * from './trace.js';
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --filter @quarry-systems/pangolin-core exec vitest run test/trace.test.ts`
Expected: PASS.

- [ ] **Step 8: Build core**

Run: `pnpm --filter @quarry-systems/pangolin-core build`
Expected: exits 0 (downstream packages resolve `TraceContext` from `dist`).

- [ ] **Step 9: Commit**

```bash
git add packages/pangolin-core/src/trace.ts packages/pangolin-core/test/trace.test.ts packages/pangolin-core/src/lifecycle.ts packages/pangolin-core/src/dispatch.ts packages/pangolin-core/src/index.ts
git commit -m "feat(trace): TraceContext + optional trace on DispatchWork and LifecycleEvent"
```

---

### Task 2: dispatch record carries `trace` (client retention)

**Files:**
- Modify: `packages/pangolin-client/src/retention.ts`
- Modify: `packages/pangolin-client/test/retention.test.ts`

**Interfaces:**
- Consumes: `TraceContext` (Task 1, from core).
- Produces: `DispatchRecord.trace?: TraceContext`; `writeDispatchRecord` accepts and stores an optional `trace`.

- [ ] **Step 1: Write the failing test** — append to `packages/pangolin-client/test/retention.test.ts`

```typescript
it('round-trips a trace on the dispatch record', async () => {
  const client = makeClient(); // existing helper in this test file
  await writeDispatchRecord(
    client,
    'd-trace',
    {
      dispatchId: 'd-trace',
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1,
      resolved: { subagent: { name: 's', contentHash: 'sha256:x' }, capabilities: [], env: [] },
      providerTaskId: 'p',
      target: 'local',
      trace: { traceId: 'run-9', runId: 'run-9', itemId: 'a' },
    },
    7,
  );
  const record = await readDispatchRecord(client, 'd-trace');
  expect(record?.trace).toEqual({ traceId: 'run-9', runId: 'run-9', itemId: 'a' });
});
```

> Note: reuse this test file's existing `makeClient` helper and the existing `writeDispatchRecord`/`readDispatchRecord` imports. If the resolved-subagent shape in the existing tests differs, copy theirs — the trace field is the only thing under test here.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @quarry-systems/pangolin-client exec vitest run test/retention.test.ts`
Expected: FAIL — `trace` is not accepted by `writeDispatchRecord` (type error) / not present on the read-back record.

- [ ] **Step 3: Add `trace` to the record + the writer** — `packages/pangolin-client/src/retention.ts`

Extend the core import (line 14-17) to add `TraceContext`:

```typescript
import {
  buildDispatchRecordUri,
  type DispatchResult,
  type TraceContext,
} from '@quarry-systems/pangolin-core';
```

Add `trace?` to `DispatchRecord` (after `recordedAt`):

```typescript
export interface DispatchRecord extends DispatchResult {
  providerTaskId: string;
  target: string;
  retentionDays: number;
  /** ISO 8601 timestamp at which `writeDispatchRecord` sealed the record. */
  recordedAt: string;
  /** Correlation context (observability 3b) — enables a dispatchId -> trace join after the fact. */
  trace?: TraceContext;
}
```

Widen the `writeDispatchRecord` `result` param type and thread `trace` onto the record. Replace the param type and the destructure + record build:

```typescript
export async function writeDispatchRecord(
  client: PangolinClient,
  dispatchId: string,
  result: DispatchResult & { providerTaskId?: string; target?: string; trace?: TraceContext },
  retentionDays: number,
): Promise<void> {
  if (retentionDays > client.retention.maxDays) {
    throw new Error(
      `writeDispatchRecord: retentionDays ${retentionDays} exceeds client maxDays ${client.retention.maxDays}`,
    );
  }
  const { providerTaskId, target, trace, ...rest } = result;
  const record: DispatchRecord = {
    ...(rest as DispatchResult),
    providerTaskId: providerTaskId ?? '',
    target: target ?? '',
    retentionDays,
    recordedAt: new Date().toISOString(),
    ...(trace ? { trace } : {}),
  };
  const uri = buildDispatchRecordUri(client.namespace, dispatchId, RECORD_SUFFIX);
  await client.storage.put(uri, new TextEncoder().encode(JSON.stringify(record)));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @quarry-systems/pangolin-client exec vitest run test/retention.test.ts`
Expected: PASS (the new test plus the existing retention tests — the change is additive).

- [ ] **Step 5: Commit**

```bash
git add packages/pangolin-client/src/retention.ts packages/pangolin-client/test/retention.test.ts
git commit -m "feat(trace): DispatchRecord carries optional trace"
```

---

### Task 3: thread `trace` through the client dispatch path (emits + record)

**Files:**
- Modify: `packages/pangolin-client/src/dispatch.ts`
- Modify: `packages/pangolin-client/test/dispatch.test.ts`

**Interfaces:**
- Consumes: `TraceContext` (Task 1); `writeDispatchRecord` accepting `trace` (Task 2); the existing `makeTelemetry()` helper in `dispatch.test.ts`.
- Produces: `InFlightDispatch.trace: TraceContext` (new readonly field); every `LifecycleEvent` emitted from the dispatch path carries `trace`; the dispatch record is written with `trace`.

- [ ] **Step 1: Write the failing test** — append to `packages/pangolin-client/test/dispatch.test.ts`

```typescript
it('attaches a supplied trace to every lifecycle event', async () => {
  const { telemetry, events } = makeTelemetry();
  const client = makeClient({ telemetry }); // existing helper; pass telemetry through
  const trace = { traceId: 'run-7', runId: 'run-7', itemId: 'a' };
  await dispatchWork(
    client,
    { subagent: 'rev', target: 'local', trace },
    { workerImage: 'img:1' },
  );
  // accepted + started + finished (clean exit) all carry the same trace:
  for (const e of events) expect(e.trace).toEqual(trace);
  expect(events.map((e) => e.kind)).toContain('dispatch.accepted');
  expect(events.map((e) => e.kind)).toContain('dispatch.finished');
});

it('defaults trace.traceId to the dispatchId when none is supplied', async () => {
  const { telemetry, events } = makeTelemetry();
  const client = makeClient({ telemetry });
  const result = await dispatchWork(
    client,
    { subagent: 'rev', target: 'local' },
    { workerImage: 'img:1' },
  );
  for (const e of events) {
    expect(e.trace?.traceId).toBe(result.dispatchId);
    expect(e.trace?.runId).toBeUndefined();
  }
});
```

> Note: match the existing `dispatch.test.ts` harness exactly — it uses `makeClient(...)` + a deferred/fake compute so `dispatchWork` runs to a clean exit. If `makeClient` does not already accept a `telemetry` option, pass the telemetry the same way the file's existing telemetry tests do (the `makeTelemetry()` helper at line ~143 and its existing call sites show the pattern). Reuse, don't reinvent.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @quarry-systems/pangolin-client exec vitest run test/dispatch.test.ts -t "trace"`
Expected: FAIL — events have no `trace` field yet.

- [ ] **Step 3: Resolve the trace once + add it to `InFlightDispatch`** — `packages/pangolin-client/src/dispatch.ts`

Add `TraceContext` to the core import group (lines 33-47):

```typescript
  type TraceContext,
```

Immediately after the `dispatchId` mint (line 111, `const dispatchId = work.dispatchId ?? randomUUID();`), add:

```typescript
  // Correlation context for the telemetry stream + dispatch record. A standalone dispatch (no
  // supplied trace) is a single-dispatch trace keyed by its own dispatchId.
  const trace: TraceContext = work.trace ?? { traceId: dispatchId };
```

Add `readonly trace: TraceContext;` to the `InFlightDispatch` interface (after `readonly dispatchId: string;`, line 74):

```typescript
  readonly trace: TraceContext;
```

- [ ] **Step 4: Attach `trace` at all six emit sites + the record write** — `packages/pangolin-client/src/dispatch.ts`

Add `trace,` to each `emitLifecycleEvent` payload object: the `dispatch.accepted` (line ~302), `dispatch.started` (~311), the `awaitExit`-rejection `dispatch.failed` (~327), and the three terminal emits in `reconcile` — `dispatch.failed` (~369), `dispatch.needs_input` (~376), `dispatch.finished` (~383). Each becomes, e.g.:

```typescript
  emitLifecycleEvent(client.telemetry, {
    kind: 'dispatch.accepted',
    dispatchId,
    target: work.target,
    resolved: resolvedCapabilities,
    at: new Date().toISOString(),
    trace,
  });
```

(Do the equivalent — append `trace,` — to the other five emit payloads.)

In `reconcile`, thread `trace` into the record write (line ~393-398):

```typescript
    await writeDispatchRecord(
      client,
      dispatchId,
      { ...result, providerTaskId: handle.providerTaskId, target: work.target, trace },
      work.retentionDays ?? client.retention.defaultDays,
    );
```

Add `trace` to the returned `InFlightDispatch` object (the `return { dispatchId, handle, ... }` at line ~414):

```typescript
  return {
    dispatchId,
    trace,
    handle,
    resolved: {
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @quarry-systems/pangolin-client exec vitest run test/dispatch.test.ts`
Expected: PASS (the two new trace tests plus the full existing dispatch suite — the change is additive).

- [ ] **Step 6: Commit**

```bash
git add packages/pangolin-client/src/dispatch.ts packages/pangolin-client/test/dispatch.test.ts
git commit -m "feat(trace): carry trace on every dispatch lifecycle event + the record"
```

---

### Task 4: cancelled event carries `trace` (client cancel)

**Files:**
- Modify: `packages/pangolin-client/src/cancel.ts`
- Modify: `packages/pangolin-client/test/cancel.test.ts`

**Interfaces:**
- Consumes: nothing new (uses the in-scope `dispatchId`).
- Produces: the `dispatch.cancelled` event carries `{ traceId: dispatchId }`.

- [ ] **Step 1: Update the failing test** — `packages/pangolin-client/test/cancel.test.ts`

Find the existing assertion on the emitted `dispatch.cancelled` event (the test "emits dispatch.cancelled … even when there is no provider to reap", which asserts the event via `toEqual`). Add the `trace` field to its expected object. The expected cancelled event becomes:

```typescript
  expect(events[0]).toEqual({
    kind: 'dispatch.cancelled',
    dispatchId: 'd-123',
    at: expect.any(String),
    trace: { traceId: 'd-123' },
  });
```

> Match the existing assertion's exact shape (it may use `expect.any(String)` for `at` or a fixed value) — change only by adding the `trace` line. If the test currently asserts the event with a looser matcher, instead add an explicit `expect(events[0].trace).toEqual({ traceId: 'd-123' })`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @quarry-systems/pangolin-client exec vitest run test/cancel.test.ts`
Expected: FAIL — the emitted cancelled event has no `trace` field.

- [ ] **Step 3: Add `trace` to the cancelled emit** — `packages/pangolin-client/src/cancel.ts`

In the unconditional up-front emit (lines 26-30), add `trace`:

```typescript
  emitLifecycleEvent(client.telemetry, {
    kind: 'dispatch.cancelled',
    dispatchId,
    at: new Date().toISOString(),
    trace: { traceId: dispatchId },
  });
```

Do NOT move this emit or gate it on the record read — the unconditional-at-entry ordering is the contract (the cancelled event reflects intent). The orchestrator-side `runId`/`itemId` for a cancelled dispatch remains recoverable from the dispatch record's stamped `trace` (Task 3).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @quarry-systems/pangolin-client exec vitest run test/cancel.test.ts`
Expected: PASS (the updated assertion plus the rest of the cancel suite).

- [ ] **Step 5: Commit**

```bash
git add packages/pangolin-client/src/cancel.ts packages/pangolin-client/test/cancel.test.ts
git commit -m "feat(trace): cancelled event carries { traceId: dispatchId }"
```

---

### Task 5: orchestrator populates `trace` from run/item (engine)

**Files:**
- Modify: `packages/pangolin-orchestrator/src/executors/dispatch.ts:91-101`
- Modify: `packages/pangolin-orchestrator/test/executors/dispatch.test.ts`

**Interfaces:**
- Consumes: `DispatchWork.trace?` (Task 1) on the `client.dispatch.fire` input.
- Produces: dispatches fired through `DispatchExecutor` carry `{ traceId: runId, runId, itemId }` on their lifecycle events when a `runId` is present; otherwise the client default (`traceId = dispatchId`) applies.

- [ ] **Step 1: Write the failing test** — append to `packages/pangolin-orchestrator/test/executors/dispatch.test.ts`

Assert **delegation** — that the executor passes the right `trace` into `client.dispatch.fire`. This is the executor's actual responsibility (SRP); the client putting `trace` onto the emitted events is tested in `pangolin-client` (Task 3), and a fake `client.dispatch.fire` does not faithfully re-run that emit path. Spy on the fire input:

```typescript
it('passes trace { traceId: runId, runId, itemId } into client.dispatch.fire when a runId is present', async () => {
  const fire = vi.fn().mockResolvedValue({
    dispatchId: 'd-1',
    trace: { traceId: 'run-3' },
    resolved: { subagent: { name: 's', contentHash: 'sha256:x' }, capabilities: [], env: [], secretRefs: {}, workerImage: 'img:1', inputRefs: {} },
    awaitExit: () => new Promise(() => {}), // never settles; we only assert the fire arg
    reconcile: async () => ({}),
    cleanup: () => {},
  });
  const client = makeFakeClient({ fire }); // reuse this file's client builder; inject the fire spy
  const exec = new DispatchExecutor({ client, target: 'local', workerImage: 'img:1' });
  await exec.fire(
    { id: 'item-a', executor: 'dispatch', inputs: { subagent: 's' }, depends_on: [], resourceLocks: [] },
    { runId: 'run-3', actor: 'human:t' },
  );
  expect(fire).toHaveBeenCalledWith(
    expect.objectContaining({ trace: { traceId: 'run-3', runId: 'run-3', itemId: 'item-a' } }),
  );
});

it('omits trace entirely when there is no runId (client then defaults traceId = dispatchId)', async () => {
  const fire = vi.fn().mockResolvedValue({
    dispatchId: 'd-2',
    trace: { traceId: 'd-2' },
    resolved: { subagent: { name: 's', contentHash: 'sha256:x' }, capabilities: [], env: [], secretRefs: {}, workerImage: 'img:1', inputRefs: {} },
    awaitExit: () => new Promise(() => {}),
    reconcile: async () => ({}),
    cleanup: () => {},
  });
  const client = makeFakeClient({ fire });
  const exec = new DispatchExecutor({ client, target: 'local', workerImage: 'img:1' });
  await exec.fire(
    { id: 'item-b', executor: 'dispatch', inputs: { subagent: 's' }, depends_on: [], resourceLocks: [] },
    undefined, // no ctx -> no runId
  );
  const arg = fire.mock.calls[0]![0] as { trace?: unknown };
  expect(arg.trace).toBeUndefined();
});
```

> Note: match this test file's EXISTING client/fire-spy harness exactly — it already constructs a fake `client` whose `dispatch.fire` is observable (the suite tests manifest-building, model resolution, etc., all of which spy/stub `fire`). Reuse that `makeFakeClient`/stub shape and its `WorkItem`/`FireContext` fixtures rather than the illustrative literals above; the contract under test is the two `toHaveBeenCalledWith`/`toBeUndefined` assertions on the `trace` argument. The mocked `fire` resolve value must include the fields `DispatchExecutor.fire` reads afterward (`dispatchId`, `resolved.{subagent,capabilities,env,secretRefs,workerImage,pipelineRef?}`, `awaitExit`, `reconcile`) so the manifest-build block doesn't throw — copy the suite's existing successful-fire stub.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @quarry-systems/pangolin-orchestrator exec vitest run test/executors/dispatch.test.ts -t "trace"`
Expected: FAIL — the executor passes no `trace` today.

- [ ] **Step 3: Populate `trace` in `DispatchExecutor.fire`** — `packages/pangolin-orchestrator/src/executors/dispatch.ts`

In the `this.opts.client.dispatch.fire({ ... })` call (lines 91-101), add a conditional-spread `trace` (matching the file's existing `...(cond ? {…} : {})` idiom used for `model`/`inputRefs`/`pipelineRef`):

```typescript
    const flight = await this.opts.client.dispatch.fire({
      subagent,
      env: item.inputs.env as string | string[] | undefined,
      input: (item.inputs.workerInput as Record<string, unknown> | undefined) ?? {},
      target: this.opts.target,
      workerImage: this.opts.workerImage,
      secrets: this.opts.secrets,
      ...(requestedModel !== undefined ? { model: requestedModel } : {}),
      ...(inputRefs && Object.keys(inputRefs).length ? { inputRefs } : {}),
      ...(pipelineRef !== undefined ? { pipelineRef } : {}),
      ...(ctx?.runId ? { trace: { traceId: ctx.runId, runId: ctx.runId, itemId: item.id } } : {}),
    });
```

When `ctx?.runId` is absent, `trace` is omitted entirely and the client defaults `{ traceId: dispatchId }` — never an empty `traceId`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @quarry-systems/pangolin-orchestrator exec vitest run test/executors/dispatch.test.ts`
Expected: PASS (the two new trace tests plus the existing executor suite).

- [ ] **Step 5: Commit**

```bash
git add packages/pangolin-orchestrator/src/executors/dispatch.ts packages/pangolin-orchestrator/test/executors/dispatch.test.ts
git commit -m "feat(trace): orchestrator populates trace from runId/itemId at fire time"
```

---

## Final verification (after all tasks)

- [ ] `pnpm --filter @quarry-systems/pangolin-core build` — exits 0 (new core export compiled).
- [ ] `pnpm -r typecheck` — exits 0 (additive optional fields don't break any consumer or full-literal construction site; the worker entrypoint's `LifecycleEvent` literals omit `trace`, which stays valid).
- [ ] `pnpm -r lint` — exits 0.
- [ ] `pnpm --filter @quarry-systems/pangolin-core test` — green (trace + existing).
- [ ] `pnpm --filter @quarry-systems/pangolin-client test` — green (retention + dispatch + cancel + existing).
- [ ] `pnpm --filter @quarry-systems/pangolin-orchestrator test` — green (executor trace + existing).
- [ ] `pnpm test:e2e` — green (the dispatch/telemetry path is exercised end-to-end; trace is additive).
- [ ] Sanity: `grep -rn "traceId" packages/*/src` shows trace flowing from `DispatchWork`/orchestrator → events → record, and **never** appears in a metric-label position (no `counter(`/`gauge(`/`histogram(` call references `trace`/`traceId`).
