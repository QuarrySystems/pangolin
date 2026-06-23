# Per-provider liveness deadline — design

_Status: draft · 2026-06-22 · author: agent:claude (brainstormed with Brett)_

## 1. Problem

Nothing in the dispatch path guarantees that a blocking wait on a child **settles**. Three sites can hang forever, holding a concurrency slot and resource locks with no terminal event emitted:

1. **`pangolin-runtime-claude-code/src/claude-spawn.ts` `spawnClaude`** — spawns the agent CLI (the longest, most failure-prone child) with no timeout, no process-group kill, and **unbounded** stdout/stderr buffers.
2. **`pangolin-runtime-claude-code/src/plugin-installer.ts`** — each `claude plugins install <name>` spawn, same gap.
3. **`pangolin-providers-fargate/src/index.ts:149` `awaitExit`** — a `for (;;)` poll of `DescribeTasks` with a fixed cadence and **no maximum**; a task stuck `PROVISIONING` never settles.

The engine-level deadline already shipped (`tick.ts` `maxRuntimeMs`, default 2h) **does not** close these. It force-fails the *item* and best-effort calls `executor.cancel?.()`, but if the provider's `awaitExit` promise (or a worker-internal spawn) never resolves, the force-fail leaves a **dangling await** — the orphaned task/process/promise leaks. The engine deadline is the *outer policy*; what is missing is the *inner guarantee that every blocking wait resolves*.

The Fargate hang is not a Fargate quirk — it is **generic to the `ComputeProvider` seam**. Every provider's `awaitExit` is a blocking wait that can hang (a future Daytona/Modal/Cloudflare provider polls its own API; even local-docker's `container.wait()` can stall). If each provider hand-rolls its own deadline, every new provider is another chance to forget — which is precisely how Fargate got here. The serverless-adapter roadmap item makes "N providers, N chances to forget" a near-term liability.

## 2. Goals / non-goals

