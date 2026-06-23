# Per-provider liveness deadline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee every blocking dispatch wait (provider `awaitExit`, worker-internal `claude`/plugin spawns) settles in bounded wall-clock time, enforced at the `ComputeProvider` seam rather than per provider.

**Architecture:** One deadline concept sourced top-down (derive from the orchestrator's `maxRuntimeMs`, default floor `7200s` for the standalone path). A shared `boundedAwaitExit` wrapper at the single client chokepoint races `provider.awaitExit` against the deadline, aborts an `AbortSignal` on `ProviderContext`, best-effort reaps via the existing `cancel`, and returns a `providerFailureReason:'timeout'` exit. Worker-internal spawns reuse the worker's `bounded-command` helper (extracted to `pangolin-core`) with timeout + POSIX process-group kill.

**Tech Stack:** TypeScript (NodeNext ESM), Node `child_process`, `AbortController`/`AbortSignal`, vitest, pnpm workspaces, AWS SDK v3 (`@aws-sdk/client-ecs`) in the Fargate provider.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-22-per-provider-liveness-deadline-design.md` — every task implements part of it.
- **Dependency allowlist:** no `pangolin-*` package may import another Quarry Systems library (`@quarry-systems/bedrock-*`, `@stoa-mcp/*`, `@rastate/*`, `@quarry-systems/drift-*`). Enforced by `scripts/check-dep-allowlist.mjs`. New imports must be `node:*`, an already-declared `@quarry-systems/pangolin-*` workspace dep, or an already-declared third-party dep.
- **`pangolin-core` has zero runtime deps** — the extracted `bounded-command` may import only `node:*`.
- **Liveness floor:** `defaultDispatchTimeoutSeconds = 7200` (s). Worker children default: agent `3600`s, plugin-install `300`s. All operator-overridable via `PANGOLIN_*_TIMEOUT_SECONDS`.
- **Failure semantics:** a deadline-exceeded provider wait surfaces as `DispatchResult.failure.reason = 'timeout'` (canonical reason already in `bundled-impls.ts` `FAILURE_REASONS`). A worker-internal spawn timeout maps to a non-zero exit (app-level), never an unhandled rejection. Honor the failure-vs-exitCode contract (provider/infra failure → `failure`; app non-zero → `exitCode`).
- **Build before test:** cross-package imports resolve to built `dist/`; run `pnpm -r build` after touching a package's public surface before running dependents' tests. CI runs `pnpm -r build` then `pnpm -r --workspace-concurrency=1 test`.
- **Gates (run before claiming done):** `pnpm -r typecheck`, `pnpm -r lint`, touched-package `vitest run`, root `pnpm test:e2e`, and the `dogfood-fake` $0 harness exercises the bounded spawn path on CI.
- **Win32 vs POSIX:** group-kill (`process.kill(-pid)`) is POSIX-only; the helper already falls back to a plain kill on win32. Tests must cover both branches as the existing `bounded-command` tests do.

---

## Audit revisions (2026-06-22)

Findings from a code-grounded audit, folded into the tasks below:

- **R1 (correctness, Task 6):** preserve `spawnClaude`'s **throw on spawn-error** (binary-not-found) — the pipeline-runner maps an adapter throw → `worker-failed` (infra), distinct from an agent non-zero exit. Only a **timeout** maps to `exitCode -1`. Keeps the existing `claude-spawn.test.ts` `.rejects` test green.
- **R2 (DRY, Tasks 5/8):** the repo already has `parsePositiveInteger` (`packages/pangolin-worker/src/env-parser.ts`, unexported). Extract it to `pangolin-core` and reuse in the worker env-parser + the claude-code adapter instead of a new `envSeconds`. Follow its fail-fast convention: `env.X ? parsePositiveInteger(env.X, 'X') : default`.
- **R3 (DRY, Tasks 1/4):** add `makeTimeoutExit(startedAt?)` to `pangolin-core`; both `boundedAwaitExit` and the Fargate provider use it instead of duplicating the `{exitCode:-1, providerFailureReason:'timeout'}` literal.
- **R4 (derive consistency, Task 2):** emit `PANGOLIN_AGENT_TIMEOUT_SECONDS` + `PANGOLIN_PLUGIN_INSTALL_TIMEOUT_SECONDS` from the single client env-builder (`dispatch.ts:254-284`), derived from `effectiveTimeoutSeconds` — not just worker-side defaults.
- **R5 (observability, Task 2 test):** the resolve-not-throw timeout path still emits `dispatch.failed` via the reconcile/result-sink emit site (Site B, `dispatch.ts:376-383`) — add a test asserting `failure.reason === 'timeout'` so it cannot regress. No new metric required (the `timeout` outcome rides `pangolin_dispatch_completed_total{outcome:'failed'}`); a dedicated counter is a deferred nice-to-have.
- **R6 (no local-docker task):** `LocalDockerProvider.cancel()` already reaps (SIGTERM→poll→SIGKILL), so the wrapper's `cancel?()` on timeout covers it; honoring `ctx.signal` in its `awaitExit` is an optional future good-citizen upgrade, not required here.
- **R7 (lint):** the root eslint forbids an **unused** `catch (e)` binding (`caughtErrorsIgnorePattern: '^_'`) — use `catch {}` or `catch (_e)` when the error is unused; `as any`/`as unknown as` casts are permitted. The abortable `sleep` in Task 4 intentionally mirrors the orchestrator's canonical one (per-package duplication is the repo idiom — there are already 5 `sleep` defs).

---

## File Structure

**Slice A — provider seam (ship first):**
- `packages/pangolin-core/src/providers.ts` — add `signal?: AbortSignal` to `ProviderContext`; add `makeTimeoutExit()` factory (R3).
- `packages/pangolin-client/src/bounded-await-exit.ts` (new) — the `boundedAwaitExit` wrapper.
- `packages/pangolin-client/src/dispatch.ts` — call `boundedAwaitExit` in the shared `awaitExit` closure; thread `effectiveTimeoutSeconds`.
- `packages/pangolin-client/src/` client options — add `defaultDispatchTimeoutSeconds` (default 7200).
- `packages/pangolin-orchestrator/src/executors/dispatch.ts` — pass derived `timeoutSeconds` from `maxRuntimeMs`.
- `packages/pangolin-providers-fargate/src/index.ts` — honor `ctx.signal` in `awaitExit`.

**Slice B — worker-internal:**
- `packages/pangolin-core/src/bounded-command.ts` (new, extracted) — single home for the bounded child-process runner.
- `packages/pangolin-core/src/env-int.ts` (new, extracted) — `parsePositiveInteger` (R2), reused by the worker env-parser + claude-code adapter.
- `packages/pangolin-worker/src/bounded-command.ts` — re-export from core; update importers (`setup-script.ts`, self-verify).
- `packages/pangolin-runtime-claude-code/src/claude-spawn.ts` — bound the agent spawn.
- `packages/pangolin-runtime-claude-code/src/plugin-installer.ts` — bound each install spawn.
- `packages/pangolin-runtime-claude-code/src/adapter.ts` — read timeouts from `ctx.env`, pass through.

---

## Task 1: `boundedAwaitExit` wrapper + `ProviderContext.signal`

**Files:**
- Modify: `packages/pangolin-core/src/providers.ts` (add `signal?` to `ProviderContext`, ~lines 56-59)
- Create: `packages/pangolin-client/src/bounded-await-exit.ts`
- Test: `packages/pangolin-client/test/bounded-await-exit.test.ts`

**Interfaces:**
- Consumes: `ComputeProvider`, `TaskHandle`, `TaskExit`, `ProviderContext`, `ResolvedCredentials`, `TelemetryHook` from `@quarry-systems/pangolin-core`.
- Produces: `export async function boundedAwaitExit(compute: ComputeProvider, handle: TaskHandle, baseCtx: { credentials: ResolvedCredentials; telemetry?: TelemetryHook }, deadlineSeconds: number | undefined): Promise<TaskExit>` — resolves (never rejects) with a real exit, or a synthetic `TaskExit { exitCode: -1, providerFailureReason: 'timeout' }` on deadline.

- [ ] **Step 1: Add the contract field + the shared timeout-exit factory (R3).** In `packages/pangolin-core/src/providers.ts`, add to `ProviderContext`:

```ts
export interface ProviderContext {
  credentials: ResolvedCredentials;
  telemetry?: TelemetryHook;
  /** Aborted when the caller's liveness deadline elapses. Providers SHOULD
   *  stop waiting and best-effort reap when this fires; the caller settles the
   *  wait regardless. Absent for callers with no deadline. */
  signal?: AbortSignal;
}
```

and a single source of truth for a deadline-exceeded exit (used by the client wrapper AND providers — R3):

```ts
/** Canonical terminal for a wait that blew its liveness deadline.
 *  `providerFailureReason: 'timeout'` maps to DispatchResult.failure.reason='timeout'. */
