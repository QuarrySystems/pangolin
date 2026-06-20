# Telemetry Lifecycle Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dispatch-level `TelemetryHook` seam real — emit all six `LifecycleEvent`s from the client dispatch path, ship a `StdoutTelemetryHook` reference consumer, and guard emission so a buggy hook can never break a dispatch.

**Architecture:** All emission happens at the transitions the client already owns (`pangolin-client/src/dispatch.ts` + `cancel.ts`) — a single DRY site, no per-provider work (Approach A from the spec). Every emit goes through one guarded helper. A reference `StdoutTelemetryHook` (opt-in; default stays `Noop`) makes the seam demonstrably usable. Block-level worker events are out of scope.

**Tech Stack:** TypeScript, Vitest, the existing `@quarry-systems/pangolin-core` `TelemetryHook`/`LifecycleEvent` types, the `pangolin-client` dispatch path.

**Spec:** `docs/superpowers/specs/2026-06-19-telemetry-lifecycle-seam-end-to-end-design.md`

## Global Constraints

- **TDD**: write the failing test first, watch it fail, implement minimal, watch it pass, commit. Every task.
- **DRY / SRP / SoC**: one emission helper, one emission site; the client owns the *lifecycle*, providers own the *mechanism* (do not add emission to providers).
- **Repo patterns**: operator logs use the `[pangolin …]` prefix; loud-by-default surfacing with opt-out (mirrors `AuditLog.onDrop`); reference impls live in `bundled-impls.ts` as siblings of `NoopTelemetryHook`.
- **Failure-vs-exitCode contract (do not violate)**: a non-zero *app* exit is `dispatch.finished` (with its `exitCode`); only a provider/infra failure (`result.failure`, derived from `providerFailureReason`) is `dispatch.failed`.
- **Per-task gate**: `pnpm --filter @quarry-systems/pangolin-client test`. **Before declaring the whole plan done**: `pnpm -r typecheck` + `pnpm -r lint` (no `pnpm -r build` needed — no `pangolin-core` runtime/type change, only doc comments).
- **Default consumer stays `NoopTelemetryHook`.** `StdoutTelemetryHook` is opt-in.

## File Structure