**Goals**
- **Liveness:** every `awaitExit` and every worker-internal spawn is guaranteed to settle in bounded wall-clock time.
- **Enforced at the seam, not per provider:** a new `ComputeProvider` inherits hang-safety without implementing anything; it cannot forget.
- **One deadline concept**, sourced top-down (derive from the orchestrator's `maxRuntimeMs`) with a **default floor** so the standalone `client.dispatch` path (no orchestrator) is never unbounded.
- **Clean reaping:** on deadline, the underlying task/process is best-effort reaped (Fargate `StopTask`, POSIX process-group kill) rather than leaked.
- **Honest surfacing:** a deadline-exceeded is an infra failure (`DispatchResult.failure.reason = 'timeout'`), not an app exit — consistent with the failure-vs-exitCode contract.

**Non-goals**
- Tight per-block SLAs or early-detection tuning. These bounds are **safety nets**, sized generously; catching a hang in 30 min vs 90 min is not the point — *settling at all* is.
- Streaming Fargate stdout/stderr (separate follow-up already noted in the provider).
- Changing the engine `maxRuntimeMs` policy. It stays as the outer wall-clock bound; this work makes its `cancel` actually able to reap because the inner waits now settle.
- A `scoped` permission mode or any unrelated worker-runtime change.

## 3. Architecture

One deadline concept, computed once near the top, applied at **two boundaries**:

```
orchestrator maxRuntimeMs ──derive──┐
                                     ▼
client.dispatch.fire: effectiveTimeoutSeconds = work.timeoutSeconds ?? defaultDispatchTimeoutSeconds (FLOOR)
        │
        ├── Boundary A: PROVIDER seam ────────────────────────────────────────────
        │     boundedAwaitExit(compute, handle, ctx, deadline)   [shared, client-side]
        │       • race compute.awaitExit(handle, { ..., signal }) against the deadline
        │       • on deadline: abort signal → best-effort compute.cancel?() → return
        │         synthetic TaskExit { providerFailureReason: 'timeout' }
        │       • ProviderContext gains `signal?: AbortSignal` (core contract)
        │       • providers SHOULD honor ctx.signal (Fargate: bail poll + StopTask)
        │
        └── Boundary B: WORKER-INTERNAL children ─────────────────────────────────
              deadline carried into the worker env (PANGOLIN_* seconds)
                • spawnClaude + plugin-install use a bounded spawn helper
                  (timeout + POSIX process-group kill + output caps)
```

**Separation of concerns:**
- **Provider** owns *how to run / wait / reap on its backend* — `run`, `awaitExit`, `cancel`. Unchanged surface except it MAY read `ctx.signal`.
- **Client** owns *the deadline policy* — computes `effectiveTimeoutSeconds`, applies `boundedAwaitExit` uniformly to whatever provider is plugged in.
- **Orchestrator** owns *derivation* — passes its `maxRuntimeMs` down as `timeoutSeconds` (closing the "supports it but never passes it" gap).

The shared wrapper is the load-bearing idea: liveness is enforced **once**, so every present and future provider gets it for free.

## 4. Boundary A — the provider seam

### 4.1 Contract change (pangolin-core)

Add an optional abort signal to `ProviderContext` (`packages/pangolin-core/src/providers.ts`):

```ts
export interface ProviderContext {
  credentials: ResolvedCredentials;
  telemetry?: TelemetryHook;
  /** Aborted when the caller's liveness deadline elapses. Providers SHOULD
   *  stop waiting and best-effort reap when this fires; the caller also
   *  settles the wait regardless (the signal is the clean path, not the only
   *  path). Absent for callers with no deadline. */
  signal?: AbortSignal;
}
```

`TaskExit.providerFailureReason` already exists and already maps to `DispatchResult.failure` with the canonical reason `'timeout'` (via `bundled-impls.ts` `FAILURE_REASONS`). No new failure type.

### 4.2 The shared wrapper (pangolin-client)

A `boundedAwaitExit` helper, applied inside the existing shared `awaitExit` closure at `dispatch.ts:328` so **both** the blocking client path (`dispatch.ts:457`) and the orchestrator's detached await (`executors/dispatch.ts:105`) are protected by one bound:

```ts
async function boundedAwaitExit(
  compute: ComputeProvider,
  handle: TaskHandle,
  baseCtx: { credentials: ResolvedCredentials; telemetry?: TelemetryHook },
  deadlineSeconds: number | undefined,
): Promise<TaskExit> {
  if (deadlineSeconds === undefined) {
    // No deadline available (and no floor configured) — preserve today's behavior.
    return compute.awaitExit(handle, baseCtx);
  }
  const ac = new AbortController();
  const ctx = { ...baseCtx, signal: ac.signal };
  const timer = setTimeout(() => ac.abort(), deadlineSeconds * 1000);
  try {
    return await Promise.race([
      compute.awaitExit(handle, ctx),
      deadlineExceeded(ac.signal), // resolves on abort, after best-effort reap
    ]);
  } finally {
    clearTimeout(timer);
  }
}
```

On deadline the wrapper: (1) aborts `ctx.signal` (a good-citizen provider stops its poll and reaps), (2) best-effort `compute.cancel?.(handle, ctx)` (the existing reap hook — Fargate `StopTask`), (3) resolves a synthetic `TaskExit { exitCode: -1, providerFailureReason: 'timeout', startedAt, finishedAt }`. The wrapper **resolves, never rejects on timeout**, so `reconcile` sees a clean failed terminal state and the orchestrator's `entry.settled` is populated.

`deadlineSeconds` is the already-computed `effectiveTimeoutSeconds` from `dispatch.ts:117` — no new value invented; it is reused for the wait bound in addition to its current secret/callback-TTL use.

### 4.3 Deadline sourcing (derive-with-default-floor)

- **Derive:** `DispatchExecutor.fire` (`executors/dispatch.ts:91`) passes `timeoutSeconds` derived from the orchestrator's `maxRuntimeMs` (e.g. `Math.ceil(maxRuntimeMs / 1000)`), closing the gap where the orchestrator never passes it. `maxRuntimeMs` is plumbed to the executor from the orchestrator/tick options (it currently lives only in `tick`).
- **Floor:** `PangolinClient` gains a `defaultDispatchTimeoutSeconds` with a generous built-in default (proposed **7200s / 2h**, matching the engine default) so the standalone `client.dispatch` path and any un-plumbed caller are never unbounded. `effectiveTimeoutSeconds = work.timeoutSeconds ?? defaultDispatchTimeoutSeconds` already implements the precedence.
- **Layering:** the provider bound (inner) is independent of the engine `maxRuntimeMs` (outer). Both at ~2h is intentional and correct: the inner exists to make the promise *settle and reap*, not to fire earlier. If an operator wants earlier provider give-up they set a smaller `timeoutSeconds`/`maxRuntimeMs`.

### 4.4 Fargate provider becomes a good citizen

`FargateProvider.awaitExit` reads `ctx.signal`: between `DescribeTasks` polls, if `signal.aborted`, it stops, best-effort `StopTask`s the orphaned task, and returns `TaskExit { providerFailureReason: 'timeout' }`. (The wrapper would settle even if it didn't — this just makes the inner poll stop promptly and reap natively.) `pollIntervalMs` stays as-is.

## 5. Boundary B — worker-internal spawns

The agent CLI and plugin-install run **inside the worker container** — a separate process that does not know the orchestrator's deadline. They are bounded with the worker's existing pattern, not the provider wrapper.

- **Reuse seam:** `pangolin-worker/src/bounded-command.ts` (`runBoundedCommand`) already does timeout + POSIX process-group kill (`killTree`) + output caps + never-rejects. It is the right mechanism; the claude spawns simply don't use it.
- **Placement decision:** `bounded-command` lives in `pangolin-worker`, but `spawnClaude`/`plugin-installer` live in `pangolin-runtime-claude-code`. To avoid a second copy of `killTree`, **extract the bounded child-process helper into `pangolin-core`** (it depends only on `node:child_process`, zero other deps) and have both `pangolin-worker` and `pangolin-runtime-claude-code` consume it. This is a targeted DRY move justified by the work; the worker's call sites are updated to import from core (behavior-preserving — golden/existing tests must stay green).
- **`spawnClaude` change:** route through the bounded helper with a timeout + group-kill + output caps. A timeout maps to a non-zero `ClaudeSpawnResult.exitCode` (e.g. -1), which the adapter already surfaces as a non-zero `RuntimeExit.exitCode` → the worker fails the agent block gracefully (no unhandled rejection, no unbounded buffer). Spawn-error semantics preserved.
- **`plugin-installer` change:** same bounded spawn; a hung install times out → throws fail-fast (today's non-zero/spawn-error behavior), with the offending plugin name.
- **Deadline source for the worker:** carried in the dispatch env (`PANGOLIN_AGENT_TIMEOUT_SECONDS`, `PANGOLIN_PLUGIN_INSTALL_TIMEOUT_SECONDS`), following the existing `PANGOLIN_SETUP_TIMEOUT_SECONDS` convention. Generous defaults when unset (proposed: agent 3600s, plugin-install 300s). These are emitted by the same path that builds the worker env (client `fire` / `DispatchExecutor`), derivable from the dispatch deadline; defaults make them safe standalone.

## 6. Error handling & surfacing

| Site | On deadline | Surfaces as |
|---|---|---|
| Provider `awaitExit` | abort signal → `cancel?()` reap → synthetic `TaskExit{providerFailureReason:'timeout'}` | `DispatchResult.failure = { reason: 'timeout', detail }` (infra failure) → item `failed` |
| Worker agent spawn | `killTree` SIGKILL group → `exitCode -1` | non-zero `RuntimeExit` → worker block fails → dispatch non-zero exit (app-level) |
| Worker plugin install | `killTree` SIGKILL group → throw fail-fast | worker boot fails → `worker-failed` |

All three are existing terminal shapes; no new failure plumbing. The engine `maxRuntimeMs` remains the outer net and now successfully reaps because the inner waits settle.

## 7. Testing

- **`boundedAwaitExit` (client, unit):** a fake `ComputeProvider` whose `awaitExit` never resolves → wrapper settles within the deadline, aborts the signal, calls `cancel`, returns `providerFailureReason:'timeout'`. A fast-resolving provider → passes through untouched, no `cancel`, timer cleared. No deadline → unchanged behavior.
- **`ProviderContext.signal` honored (Fargate, unit):** injected fake ECS client stuck `PROVISIONING`; abort the signal → provider stops polling, calls `StopTask`, returns timeout exit. (Mirrors the existing fake-ECS provider tests.)
- **Derivation (orchestrator, unit):** `DispatchExecutor.fire` passes `timeoutSeconds` derived from `maxRuntimeMs`; default floor used when none.
- **Bounded spawn (core + worker + claude-code):** extracted helper keeps `bounded-command`'s existing tests green; new tests for `spawnClaude`/`plugin-installer` timeout → group-kill + bounded buffers (win32 plain-kill branch, POSIX group-kill branch, both already covered by the helper).
- **Gates:** `pnpm -r typecheck` + `pnpm -r lint` + per-package tests + root e2e + the `dogfood-fake` $0 harness (the bounded spawn path runs under it on CI).

## 8. Scope & sequencing

Two independently-shippable slices over one shared concept:

1. **Provider seam (Boundary A)** — the architecturally load-bearing slice: `ProviderContext.signal` + `boundedAwaitExit` + orchestrator derivation + Fargate good-citizen. Closes the `awaitExit` hang for **all** providers, present and future. Ship first.
2. **Worker-internal (Boundary B)** — extract bounded helper to core; bound `spawnClaude` + plugin-install; env-carried deadlines. Mechanical; can land in the same plan or immediately after.

Both are demand-pulled by the same trigger as the unattended-`serve` work: you do not want an always-on daemon with hung-task holes. This is the on-ramp to that.

## 9. Open questions

- **Default floor value:** 7200s (match engine) vs a tighter operational default. Proposed 7200s for the client floor; agent 3600s / plugin 300s for the worker children. Operator-overridable.
- **Extract-to-core vs duplicate:** the spec assumes extract `bounded-command` → `pangolin-core`. If a lighter touch is preferred, duplicate `killTree` into claude-code (rejected here as a DRY violation, but cheaper blast radius).