export function makeTimeoutExit(startedAt: Date = new Date()): TaskExit {
  return {
    exitCode: -1,
    startedAt,
    finishedAt: new Date(),
    stdout: '',
    stderr: '',
    providerFailureReason: 'timeout',
  };
}
```

Export `makeTimeoutExit` from `packages/pangolin-core/src/index.ts`.

- [ ] **Step 2: Build core so the client sees the new field.**

Run: `pnpm --filter @quarry-systems/pangolin-core build`
Expected: exits 0.

- [ ] **Step 3: Write the failing tests.** Create `packages/pangolin-client/test/bounded-await-exit.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import type { ComputeProvider, ProviderContext, TaskExit, TaskHandle } from '@quarry-systems/pangolin-core';
import { boundedAwaitExit } from '../src/bounded-await-exit.js';

const handle: TaskHandle = { providerTaskId: 't-1' };
const baseCtx = { credentials: { kind: 'none' } } as const;

function provider(over: Partial<ComputeProvider>): ComputeProvider {
  return {
    name: 'fake',
    run: async () => handle,
    awaitExit: async () => { throw new Error('not impl'); },
    ...over,
  };
}

const ok: TaskExit = {
  exitCode: 0, startedAt: new Date(0), finishedAt: new Date(0), stdout: '', stderr: '',
};