- **Create** `packages/pangolin-client/src/lifecycle-emit.ts` — the single guarded `emitLifecycleEvent` helper.
- **Create** `packages/pangolin-client/test/lifecycle-emit.test.ts` — unit tests for the helper + `StdoutTelemetryHook`.
- **Modify** `packages/pangolin-client/src/bundled-impls.ts` — add `StdoutTelemetryHook` (sibling of `NoopTelemetryHook`).
- **Modify** `packages/pangolin-client/src/index.ts` — export `StdoutTelemetryHook`.
- **Modify** `packages/pangolin-client/src/dispatch.ts` — emit `accepted` (relocated), `started`, `finished`/`failed`/`needs_input`, and `failed`-on-rejection.
- **Modify** `packages/pangolin-client/src/cancel.ts` — emit `cancelled`.
- **Modify** `packages/pangolin-client/test/dispatch.test.ts` — lifecycle emission tests (reuses the file's existing `makeMemoryStorage`/`makeCompute` harness).
- **Modify** `packages/pangolin-core/src/telemetry.ts` and `lifecycle.ts` — doc comments (emission is now real; guarded-emit contract).
- **Modify** `docs-site/src/content/docs/reference/config.md` — document the `StdoutTelemetryHook` opt-in.
- **Modify** `docs-site/src/content/docs/explanation/` — a short "dispatch lifecycle events" note (folded into Task 4).

---

### Task 1: Guarded emit helper + `StdoutTelemetryHook`

**Files:**
- Create: `packages/pangolin-client/src/lifecycle-emit.ts`
- Create: `packages/pangolin-client/test/lifecycle-emit.test.ts`
- Modify: `packages/pangolin-client/src/bundled-impls.ts` (add `StdoutTelemetryHook` after `NoopTelemetryHook`, ~line 191)
- Modify: `packages/pangolin-client/src/index.ts` (add `StdoutTelemetryHook` to the existing telemetry export, near `NoopTelemetryHook` at line 99)
- Modify: `packages/pangolin-core/src/telemetry.ts` (doc comment)
- Modify: `docs-site/src/content/docs/reference/config.md`

**Interfaces:**
- Produces: `emitLifecycleEvent(telemetry: TelemetryHook | undefined, event: LifecycleEvent): void` (exported from `lifecycle-emit.ts`); `class StdoutTelemetryHook implements TelemetryHook { readonly name = 'stdout'; emit(event: LifecycleEvent): void }`.

- [ ] **Step 1: Write the failing test** — `packages/pangolin-client/test/lifecycle-emit.test.ts`

```typescript
import { it, expect, vi } from 'vitest';
import { emitLifecycleEvent } from '../src/lifecycle-emit.js';
import { StdoutTelemetryHook } from '../src/bundled-impls.js';
import type { LifecycleEvent, TelemetryHook } from '@quarry-systems/pangolin-core';

const sample: LifecycleEvent = {
  kind: 'dispatch.accepted',
  dispatchId: 'd1',
  target: 't',
  resolved: [],
  at: '2026-01-01T00:00:00.000Z',
};

it('emitLifecycleEvent forwards the event to the hook', () => {
  const seen: LifecycleEvent[] = [];
  const hook: TelemetryHook = { name: 'rec', emit: (e) => seen.push(e) };
  emitLifecycleEvent(hook, sample);
  expect(seen).toEqual([sample]);
});

it('emitLifecycleEvent is a no-op when telemetry is undefined', () => {
  expect(() => emitLifecycleEvent(undefined, sample)).not.toThrow();
});

it('emitLifecycleEvent swallows a throwing hook and logs loudly (never breaks the path)', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const hook: TelemetryHook = {
      name: 'boom',
      emit: () => {
        throw new Error('hook down');
      },
    };
    expect(() => emitLifecycleEvent(hook, sample)).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
    const msg = String(spy.mock.calls[0]![0]);
    expect(msg).toContain('boom'); // the hook name
    expect(msg).toContain('dispatch.accepted'); // the event kind
  } finally {
    spy.mockRestore();
  }
});

it('StdoutTelemetryHook prints one JSON line per event', () => {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    new StdoutTelemetryHook().emit(sample);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(spy.mock.calls[0]![0]))).toEqual(sample);
  } finally {
    spy.mockRestore();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @quarry-systems/pangolin-client exec vitest run test/lifecycle-emit.test.ts`
Expected: FAIL — `emitLifecycleEvent` / `StdoutTelemetryHook` do not exist yet (import/resolution error).

- [ ] **Step 3: Create the guarded helper** — `packages/pangolin-client/src/lifecycle-emit.ts`

```typescript
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
```

- [ ] **Step 4: Add `StdoutTelemetryHook`** — `packages/pangolin-client/src/bundled-impls.ts`, immediately after the `NoopTelemetryHook` class (~line 191)

```typescript
/**
 * Reference `TelemetryHook` that prints each dispatch `LifecycleEvent` as one structured JSON line
 * to stdout. OPT-IN — the default stays `NoopTelemetryHook`; wire this via the client's `telemetry`
 * option when you want a live event stream (demos, local runs, piping into a log collector).
 */
export class StdoutTelemetryHook implements TelemetryHook {
  readonly name = 'stdout';

  emit(event: LifecycleEvent): void {
    console.log(JSON.stringify(event));
  }
}
```

(The `TelemetryHook` and `LifecycleEvent` types are already imported in `bundled-impls.ts` for `NoopTelemetryHook` — no new import needed. If lint reports them unused before this step, that is expected and resolves here.)

- [ ] **Step 5: Export `StdoutTelemetryHook`** — `packages/pangolin-client/src/index.ts`, beside the existing `NoopTelemetryHook` export (line 99)

Change the existing export line so both are exported, e.g.:

```typescript
  NoopTelemetryHook,
  StdoutTelemetryHook,
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @quarry-systems/pangolin-client exec vitest run test/lifecycle-emit.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Update the `telemetry.ts` doc comment** — `packages/pangolin-core/src/telemetry.ts`

Replace the paragraph that currently says errors in `emit` are the implementation's responsibility and *"the runtime does not catch them"* with:

```typescript
// Implementations are expected to be cheap and non-throwing. As a safety net the
// runtime routes every emit through a guarded helper (pangolin-client
// `emitLifecycleEvent`) that catches and loudly logs a throwing hook rather than
// letting it break the dispatch path.
```

- [ ] **Step 8: Document the opt-in** — `docs-site/src/content/docs/reference/config.md`

In the audit/orchestrator setup example (near the `AuditLog`/orchestrator construction, ~line 131), add a commented line showing the opt-in, e.g. after the client is constructed:

```javascript
// Live dispatch lifecycle events (opt-in; default drops them). Prints one JSON
// line per accepted/started/finished/needs_input/failed/cancelled event.
// import { StdoutTelemetryHook } from '@quarry-systems/pangolin-client';
// const client = new PangolinClient({ /* …, */ telemetry: new StdoutTelemetryHook() });
```

- [ ] **Step 9: Commit**

```bash
git add packages/pangolin-client/src/lifecycle-emit.ts packages/pangolin-client/test/lifecycle-emit.test.ts packages/pangolin-client/src/bundled-impls.ts packages/pangolin-client/src/index.ts packages/pangolin-core/src/telemetry.ts docs-site/src/content/docs/reference/config.md
git commit -m "feat(telemetry): guarded emit helper + StdoutTelemetryHook reference consumer"
```

---

### Task 2: Emit `accepted` (relocated) + `started` in `fireWork`

**Files:**
- Modify: `packages/pangolin-client/src/dispatch.ts` (the `fireWork` run section, ~lines 299-312)
- Modify: `packages/pangolin-client/test/dispatch.test.ts` (add emission tests; reuse `makeMemoryStorage`/`makeCompute`)
- Modify: `packages/pangolin-core/src/lifecycle.ts` (doc comment)

**Interfaces:**
- Consumes: `emitLifecycleEvent` (Task 1).
- Produces: on `fireWork`, the telemetry hook receives `dispatch.accepted` (before `compute.run`) then `dispatch.started` (after, carrying `handle.providerTaskId`).

- [ ] **Step 1: Write the failing test** — append to `packages/pangolin-client/test/dispatch.test.ts`

Build a client WITH a recording telemetry hook (mirror the file's existing client construction — `makeMemoryStorage()` + `storage.seed('s','subagent','ns','sha256:s',{name:'s'})`, `makeCompute()`, a credentials provider, `targets: { prod: { compute: 'default', credentials: 'default' } }`), then drive `fireWork`:

```typescript
it('fireWork emits dispatch.accepted (before run) then dispatch.started (with providerTaskId)', async () => {
  const storage = makeMemoryStorage();
  storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
  const { compute } = makeCompute();
  const events: LifecycleEvent[] = [];
  const telemetry: TelemetryHook = { name: 'rec', emit: (e) => events.push(e) };
  const client = new PangolinClient({
    namespace: 'ns',
    compute: { default: compute },
    credentials: { default: { name: 'c', resolve: async () => ({ kind: 'static', token: 't' }) } },
    storage,
    targets: { prod: { compute: 'default', credentials: 'default' } },
    telemetry,
  });

  await fireWork(
    client,
    { subagent: 's', target: 'prod', workerImage: 'img', input: {} },
    { defaultDispatchTimeoutSeconds: 60 },
  );

  expect(events.map((e) => e.kind)).toEqual(['dispatch.accepted', 'dispatch.started']);
  const started = events[1] as Extract<LifecycleEvent, { kind: 'dispatch.started' }>;
  expect(started.providerTaskId).toBe('prov-1');
});
```

(If `fireWork`'s `opts` shape differs, copy the exact `ClientDispatchOpts` the file's existing `fireWork`/`dispatchWork` tests pass. `makeCompute().run` returns `providerTaskId: 'prov-1'` for the first run.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @quarry-systems/pangolin-client exec vitest run test/dispatch.test.ts -t "before run"`
Expected: FAIL — only `dispatch.accepted` is emitted today (no `started`), and `accepted` currently fires *after* `run`, so the order/contents differ.

- [ ] **Step 3: Implement emission** — `packages/pangolin-client/src/dispatch.ts`

Add the import at the top: `import { emitLifecycleEvent } from './lifecycle-emit.js';`

Then replace the current run block (the `const handle = await compute.run(...)` line, the `const startTime = Date.now();` line, and the existing `client.telemetry?.emit({ kind: 'dispatch.accepted', … })` block at ~lines 300-312) with:

```typescript
  // 8. Run (fire). Emit `accepted` (refs resolved, container not yet started) BEFORE run,
  //    then `started` once the provider returns a handle.
  emitLifecycleEvent(client.telemetry, {
    kind: 'dispatch.accepted',
    dispatchId,
    target: work.target,
    resolved: resolvedCapabilities,
    at: new Date().toISOString(),
  });
  const handle = await compute.run(taskSpec, { credentials, telemetry: client.telemetry });
  const startTime = Date.now();
  emitLifecycleEvent(client.telemetry, {
    kind: 'dispatch.started',
    dispatchId,
    providerTaskId: handle.providerTaskId,
    at: new Date().toISOString(),
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @quarry-systems/pangolin-client exec vitest run test/dispatch.test.ts -t "before run"`
Expected: PASS.

- [ ] **Step 5: Update the `lifecycle.ts` doc comment** — `packages/pangolin-core/src/lifecycle.ts`

In the header comment, change the line implying events are aspirational to state they are emitted by the client dispatch path, e.g. append to the intro:

```typescript
// These events are emitted by the client dispatch path (pangolin-client
// `dispatch.ts` / `cancel.ts`) at each transition, through the guarded
// `emitLifecycleEvent` helper.
```

- [ ] **Step 6: Run the full client suite to confirm no regression**

Run: `pnpm --filter @quarry-systems/pangolin-client test`
Expected: PASS (all existing tests + the new one).

- [ ] **Step 7: Commit**

```bash
git add packages/pangolin-client/src/dispatch.ts packages/pangolin-client/test/dispatch.test.ts packages/pangolin-core/src/lifecycle.ts
git commit -m "feat(telemetry): emit accepted (relocated) + started from fireWork"
```

---

### Task 3: Emit `finished` / `failed` / `needs_input` in `reconcile` + `failed`-on-rejection in `awaitExit`

**Files:**
- Modify: `packages/pangolin-client/src/dispatch.ts` (the `awaitExit` closure ~lines 317-318 and the `reconcile` closure ~lines 320-357)
- Modify: `packages/pangolin-client/test/dispatch.test.ts`

**Interfaces:**
- Consumes: `emitLifecycleEvent` (Task 1).
- Produces: after `reconcile(exit)`, the hook receives exactly one terminal — `dispatch.finished` (clean exit, including non-zero app exit), `dispatch.failed` (when `result.failure` is set), or `dispatch.needs_input` (when `result.needsInput` is set). A rejected `awaitExit()` emits `dispatch.failed` and rethrows.

- [ ] **Step 1: Write the failing tests** — append to `packages/pangolin-client/test/dispatch.test.ts`

Use a fake `ResultSink` to drive the `failure` / `needsInput` branches (the default minimal result sets neither). Build the client with `resultSink` for those two cases; for `finished` no sink is needed.

```typescript
it('reconcile emits dispatch.finished on a clean exit (incl. a non-zero app exit)', async () => {
  const storage = makeMemoryStorage();
  storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
  const { compute } = makeCompute({ exit: { exitCode: 3 } }); // non-zero APP exit, no failure block
  const events: LifecycleEvent[] = [];
  const client = new PangolinClient({
    namespace: 'ns',
    compute: { default: compute },
    credentials: { default: { name: 'c', resolve: async () => ({ kind: 'static', token: 't' }) } },
    storage,
    targets: { prod: { compute: 'default', credentials: 'default' } },
    telemetry: { name: 'rec', emit: (e) => events.push(e) },
  });
  const flight = await fireWork(client, { subagent: 's', target: 'prod', workerImage: 'img', input: {} }, { defaultDispatchTimeoutSeconds: 60 });
  await flight.reconcile(await flight.awaitExit());
  const terminal = events.find((e) => ['dispatch.finished', 'dispatch.failed', 'dispatch.needs_input'].includes(e.kind))!;
  expect(terminal.kind).toBe('dispatch.finished');
  expect((terminal as Extract<LifecycleEvent, { kind: 'dispatch.finished' }>).exitCode).toBe(3);
});

it('reconcile emits dispatch.failed when the result carries an infra failure', async () => {
  const storage = makeMemoryStorage();
  storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
  const { compute } = makeCompute();
  const failingSink: ResultSink = {
    name: 'fake',
    async collect(_handle, exit, ctx): Promise<DispatchResult> {
      return {
        dispatchId: ctx.dispatchId,
        exitCode: exit.exitCode,
        stdout: '',
        stderr: '',
        durationMs: 0,
        resolved: ctx.resolved,
        failure: { reason: 'timeout', detail: 'provider timed out' },
      };
    },
  };
  const events: LifecycleEvent[] = [];
  const client = new PangolinClient({
    namespace: 'ns',
    compute: { default: compute },
    credentials: { default: { name: 'c', resolve: async () => ({ kind: 'static', token: 't' }) } },
    storage,
    targets: { prod: { compute: 'default', credentials: 'default' } },
    resultSink: failingSink,
    telemetry: { name: 'rec', emit: (e) => events.push(e) },
  });
  const flight = await fireWork(client, { subagent: 's', target: 'prod', workerImage: 'img', input: {} }, { defaultDispatchTimeoutSeconds: 60 });
  await flight.reconcile(await flight.awaitExit());
  expect(events.some((e) => e.kind === 'dispatch.failed')).toBe(true);
  expect(events.some((e) => e.kind === 'dispatch.finished')).toBe(false);
});

it('awaitExit emits dispatch.failed and rethrows when the provider rejects', async () => {
  const storage = makeMemoryStorage();
  storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
  const compute: ComputeProvider = {
    name: 'rejecting',
    async run() {
      return { providerTaskId: 'prov-x' };
    },
    async awaitExit(): Promise<TaskExit> {
      throw new Error('provider exploded');
    },
  };
  const events: LifecycleEvent[] = [];
  const client = new PangolinClient({
    namespace: 'ns',
    compute: { default: compute },
    credentials: { default: { name: 'c', resolve: async () => ({ kind: 'static', token: 't' }) } },
    storage,
    targets: { prod: { compute: 'default', credentials: 'default' } },
    telemetry: { name: 'rec', emit: (e) => events.push(e) },
  });
  const flight = await fireWork(client, { subagent: 's', target: 'prod', workerImage: 'img', input: {} }, { defaultDispatchTimeoutSeconds: 60 });
  await expect(flight.awaitExit()).rejects.toThrow('provider exploded');
  expect(events.some((e) => e.kind === 'dispatch.failed')).toBe(true);
});
```

(Add a `needs_input` test mirroring the `failed` one with a sink returning `needsInput: { question: 'q' }` instead of `failure`, asserting a `dispatch.needs_input` event and no `dispatch.finished`. Confirm the exact `needsInput` shape from `DispatchResult` in `pangolin-core`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @quarry-systems/pangolin-client exec vitest run test/dispatch.test.ts -t "dispatch.finished" -t "infra failure" -t "rethrows"`
Expected: FAIL — no terminal/failed events are emitted from `reconcile`/`awaitExit` yet.

- [ ] **Step 3: Implement the `awaitExit` wrapper** — `packages/pangolin-client/src/dispatch.ts`

Replace the `awaitExit` closure (lines 317-318) with:

```typescript
  const awaitExit = async (): Promise<TaskExit> => {
    try {
      return await compute.awaitExit(handle, { credentials, telemetry: client.telemetry });
    } catch (err) {
      // Infra rejection: the orchestrator path never calls our reconcile here, so this is the
      // only place `failed` can be emitted for a hard provider throw.
      emitLifecycleEvent(client.telemetry, {
        kind: 'dispatch.failed',
        dispatchId,
        reason: err instanceof Error ? err.message : String(err),
        at: new Date().toISOString(),
      });
      throw err;
    }
  };
```

- [ ] **Step 4: Implement terminal emission in `reconcile`** — `packages/pangolin-client/src/dispatch.ts`

In the `reconcile` closure, after the `result` is built and the dispatch record is written, just before `return result;` (line 356), add:

```typescript
    // Terminal lifecycle event. Honors the failure-vs-exitCode contract: a non-zero APP exit is
    // `finished` (with its code); only a provider/infra `failure` is `failed`.
    const at = new Date().toISOString();
    if (result.failure) {
      emitLifecycleEvent(client.telemetry, {
        kind: 'dispatch.failed',
        dispatchId,
        reason: result.failure.detail ?? result.failure.reason,
        at,
      });
    } else if (result.needsInput) {
      emitLifecycleEvent(client.telemetry, {
        kind: 'dispatch.needs_input',
        dispatchId,
        durationMs,
        at,
      });
    } else {
      emitLifecycleEvent(client.telemetry, {
        kind: 'dispatch.finished',
        dispatchId,
        exitCode: result.exitCode,
        durationMs,
        at,
      });
    }
```

(Confirm `result.failure`'s field names — `reason`/`detail` — against `DispatchResult` in `pangolin-core`; adjust the `reason:` source if they differ. `result.needsInput` is set by the result sink's sentinel scan.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @quarry-systems/pangolin-client exec vitest run test/dispatch.test.ts`
Expected: PASS (all tests, including the four new terminal/rejection ones).

- [ ] **Step 6: Commit**

```bash
git add packages/pangolin-client/src/dispatch.ts packages/pangolin-client/test/dispatch.test.ts
git commit -m "feat(telemetry): emit finished/failed/needs_input + failed-on-rejection"
```

---

### Task 4: Emit `cancelled` in `cancelDispatch` + lifecycle docs

**Files:**
- Modify: `packages/pangolin-client/src/cancel.ts`
- Modify: `packages/pangolin-client/test/dispatch.test.ts` (or `cancel.test.ts` if one exists — put the test beside the other cancel tests)
- Modify: `docs-site/src/content/docs/explanation/` (short lifecycle-events note)

**Interfaces:**
- Consumes: `emitLifecycleEvent` (Task 1).
- Produces: `cancelDispatch(client, dispatchId)` emits `dispatch.cancelled` for that `dispatchId` when cancellation is requested (at function entry — intent, independent of whether a provider reap occurs).

- [ ] **Step 1: Write the failing test** — add to the cancel tests in `packages/pangolin-client/test/`

```typescript
it('cancelDispatch emits dispatch.cancelled (intent) even when there is no provider to reap', async () => {
  const storage = makeMemoryStorage();
  const events: LifecycleEvent[] = [];
  const client = new PangolinClient({
    namespace: 'ns',
    compute: {},
    credentials: {},
    storage,
    targets: {},
    telemetry: { name: 'rec', emit: (e) => events.push(e) },
  });
  await cancelDispatch(client, 'd-123'); // unknown id → no-op reap, but intent is observable
  expect(events).toEqual([
    { kind: 'dispatch.cancelled', dispatchId: 'd-123', at: expect.any(String) },
  ]);
});
```

(Import `cancelDispatch` from `../src/cancel.js`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @quarry-systems/pangolin-client exec vitest run -t "emits dispatch.cancelled"`
Expected: FAIL — no `cancelled` event is emitted.

- [ ] **Step 3: Implement emission** — `packages/pangolin-client/src/cancel.ts`

Add the import: `import { emitLifecycleEvent } from './lifecycle-emit.js';`

At the **start** of `cancelDispatch` (before the `readDispatchRecord` early-returns), emit the intent:

```typescript
  // `cancelled` reflects the cancel REQUEST (intent), so emit it unconditionally up front — before
  // the best-effort, possibly-no-op provider reap below. Per the spec's decision (i), the eventual
  // real terminal (finished/failed) may still fire later when the killed task settles.
  emitLifecycleEvent(client.telemetry, {
    kind: 'dispatch.cancelled',
    dispatchId,
    at: new Date().toISOString(),
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @quarry-systems/pangolin-client exec vitest run -t "emits dispatch.cancelled"`
Expected: PASS.

- [ ] **Step 5: Add a lifecycle-events doc note** — `docs-site/src/content/docs/explanation/`

Add a short subsection (in `architecture-overview.md` or a new small `observability.md`) listing the six dispatch lifecycle events, that they are **dispatch-level** and emitted in-process by the client, that block-level detail lives in the worker stdout + the `blocks[]` audit evidence, and that a cancelled dispatch emits `cancelled` (intent) and may be followed by its real terminal. Keep it ~150 words. If you add a new page, add it to the sidebar/nav consistent with the existing explanation pages.

- [ ] **Step 6: Run the full client suite**

Run: `pnpm --filter @quarry-systems/pangolin-client test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/pangolin-client/src/cancel.ts packages/pangolin-client/test docs-site/src/content/docs/explanation
git commit -m "feat(telemetry): emit cancelled on cancel + document the lifecycle events"
```

---

### Final verification (before declaring done)

- [ ] `pnpm --filter @quarry-systems/pangolin-client test` — green.
- [ ] `pnpm -r typecheck` — exit 0.
- [ ] `pnpm -r lint` — exit 0.
- [ ] `pnpm --filter docs-site build` — links valid (config.md + explanation note changed).
- [ ] Sanity: grep confirms emission flows through the single helper — `grep -rn "emitLifecycleEvent" packages/pangolin-client/src` shows `dispatch.ts` (accepted/started/finished/failed/needs_input + awaitExit) and `cancel.ts` (cancelled), and `client.telemetry?.emit(` no longer appears in `dispatch.ts`.