describe('boundedAwaitExit', () => {
  it('passes through a fast exit untouched and does not cancel', async () => {
    const cancel = vi.fn(async () => {});
    const p = provider({ awaitExit: async () => ok, cancel });
    const exit = await boundedAwaitExit(p, handle, baseCtx, 3600);
    expect(exit).toEqual(ok);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('on deadline: aborts the signal, reaps via cancel, resolves with timeout failure', async () => {
    let seenSignal: AbortSignal | undefined;
    const cancel = vi.fn(async () => {});
    const p = provider({
      // never resolves until aborted; record the signal it received
      awaitExit: (_h: TaskHandle, ctx: ProviderContext) =>
        new Promise<TaskExit>((resolve) => {
          seenSignal = ctx.signal;
          ctx.signal?.addEventListener('abort', () => resolve(ok)); // good citizen path
        }),
      cancel,
    });
    // 0-second deadline => fires on next tick
    const exit = await boundedAwaitExit(p, handle, baseCtx, 0);
    expect(exit.providerFailureReason).toBe('timeout');
    expect(exit.exitCode).toBe(-1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(seenSignal?.aborted).toBe(true);
  });

  it('with no deadline, calls awaitExit once and never constructs a timer/signal', async () => {
    const awaitExit = vi.fn(async (_h: TaskHandle, ctx: ProviderContext) => {
      expect(ctx.signal).toBeUndefined();
      return ok;
    });
    const p = provider({ awaitExit });
    const exit = await boundedAwaitExit(p, handle, baseCtx, undefined);
    expect(exit).toEqual(ok);
    expect(awaitExit).toHaveBeenCalledTimes(1);
  });

  it('does not reject when cancel throws on deadline', async () => {
    const p = provider({
      awaitExit: () => new Promise<TaskExit>(() => {}), // hangs forever
      cancel: async () => { throw new Error('stop failed'); },
    });
    const exit = await boundedAwaitExit(p, handle, baseCtx, 0);
    expect(exit.providerFailureReason).toBe('timeout');
  });
});
```

- [ ] **Step 4: Run the tests, verify they fail.**

Run: `pnpm --filter @quarry-systems/pangolin-client exec vitest run test/bounded-await-exit.test.ts`
Expected: FAIL — `Cannot find module '../src/bounded-await-exit.js'`.

- [ ] **Step 5: Implement the wrapper.** Create `packages/pangolin-client/src/bounded-await-exit.ts`:

```ts
import {
  makeTimeoutExit,
  type ComputeProvider,
  type ProviderContext,
  type ResolvedCredentials,
  type TaskExit,
  type TaskHandle,
  type TelemetryHook,
} from '@quarry-systems/pangolin-core';

type BaseCtx = { credentials: ResolvedCredentials; telemetry?: TelemetryHook };

/**
 * Bound a provider's awaitExit by a wall-clock deadline. Resolves (never
 * rejects on timeout) so callers always reach a terminal state and the
 * orchestrator's detached await records `settled`. On deadline it aborts
 * ctx.signal (clean path for a good-citizen provider), best-effort reaps via
 * compute.cancel?(), and resolves a synthetic timeout TaskExit.
 *
 * deadlineSeconds === undefined preserves today's unbounded behavior (no
 * timer, no signal) for callers that opt out.
 */
export async function boundedAwaitExit(
  compute: ComputeProvider,
  handle: TaskHandle,
  baseCtx: BaseCtx,
  deadlineSeconds: number | undefined,
): Promise<TaskExit> {
  if (deadlineSeconds === undefined) {
    return compute.awaitExit(handle, baseCtx);
  }

  const ac = new AbortController();
  const ctx: ProviderContext = { ...baseCtx, signal: ac.signal };
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onDeadline = new Promise<TaskExit>((resolve) => {
    timer = setTimeout(() => {
      void (async () => {
        ac.abort();
        try {
          await compute.cancel?.(handle, ctx);
        } catch {
          // best-effort reap — the synthetic exit stands regardless
        }
        resolve(makeTimeoutExit()); // R3: shared factory, not an inline literal
      })();
    }, deadlineSeconds * 1000);
  });

  try {
    return await Promise.race([compute.awaitExit(handle, ctx), onDeadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
```

- [ ] **Step 6: Build core + client, run the tests, verify pass.**

Run: `pnpm --filter @quarry-systems/pangolin-core build && pnpm --filter @quarry-systems/pangolin-client exec vitest run test/bounded-await-exit.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit.**

```bash
git add packages/pangolin-core/src/providers.ts packages/pangolin-client/src/bounded-await-exit.ts packages/pangolin-client/test/bounded-await-exit.test.ts
git commit -m "feat(client): boundedAwaitExit wrapper + ProviderContext.signal"
```

---

## Task 2: Wire the wrapper + the `7200s` floor into client dispatch

**Files:**
- Modify: `packages/pangolin-client/src/dispatch.ts` (the `awaitExit` closure near line 328; `effectiveTimeoutSeconds` is computed near line 117 in the same `fireWork` scope)
- Modify: the `PangolinClient` options type + constructor (locate `defaultDispatchTimeoutSeconds`; add the default). Search: `rg "defaultDispatchTimeoutSeconds" packages/pangolin-client/src`
- Test: `packages/pangolin-client/test/dispatch-deadline.test.ts`

**Interfaces:**
- Consumes: `boundedAwaitExit` from `./bounded-await-exit.js`; the existing `effectiveTimeoutSeconds` local and the `compute`, `handle`, `credentials`, `client.telemetry` in scope at the closure.
- Produces: client dispatch now bounds every `awaitExit`; `PangolinClient` exposes `defaultDispatchTimeoutSeconds` (default `7200`).

- [ ] **Step 1: Write the failing test.** Create `packages/pangolin-client/test/dispatch-deadline.test.ts`. Use the existing in-memory client test harness pattern (copy the wiring from a neighboring test such as `test/dispatch-model.test.ts` for `PangolinClient` construction with a fake compute provider). The new assertions:

```ts
// ... harness: construct a PangolinClient with a fake compute provider whose
// awaitExit never resolves, storage = in-memory, credentials = none.
// Set the client's defaultDispatchTimeoutSeconds to a tiny value for the test
// (e.g. via constructor option) OR pass work.timeoutSeconds: 0.001.

it('a hung provider awaitExit settles as a timeout failure (does not hang the dispatch)', async () => {
  const result = await client.dispatch.run({
    subagent: 'agent-x',
    target: 'local',
    workerImage: 'img@sha256:' + '0'.repeat(64),
    timeoutSeconds: 0.001, // 1ms — forces the deadline
  });
  expect(result.failure?.reason).toBe('timeout');
});

it('default floor is 7200 when neither work nor option override is set', () => {
  // assert the client option resolves to 7200 (read the public getter or the
  // computed effectiveTimeoutSeconds via a spy on the fake provider's awaitExit ctx)
  expect(client.defaultDispatchTimeoutSeconds).toBe(7200);
});
```

(Adapt the harness to whatever the neighboring dispatch tests use to register a fake `ComputeProvider`. The fake's `awaitExit` should `return new Promise(() => {})` to hang.)

- [ ] **Step 2: Run, verify it fails.**

Run: `pnpm --filter @quarry-systems/pangolin-client exec vitest run test/dispatch-deadline.test.ts`
Expected: FAIL — the dispatch hangs / `result.failure` undefined (or the `defaultDispatchTimeoutSeconds` getter is missing).

- [ ] **Step 3: Add the floor.** In the `PangolinClient` options type add `defaultDispatchTimeoutSeconds?: number`, and in the constructor store `this.defaultDispatchTimeoutSeconds = opts.defaultDispatchTimeoutSeconds ?? 7200;`. Confirm the `effectiveTimeoutSeconds` line reads from this:

```ts
// dispatch.ts ~line 117 — confirm/keep this precedence (work override → client floor):
const effectiveTimeoutSeconds = work.timeoutSeconds ?? opts.defaultDispatchTimeoutSeconds;
```

(If `opts.defaultDispatchTimeoutSeconds` is currently `undefined`-able, the constructor default of `7200` now makes it always defined.)

- [ ] **Step 4: Call the wrapper in the closure.** In `dispatch.ts`, replace the body of the shared `awaitExit` closure (near line 328) so it routes through `boundedAwaitExit`:

```ts
import { boundedAwaitExit } from './bounded-await-exit.js';

// inside fireWork, the shared awaitExit closure:
const awaitExit = async (): Promise<TaskExit> => {
  try {
    return await boundedAwaitExit(
      compute,
      handle,
      { credentials, telemetry: client.telemetry },
      effectiveTimeoutSeconds,
    );
  } catch (err) {
    emitLifecycleEvent(client.telemetry, { kind: 'dispatch.failed', /* ...unchanged... */ });
    throw err;
  }
};
```

Keep the existing `emitLifecycleEvent` call and its arguments exactly as they are — only the `compute.awaitExit(...)` line becomes the `boundedAwaitExit(...)` line. (`effectiveTimeoutSeconds` must be in scope here; it is computed earlier in the same `fireWork`. If the closure is in a different scope, thread `effectiveTimeoutSeconds` into it as a captured const.)

- [ ] **Step 4b: Emit derived worker-timeout env vars (R4).** In the single worker env-builder (`dispatch.ts:254-284`, the `envVars` map), derive the worker children's bounds from `effectiveTimeoutSeconds` so the worker side is derive-with-floor too (not just defaults). Add after the existing conditional env entries, following the repo's conditional style:

```ts
if (effectiveTimeoutSeconds !== undefined) {
  envVars.PANGOLIN_AGENT_TIMEOUT_SECONDS = String(effectiveTimeoutSeconds);
  envVars.PANGOLIN_PLUGIN_INSTALL_TIMEOUT_SECONDS = String(Math.min(300, effectiveTimeoutSeconds));
}
```

(With the 7200s floor now always defined, these are always emitted; the adapter's `envSecondsOr` defaults in Task 8 remain the safety net for any older/standalone worker image that doesn't receive them.)

- [ ] **Step 4c: Assert the timeout failure reason (R5).** The deadline test from Step 1 asserts `result.failure?.reason === 'timeout'`. That value flows through `reconcile` → the result-sink's `providerFailureReason → failure` mapping → the `dispatch.failed` lifecycle emit (Site B, `dispatch.ts:376-383`), so this single assertion also guards that the resolve-not-throw path keeps the failed event. Add a one-line comment in the test citing R5 so the intent survives.

- [ ] **Step 5: Build + run the new test + the existing dispatch tests.**

Run: `pnpm --filter @quarry-systems/pangolin-client build && pnpm --filter @quarry-systems/pangolin-client exec vitest run`
Expected: PASS — new deadline tests pass; all existing dispatch tests still green (the `undefined`-deadline path is unchanged for callers that pass no timeout, but the floor now makes it 7200 by default — verify no existing test asserted unbounded-hang behavior; if one did, update it to the bounded expectation).

- [ ] **Step 6: Commit.**

```bash
git add packages/pangolin-client/src/dispatch.ts packages/pangolin-client/test/dispatch-deadline.test.ts
git commit -m "feat(client): bound awaitExit by effectiveTimeoutSeconds; default 7200s floor"
```

---

## Task 3: Orchestrator derives `timeoutSeconds` from `maxRuntimeMs`

**Files:**
- Modify: `packages/pangolin-orchestrator/src/executors/dispatch.ts` (the `DispatchExecutorOptions` interface ~lines 12-29 and the `client.dispatch.fire({...})` call ~line 91)
- Modify: orchestrator construction of `DispatchExecutor` if it must forward `maxRuntimeMs` (search: `rg "new DispatchExecutor" packages/pangolin-orchestrator`)
- Test: `packages/pangolin-orchestrator/test/dispatch-executor-timeout.test.ts`

**Interfaces:**
- Consumes: `PangolinClient.dispatch.fire` (accepts optional `timeoutSeconds`).
- Produces: `DispatchExecutorOptions` gains `maxRuntimeMs?: number`; `fire` passes `timeoutSeconds: Math.ceil(maxRuntimeMs / 1000)` when set.

- [ ] **Step 1: Write the failing test.** Create `packages/pangolin-orchestrator/test/dispatch-executor-timeout.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { DispatchExecutor } from '../src/executors/dispatch.js';

function fakeClient() {
  const fire = vi.fn(async () => ({
    dispatchId: 'd1',
    awaitExit: async () => ({ exitCode: 0 }),
    resolved: { subagent: { name: 'a', contentHash: 'h' }, capabilities: [], env: [], secretRefs: {}, workerImage: 'img' },
    reconcile: async () => ({ exitCode: 0 }),
    cleanup: () => {},
  }));
  return {
    namespace: 'ns',
    storage: { put: vi.fn(async () => {}), get: vi.fn(), resolveLatest: vi.fn(async () => null) },
    dispatch: { fire },
  } as unknown as Parameters<typeof makeExec>[0]['client'];
}
function makeExec(opts: { client: any; maxRuntimeMs?: number }) {
  return new DispatchExecutor({ client: opts.client, target: 'local', workerImage: 'img', maxRuntimeMs: opts.maxRuntimeMs });
}

describe('DispatchExecutor timeout derivation', () => {
  it('passes timeoutSeconds derived from maxRuntimeMs', async () => {
    const client = fakeClient();
    const ex = makeExec({ client, maxRuntimeMs: 90_000 });
    await ex.fire({ id: 'i1', inputs: { subagent: 'a' } } as any, { runId: 'r1' } as any);
    expect((client as any).dispatch.fire).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutSeconds: 90 }),
    );
  });

  it('omits timeoutSeconds when maxRuntimeMs is unset (client floor applies)', async () => {
    const client = fakeClient();
    const ex = makeExec({ client });
    await ex.fire({ id: 'i1', inputs: { subagent: 'a' } } as any, { runId: 'r1' } as any);
    const arg = (client as any).dispatch.fire.mock.calls[0][0];
    expect('timeoutSeconds' in arg).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify it fails.**

Run: `pnpm --filter @quarry-systems/pangolin-orchestrator exec vitest run test/dispatch-executor-timeout.test.ts`
Expected: FAIL — `maxRuntimeMs` not an option / `timeoutSeconds` not passed.

- [ ] **Step 3: Add the option + pass-through.** In `DispatchExecutorOptions` add:

```ts
  /** Engine wall-clock deadline (ms); when set, fire passes a derived
   *  timeoutSeconds so the client bounds awaitExit to the same budget. */
  maxRuntimeMs?: number;
```

In `fire`, add to the `client.dispatch.fire({...})` call (conditional spread, matching the existing `trace`/`inputRefs` style):

```ts
  ...(this.opts.maxRuntimeMs !== undefined
    ? { timeoutSeconds: Math.ceil(this.opts.maxRuntimeMs / 1000) }
    : {}),
```

- [ ] **Step 4: Forward `maxRuntimeMs` at the construction site (if the orchestrator owns it).** If `new DispatchExecutor({...})` is constructed inside the orchestrator with access to `maxRuntimeMs`, pass it through; if executors are constructed by the operator (e.g. in `examples/*` or `pangolin.config`), no orchestrator change is needed — the option is operator-set. Confirm with the `rg` above and wire the orchestrator-owned path only.

- [ ] **Step 5: Build + run.**

Run: `pnpm --filter @quarry-systems/pangolin-orchestrator build && pnpm --filter @quarry-systems/pangolin-orchestrator exec vitest run test/dispatch-executor-timeout.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit.**

```bash
git add packages/pangolin-orchestrator/src/executors/dispatch.ts packages/pangolin-orchestrator/test/dispatch-executor-timeout.test.ts
git commit -m "feat(orchestrator): DispatchExecutor passes timeoutSeconds derived from maxRuntimeMs"
```

---

## Task 4: Fargate provider honors `ctx.signal`

**Files:**
- Modify: `packages/pangolin-providers-fargate/src/index.ts` (`awaitExit`, ~lines 142-194; `StopTask` already imported per `cancel`)
- Test: `packages/pangolin-providers-fargate/test/awaitexit-signal.test.ts` (mirror the existing fake-ECS test setup; search `rg "DescribeTasksCommand" packages/pangolin-providers-fargate/test`)

**Interfaces:**
- Consumes: `ProviderContext.signal`; the existing injected fake `ECSClient`.
- Produces: `awaitExit` bails on `ctx.signal.aborted`, best-effort `StopTask`s, returns `TaskExit { exitCode: -1, providerFailureReason: 'timeout' }`.

- [ ] **Step 1: Write the failing test.** Create `packages/pangolin-providers-fargate/test/awaitexit-signal.test.ts`. Reuse the fake-ECS injection the existing provider tests use; the fake `DescribeTasks` always returns `lastStatus: 'PROVISIONING'` (never STOPPED). Then:

```ts
it('aborts the poll, StopTasks, and returns a timeout exit when ctx.signal fires', async () => {
  const send = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof DescribeTasksCommand) {
      return { tasks: [{ lastStatus: 'PROVISIONING', containers: [] }] };
    }
    return {}; // StopTask
  });
  const provider = new FargateProvider({ cluster: 'c', /* ...minimal opts... */, ecsClient: { send } as any, pollIntervalMs: 5 });
  const ac = new AbortController();
  const p = provider.awaitExit({ providerTaskId: 'arn:task/1' }, { credentials: { kind: 'none' }, signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  const exit = await p;
  expect(exit.providerFailureReason).toBe('timeout');
  expect(send.mock.calls.some(([c]) => c instanceof StopTaskCommand)).toBe(true);
});
```

- [ ] **Step 2: Run, verify it fails (it hangs / times out the test).**

Run: `pnpm --filter @quarry-systems/pangolin-providers-fargate exec vitest run test/awaitexit-signal.test.ts`
Expected: FAIL — currently `awaitExit` ignores the signal and never returns (vitest test-timeout).

- [ ] **Step 3: Honor the signal in the poll loop.** In `awaitExit`, check the signal each iteration and reap on abort. Insert at the top of the `for (;;)` body (and import `StopTaskCommand` if not already in scope — it is, per `cancel`):

```ts
for (;;) {
  if (ctx.signal?.aborted) {
    try {
      await this.ecs.send(
        new StopTaskCommand({
          cluster: this.opts.cluster,
          task: handle.providerTaskId,
          reason: 'pangolin-cancel: awaitExit deadline exceeded',
        }),
      );
    } catch {
      // best-effort reap
    }
    return makeTimeoutExit(); // R3: shared factory (import from @quarry-systems/pangolin-core)
  }
  const res = await this.ecs.send(new DescribeTasksCommand({ /* unchanged */ }));
  // ...unchanged STOPPED handling...
  await sleep(this.pollIntervalMs);
}
```

Change the method signature's second parameter from `_ctx` to `ctx` so the signal is read. Also make `sleep` abort-aware so a long `pollIntervalMs` doesn't delay the bail — race the sleep against the abort:

```ts
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
```

and call `await sleep(this.pollIntervalMs, ctx.signal);`.

- [ ] **Step 4: Build + run.**

Run: `pnpm --filter @quarry-systems/pangolin-providers-fargate build && pnpm --filter @quarry-systems/pangolin-providers-fargate exec vitest run`
Expected: PASS — new test green, existing provider tests still green.

- [ ] **Step 5: Commit.**

```bash
git add packages/pangolin-providers-fargate/src/index.ts packages/pangolin-providers-fargate/test/awaitexit-signal.test.ts
git commit -m "feat(fargate): honor ctx.signal in awaitExit (bail + StopTask + timeout exit)"
```

---

## Task 5: Extract `bounded-command` into `pangolin-core`

**Files:**
- Create: `packages/pangolin-core/src/bounded-command.ts` (verbatim move of the worker file's contents)
- Modify: `packages/pangolin-core/src/index.ts` (export `runBoundedCommand`, `RunBoundedCommandOpts`, `BoundedCommandResult`)
- Modify: `packages/pangolin-worker/src/bounded-command.ts` → re-export from core
- Modify: importers in `pangolin-worker` (`setup-script.ts`, the self-verify runner — search `rg "bounded-command" packages/pangolin-worker/src`)
- Test: move `packages/pangolin-worker/test/bounded-command.test.ts` → `packages/pangolin-core/test/bounded-command.test.ts` (retarget the import)

**Interfaces:**
- Produces (from core): `runBoundedCommand(opts: RunBoundedCommandOpts): Promise<BoundedCommandResult>`, with `RunBoundedCommandOpts { command; args?; cwd; env; timeoutSeconds; maxOutputChars? }` and `BoundedCommandResult { exitCode; stdout; stderr; durationMs; timedOut; startError? }`. Behavior identical to today's worker helper (POSIX group-kill via `detached`, win32 plain-kill, output caps, never-rejects).

- [ ] **Step 1: Move the file.** Copy `packages/pangolin-worker/src/bounded-command.ts` to `packages/pangolin-core/src/bounded-command.ts` unchanged (it imports only `node:child_process`).

- [ ] **Step 2: Export from core + extract the env-int parser (R2).** Add to `packages/pangolin-core/src/index.ts`:

```ts
export { runBoundedCommand } from './bounded-command.js';
export type { RunBoundedCommandOpts, BoundedCommandResult } from './bounded-command.js';
export { parsePositiveInteger } from './env-int.js';
```

Create `packages/pangolin-core/src/env-int.ts` by moving the existing helper from `packages/pangolin-worker/src/env-parser.ts` (currently unexported), with a package-neutral error prefix:

```ts
/** Parse a non-negative integer env value; throw on malformed (fail-fast). */
export function parsePositiveInteger(raw: string, varName: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`${varName} must be a non-negative integer, got: ${raw}`);
  }
  return n;
}
```

Update `packages/pangolin-worker/src/env-parser.ts` to import `parsePositiveInteger` from `@quarry-systems/pangolin-core` and delete its local copy (its `parseWorkerEnv` call site is unchanged). The worker's existing env-parser tests must stay green.

- [ ] **Step 3: Re-export from the worker (keep the worker's import paths stable).** Replace the body of `packages/pangolin-worker/src/bounded-command.ts` with:

```ts
export { runBoundedCommand } from '@quarry-systems/pangolin-core';
export type { RunBoundedCommandOpts, BoundedCommandResult } from '@quarry-systems/pangolin-core';
```

(Worker already depends on `@quarry-systems/pangolin-core`; no package.json change.)

- [ ] **Step 4: Move the test.** Move `packages/pangolin-worker/test/bounded-command.test.ts` to `packages/pangolin-core/test/bounded-command.test.ts` and change its import to `from '../src/bounded-command.js'`. (Leave the worker importers pointing at the worker re-export; their own tests still exercise it transitively.)

- [ ] **Step 5: Build core + worker, run both suites.**

Run: `pnpm --filter @quarry-systems/pangolin-core build && pnpm --filter @quarry-systems/pangolin-worker build && pnpm --filter @quarry-systems/pangolin-core exec vitest run test/bounded-command.test.ts && pnpm --filter @quarry-systems/pangolin-worker exec vitest run`
Expected: PASS — bounded-command tests green from core; worker suite (setup-script, self-verify) still green via the re-export.

- [ ] **Step 6: Commit.**

```bash
git add packages/pangolin-core/src/bounded-command.ts packages/pangolin-core/src/env-int.ts packages/pangolin-core/src/index.ts packages/pangolin-core/test/bounded-command.test.ts packages/pangolin-worker/src/bounded-command.ts packages/pangolin-worker/src/env-parser.ts
git rm packages/pangolin-worker/test/bounded-command.test.ts
git commit -m "refactor(core): extract bounded-command + parsePositiveInteger into pangolin-core"
```

---

## Task 6: Bound the agent spawn (`spawnClaude`)

**Files:**
- Modify: `packages/pangolin-runtime-claude-code/src/claude-spawn.ts`
- Test: `packages/pangolin-runtime-claude-code/test/claude-spawn-timeout.test.ts`

**Interfaces:**
- Consumes: `runBoundedCommand` from `@quarry-systems/pangolin-core` (already a dep — claude-code imports core types). `buildClaudeArgs` stays the pure arg builder.
- Produces: `spawnClaude(opts & { timeoutSeconds?: number })` — on timeout returns `{ exitCode: -1, stdout, stderr }` (bounded, group-killed); spawn-error returns `{ exitCode: -1, stderr: <message> }`. Generous output cap so the JSON envelope is never truncated.

- [ ] **Step 1: Write the failing test.** Create `packages/pangolin-runtime-claude-code/test/claude-spawn-timeout.test.ts`. Use a stub binary that sleeps (mirror the existing `claude-stub` pattern in `test/adapter.test.ts`):

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnClaude } from '../src/claude-spawn.js';

describe('spawnClaude timeout', () => {
  it('times out a hung agent and returns exitCode -1 (POSIX)', async () => {
    if (process.platform === 'win32') return; // group-kill path is POSIX; win32 covered by bounded-command tests
    const dir = await mkdtemp(join(tmpdir(), 'claude-spawn-'));
    const bin = join(dir, 'hang.sh');
    await writeFile(bin, '#!/bin/bash\nsleep 30\n');
    await chmod(bin, 0o755);
    const start = Date.now();
    const r = await spawnClaude({
      prompt: 'x', workspaceDir: dir, env: {}, claudeBin: bin, timeoutSeconds: 0.2,
    });
    expect(r.exitCode).toBe(-1);
    expect(Date.now() - start).toBeLessThan(5000); // killed promptly, not after 30s
  });
});
```

- [ ] **Step 2: Run, verify it fails.**

Run: `pnpm --filter @quarry-systems/pangolin-runtime-claude-code exec vitest run test/claude-spawn-timeout.test.ts`
Expected: FAIL — `spawnClaude` has no `timeoutSeconds`; it waits the full 30s (vitest test-timeout) or ignores the option.

- [ ] **Step 3: Route `spawnClaude` through `runBoundedCommand`.** Rewrite `spawnClaude` to delegate (keep `buildClaudeArgs` and the `SpawnClaudeOptions` shape; add `timeoutSeconds?`):

```ts
import { runBoundedCommand } from '@quarry-systems/pangolin-core';

// generous cap: bound memory without truncating a realistic JSON envelope.
const AGENT_OUTPUT_CAP = 10_000_000;

export interface SpawnClaudeOptions {
  // ...existing fields...
  /** Wall-clock bound for the agent CLI. Omit to inherit the caller default. */
  timeoutSeconds?: number;
}

export async function spawnClaude(opts: SpawnClaudeOptions): Promise<ClaudeSpawnResult> {
  const bin = opts.claudeBin ?? 'claude';
  const args = buildClaudeArgs(opts);
  const r = await runBoundedCommand({
    command: bin,
    args,
    cwd: opts.workspaceDir,
    env: opts.env,
    timeoutSeconds: opts.timeoutSeconds ?? 3600,
    maxOutputChars: AGENT_OUTPUT_CAP,
  });
  // R1: preserve the existing contract. A SPAWN ERROR (binary not found) is
  // infrastructural — rethrow so the pipeline-runner classifies it as
  // worker-failed (an adapter throw → worker-failed), keeping the existing
  // `.rejects` test green. Only a TIMEOUT (or non-zero exit) is an agent/app
  // failure, surfaced via a non-zero exitCode (-1 on timeout).
  if (r.startError) throw r.startError;
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}
```

Note: spawn-error semantics are **unchanged** (still a throw → `worker-failed`). The only new terminal is the timeout → `exitCode -1`. On the timeout path stdout may be empty/partial; guard the adapter's envelope parse (Task 8).

- [ ] **Step 4: Build core (dep) + claude-code, run.**

Run: `pnpm --filter @quarry-systems/pangolin-core build && pnpm --filter @quarry-systems/pangolin-runtime-claude-code build && pnpm --filter @quarry-systems/pangolin-runtime-claude-code exec vitest run`
Expected: PASS — timeout test green; existing `claude-spawn`/`adapter` tests still green, **including the `claude-spawn.test.ts` `.rejects`-on-binary-not-found test (R1: we preserve the throw)**. The stub-binary success path returns the same `{exitCode, stdout, stderr}`.

- [ ] **Step 5: Commit.**

```bash
git add packages/pangolin-runtime-claude-code/src/claude-spawn.ts packages/pangolin-runtime-claude-code/test/claude-spawn-timeout.test.ts
git commit -m "feat(claude-code): bound spawnClaude via runBoundedCommand (timeout + group-kill + cap)"
```

---

## Task 7: Bound each plugin-install spawn

**Files:**
- Modify: `packages/pangolin-runtime-claude-code/src/plugin-installer.ts`
- Test: `packages/pangolin-runtime-claude-code/test/plugin-installer-timeout.test.ts`

**Interfaces:**
- Consumes: `runBoundedCommand` from core.
- Produces: `installPluginsFromManifest(opts & { timeoutSeconds?: number })` — a hung install times out and throws fail-fast with the offending plugin name (preserving today's throw-on-failure contract).

- [ ] **Step 1: Write the failing test.** Create `packages/pangolin-runtime-claude-code/test/plugin-installer-timeout.test.ts`: write a `pangolin-plugins.json` with one name, point `claudeBin` at a `sleep 30` stub, set `timeoutSeconds: 0.2`, expect the promise to reject with a message containing the plugin name, within ~5s. (POSIX-guard like Task 6.)

- [ ] **Step 2: Run, verify it fails (hangs).**

Run: `pnpm --filter @quarry-systems/pangolin-runtime-claude-code exec vitest run test/plugin-installer-timeout.test.ts`
Expected: FAIL — no timeout; waits the full sleep.

- [ ] **Step 3: Route each install through `runBoundedCommand`.** Replace the inner `new Promise(... spawn ...)` with:

```ts
import { runBoundedCommand } from '@quarry-systems/pangolin-core';

const PLUGIN_OUTPUT_CAP = 1_000_000;

// inside the for-loop over manifest names:
const r = await runBoundedCommand({
  command: bin,
  args: ['plugins', 'install', name],
  cwd: opts.workspaceDir,
  env: opts.env,
  timeoutSeconds: opts.timeoutSeconds ?? 300,
  maxOutputChars: PLUGIN_OUTPUT_CAP,
});
opts.onOutput?.({ stream: 'stdout', text: r.stdout });
opts.onOutput?.({ stream: 'stderr', text: r.stderr });
if (r.startError) {
  throw new Error(`claude plugins install ${name} failed to spawn: ${r.startError.message}`);
}
if (r.timedOut) {
  throw new Error(`claude plugins install ${name} timed out after ${opts.timeoutSeconds ?? 300}s`);
}
if (r.exitCode !== 0) {
  const tail = `${r.stdout}${r.stderr}`.trim();
  throw new Error(`claude plugins install ${name} exited with code ${r.exitCode}${tail ? `: ${tail}` : ''}`);
}
```

Add `timeoutSeconds?: number` to `InstallPluginsOptions`. (`onOutput` now fires once per stream with the captured text rather than streaming chunks — acceptable; it is a test/diagnostic hook.)

- [ ] **Step 4: Build + run.**

Run: `pnpm --filter @quarry-systems/pangolin-runtime-claude-code build && pnpm --filter @quarry-systems/pangolin-runtime-claude-code exec vitest run`
Expected: PASS — timeout test green; existing plugin-installer tests green (adjust any that asserted per-chunk `onOutput` calls to assert the single post-run call).

- [ ] **Step 5: Commit.**

```bash
git add packages/pangolin-runtime-claude-code/src/plugin-installer.ts packages/pangolin-runtime-claude-code/test/plugin-installer-timeout.test.ts
git commit -m "feat(claude-code): bound plugin-install spawns via runBoundedCommand"
```

---

## Task 8: Adapter reads timeouts from `ctx.env` and passes them through

**Files:**
- Modify: `packages/pangolin-runtime-claude-code/src/adapter.ts` (`invoke`, lines 52-81)
- Test: `packages/pangolin-runtime-claude-code/test/adapter.test.ts` (add cases)

**Interfaces:**
- Consumes: `ctx.env.PANGOLIN_AGENT_TIMEOUT_SECONDS`, `ctx.env.PANGOLIN_PLUGIN_INSTALL_TIMEOUT_SECONDS`.
- Produces: `invoke` passes `timeoutSeconds` to `installPluginsFromManifest` and `spawnClaude`; defaults (300 / 3600) when env is unset or unparseable.

- [ ] **Step 1: Write the failing test.** In `test/adapter.test.ts`, add a case: spy/stub so a `claudeBin` that sleeps + `ctx.env.PANGOLIN_AGENT_TIMEOUT_SECONDS = '0.2'` makes `invoke` return a `RuntimeExit` with non-zero `exitCode` within ~5s (POSIX-guard). Add a small pure helper test for env parsing if you extract one.

```ts
it('bounds the agent spawn by PANGOLIN_AGENT_TIMEOUT_SECONDS', async () => {
  if (process.platform === 'win32') return;
  // ...write a sleep stub bin, build a RuntimeInvocation + ctx.env with the override...
  const exit = await adapter.invoke(spec, { dispatchId: 'd', env: { PANGOLIN_AGENT_TIMEOUT_SECONDS: '0.2' } });
  expect(exit.exitCode).toBe(-1);
});
```

- [ ] **Step 2: Run, verify it fails.**

Run: `pnpm --filter @quarry-systems/pangolin-runtime-claude-code exec vitest run test/adapter.test.ts`
Expected: FAIL — the agent spawn isn't bounded by the env value yet.

- [ ] **Step 3: Parse + pass through (R2: reuse `parsePositiveInteger`).** In `adapter.ts`, reuse the extracted core parser with the repo's `env.X ? parse(env.X, 'X') : default` idiom — no new `envSeconds` helper:

```ts
import { parsePositiveInteger } from '@quarry-systems/pangolin-core';

function envSecondsOr(env: Record<string, string>, key: string, fallback: number): number {
  return env[key] ? parsePositiveInteger(env[key], key) : fallback;
}

// inside invoke():
await installPluginsFromManifest({
  workspaceDir: spec.workspaceDir,
  env: ctx.env,
  claudeBin: this.opts.claudeBin,
  timeoutSeconds: envSecondsOr(ctx.env, 'PANGOLIN_PLUGIN_INSTALL_TIMEOUT_SECONDS', 300),
});
// ...
const spawnResult = await spawnClaude({
  prompt,
  workspaceDir: spec.workspaceDir,
  env: ctx.env,
  claudeBin: this.opts.claudeBin,
  dangerouslySkipPermissions: resolveBypassFlag(ctx.env),
  model: modelArg,
  timeoutSeconds: envSecondsOr(ctx.env, 'PANGOLIN_AGENT_TIMEOUT_SECONDS', 3600),
});
```

- [ ] **Step 3b: Guard the envelope parse on a non-zero exit (R1 follow-through).** A timeout returns `exitCode -1` with possibly-empty `stdout`; don't feed that to `parseClaudeEnvelope`. In `invoke`, after the spawn:

```ts
const { text, usage } =
  spawnResult.exitCode === 0
    ? parseClaudeEnvelope(spawnResult.stdout)
    : { text: spawnResult.stdout, usage: undefined };
```

(Keep the rest of the `RuntimeExit` return unchanged — a non-zero `exitCode` already makes the worker fail the block.)

- [ ] **Step 4: Build + run.**

Run: `pnpm --filter @quarry-systems/pangolin-runtime-claude-code build && pnpm --filter @quarry-systems/pangolin-runtime-claude-code exec vitest run`
Expected: PASS — env-bound test green; existing adapter tests green.

- [ ] **Step 5: Commit.**

```bash
git add packages/pangolin-runtime-claude-code/src/adapter.ts packages/pangolin-runtime-claude-code/test/adapter.test.ts
git commit -m "feat(claude-code): adapter threads PANGOLIN_*_TIMEOUT_SECONDS into spawns"
```

---

## Task 9: Full-workspace gates + docs note

**Files:**
- Modify: `docs-site/src/content/docs/reference/config.md` (add the new `PANGOLIN_AGENT_TIMEOUT_SECONDS`, `PANGOLIN_PLUGIN_INSTALL_TIMEOUT_SECONDS`, and the client `defaultDispatchTimeoutSeconds` to the env/option reference — search the existing `PANGOLIN_SETUP_TIMEOUT_SECONDS` entry and mirror its format)
- (No new source.)

- [ ] **Step 1: Run the full gates.**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r --workspace-concurrency=1 test && pnpm test:e2e`
Expected: all green. Fix any cross-package literal/typecheck fallout (e.g. a full `VerificationReport`/`ProviderContext` literal in an example test that now must include the new optional field — optional fields should not force changes, but run the workspace-wide typecheck to be sure, per the additive-type lesson).

- [ ] **Step 2: Document the knobs.** Add the three settings to `config.md` next to `PANGOLIN_SETUP_TIMEOUT_SECONDS`, each one line: name, default (3600 / 300 / 7200s), effect ("bounds the agent CLI / plugin install / provider awaitExit; safety net, operator-overridable").

- [ ] **Step 3: Commit.**

```bash
git add docs-site/src/content/docs/reference/config.md
git commit -m "docs(config): document per-provider/worker liveness timeout knobs"
```

---

## Self-Review

**Spec coverage:**
- §3 backbone (one deadline, two boundaries) → Tasks 1-4 (Boundary A) + Tasks 5-8 (Boundary B). ✓
- §4.1 `ProviderContext.signal` → Task 1. ✓
- §4.2 `boundedAwaitExit` at the chokepoint → Tasks 1-2. ✓
- §4.3 derive-with-floor (7200) → Task 2 (floor) + Task 3 (derive). ✓
- §4.4 Fargate good citizen → Task 4. ✓
- §5 worker-internal: extract to core → Task 5; `spawnClaude` → Task 6; plugin-install → Task 7; env-carried deadlines + defaults → Task 8. ✓
- §6 surfacing (`timeout` failure / non-zero exit) → Tasks 2, 4 (provider), 6, 7 (worker). ✓
- §7 testing → per-task TDD steps + Task 9 gates. ✓

**Placeholder scan:** No TBD/TODO. Two deliberate "locate the exact site" notes (Task 2 `defaultDispatchTimeoutSeconds`, Task 3 construction site) carry the `rg` command and the surrounding code so the implementer can pin them — not placeholders.

**Type consistency:** `boundedAwaitExit(compute, handle, baseCtx, deadlineSeconds)` is defined in Task 1 and consumed identically in Task 2. `runBoundedCommand`/`RunBoundedCommandOpts`/`BoundedCommandResult` defined (extracted) in Task 5, consumed in Tasks 6-7 with the same field names (`timedOut`, `startError`, `exitCode`, `stdout`, `stderr`). `timeoutSeconds` added consistently to `SpawnClaudeOptions` (Task 6) and `InstallPluginsOptions` (Task 7) and passed from the adapter (Task 8). `makeTimeoutExit()` (core, Task 1) is the single timeout-`TaskExit` source, used in Tasks 1 + 4 — no inline `providerFailureReason:'timeout'` literal duplicated. `parsePositiveInteger` (core, Task 5) is reused by the worker env-parser + the adapter (Task 8) — no `envSeconds` duplicate. ✓

**Audit revisions:** R1 (spawn-error throw preserved), R2 (`parsePositiveInteger` extracted+reused), R3 (`makeTimeoutExit` factory), R4 (client emits derived worker-timeout env), R5 (timeout→failure-reason test), R6 (no local-docker task — covered by wrapper+cancel), R7 (lint: no unused `catch (e)`) — all folded into the tasks above. ✓
