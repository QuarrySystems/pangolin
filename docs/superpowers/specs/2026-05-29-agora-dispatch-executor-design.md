---
title: Agora dispatch-executor (PR3) — design
date: 2026-05-29
status: **SHIPPED — status corrected 2026-08-03.** Verified on main: `pangolin-orchestrator/src/executors/dispatch.ts`. This line previously read "design (approved; plan pending)", which was stale: the work landed and the marker was never updated. **Originally:** design (approved; plan pending)
authors: [human:Brett, agent:claude-opus-4-8]
relates_to: docs/superpowers/specs/2026-05-28-agora-orchestrator-design.md (§4 Executor, §6 D6)
---

# Agora `dispatch-executor` (PR3)

> **Status:** approved design. The first concrete `Executor` — bridges the orchestrator's
> fire-and-reconcile tick (PR2) to real agora container dispatches (PR1), replacing the
> test fakes. PR3 of the agora-orchestrator build.

## 1. Context — the two seams it bridges

PR2 shipped the orchestrator `Executor` contract (`packages/agora-orchestrator/src/contracts/executor.ts`):

```typescript
interface Executor {
  id: string;
  fire(item: WorkItem): Promise<{ dispatchHash: string }>;          // start, don't block
  reconcile(dispatchHash: string): Promise<ExecutionResult | null>; // poll: null = still running
}
interface ExecutionResult { status: 'done' | 'failed'; output?: unknown; }
```

PR1 shipped the client fire/reconcile split (`@quarry-systems/agora-client`):

```typescript
function fireWork(client, work, opts): Promise<InFlightDispatch>;
interface InFlightDispatch {
  readonly dispatchId: string;
  readonly handle: TaskHandle;
  awaitExit(): Promise<TaskExit>;            // BLOCKING — provider has no poll
  reconcile(exit: TaskExit): Promise<DispatchResult>;
  cleanup(): void;
}
```

**The core problem:** the orchestrator's `reconcile` is a *non-blocking poll* (returns `null`
while running), but `ComputeProvider` (agora-core) exposes only a **blocking** `awaitExit` —
there is no `poll(handle)`. The dispatch-executor must bridge the two.

## 2. Design

### 2.1 Placement & dependencies

`packages/agora-orchestrator/src/executors/dispatch.ts` — an internal module (per orchestrator
spec §13.4: keep impls inline until a second executor pulls extraction to a sibling package).
Adds `@quarry-systems/agora-client` to `agora-orchestrator`'s dependencies (it currently deps
only `agora-core` + `better-sqlite3`).

### 2.2 Construction (deploy-time, privileged)

```typescript
export interface DispatchExecutorOptions {
  client: AgoraClient;     // already wired: namespace, compute, credentials, storage
  target: string;          // deploy-time — which AgoraClient target to dispatch against
  workerImage: string;     // deploy-time — digest-pinned worker image
}
export class DispatchExecutor implements Executor {
  readonly id = 'dispatch';
  constructor(opts: DispatchExecutorOptions) { ... }
}
```

`target` and `workerImage` are **deploy-time config**, NOT taken from `WorkItem.inputs`. This is
a security boundary (orchestrator spec §10.6): a WorkItem may be submitted by a run-time agent
over MCP; letting it choose the worker image or target would hand a deploy-time/privileged
choice to untrusted run-time. The image/target live on the executor, configured once in
`agora.config.mjs`.

### 2.3 Input contract (Option A)

`WorkItem.inputs` (typed `Record<string, unknown>` since PR2 — unchanged) carries, by convention:

```typescript
// item.inputs shape the dispatch-executor expects:
{ subagent: string; env?: string | string[]; workerInput?: Record<string, unknown> }
```

`fire` maps these to `DispatchWork`:
- `subagent` ← `inputs.subagent`
- `env` ← `inputs.env`
- `input` ← `inputs.workerInput`
- `target` ← executor config
- `workerImage` ← executor config

The `subagent` / `env` keys are *executor parameters*; `workerInput` is the *worker's* payload.
Keeping `workerInput` nested preserves the executor-params-vs-worker-input separation without
changing the merged `WorkItem` type or the SQLite schema. (See §4 ladder: with the dev pack,
`subagent`→`subagentShape` and `workerInput`→schema-validated; promoting them to first-class
`WorkItem` fields is a deferred step that lands with C.)

Missing/invalid `inputs.subagent` → `fire` throws a clear error (the engine surfaces it; the
item fails).

### 2.4 `fire(item)` — non-blocking start

1. Parse `item.inputs` → `DispatchWork` (per §2.3) + `ClientDispatchOpts { workerImage }`.
2. `const inflight = await client.dispatch.fire(work)` (PR1's `fireWork`, exposed on the client
   dispatch callable — see §2.7).
3. **Kick off `inflight.awaitExit()` in the background, not awaited.** Store an entry in an
   in-memory `Map<string, InFlightEntry>` keyed by `inflight.dispatchId`:
   ```typescript
   interface InFlightEntry {
     inflight: InFlightDispatch;
     settled: { kind: 'exit'; exit: TaskExit } | { kind: 'error'; error: unknown } | null;
   }
   ```
   The background promise sets `settled` on resolve/reject (never throws out — it's detached).
4. Return `{ dispatchHash: inflight.dispatchId }`.

### 2.5 `reconcile(dispatchHash)` — non-blocking poll

1. Look up the map entry. Not found → `null` (unknown / already reconciled).
2. `settled === null` → still running → return `null`.
3. `settled.kind === 'error'` → `inflight.cleanup()`, delete entry, return `{ status: 'failed', output: { error } }`.
4. `settled.kind === 'exit'` → `const result = await inflight.reconcile(exit)` (collects the
   `DispatchResult` + writes the dispatch record), `inflight.cleanup()`, delete entry, return
   `{ status: result.exitCode === 0 ? 'done' : 'failed', output: result }`.

### 2.6 Crash-recovery scope (PR3 = minimal end-to-end)

In-memory map only. On orchestrator restart the in-flight entries are lost. Per PR2 resumability,
a `running` item resets to `ready` and **re-fires** — tolerable because dispatch is
content-addressed (the same work re-runs; no corruption). **Reattach-by-persisted-`TaskHandle`**
(persist `handle.providerTaskId`, and on restart call `compute.awaitExit(handle)` to re-acquire a
still-running or already-exited dispatch) is a deliberate **follow-up**, explicitly out of PR3.

### 2.7 One small change to `agora-client`

PR1 exported `fireWork(client, work, opts)` (a free function) but did **not** add a `.fire()`
method to the `client.dispatch` callable (that was deferred). PR3 needs an ergonomic call site,
so it adds `client.dispatch.fire(workAndOpts): Promise<InFlightDispatch>` — a thin wrapper over
`fireWork`, mirroring how `client.dispatch(...)` wraps `dispatchWork` and `.describe`/`.cancel`
are attached. Additive; no behavior change to existing methods.

## 3. Testing (no Docker)

- **Unit** (`test/executors/dispatch.test.ts`): construct an `AgoraClient` with a **fake
  `ComputeProvider`** (a controllable `awaitExit` that resolves on command, à la
  `agora-client`'s own dispatch tests) + memory storage; build `DispatchExecutor` over it. Assert:
  - `fire` returns `{ dispatchHash }` **without** blocking on exit (the fake's `awaitExit` is
    still pending).
  - `reconcile` returns `null` while pending; `{ status: 'done' }` after the fake exits 0;
    `{ status: 'failed' }` after a non-zero exit; `{ status: 'failed' }` when `awaitExit` rejects.
  - `inflight.cleanup()` is invoked on terminal reconcile (secret sweep).
  - missing `inputs.subagent` → `fire` throws.
- **Integration** (`test/executors/dispatch-orchestrator.int.test.ts`): register
  `{ dispatch: new DispatchExecutor(...) }` in an `AgoraOrchestrator` (real `SqliteRunStateStore`
  `:memory:`, `ManualTrigger`); `submitRun` a 1-item run whose `inputs.subagent` is set; `tick`
  → item fires; resolve the fake provider's exit; `tick` → item reconciles to `done`;
  `getStatus` shows `done`.

## 4. The A→C ladder (documented, NOT built)

PR3 is rung **A**. The path to the spec's §3/§11 destination (C — pack/`SubagentShape`) is additive:

1. **A (PR3):** executor config holds `target`+`workerImage`; items carry `subagent`+`workerInput`.
2. **B→C (dev-pack PR):** introduce a static `Record<string, SubagentShape>` (D8 — constructor-
   injected, not a runtime registry). `DispatchExecutor` gains an *optional* shape lookup: if
   `inputs.subagent` matches a shape, source `workerImage` from `shape.capability.imageDigest`,
   validate `workerInput` against `shape.inputSchema`, and validate the worker's
   `.agora/output.json` (D7) against `shape.outputSchema`; else fall back to executor defaults.
3. **C:** remove the fallback once all dispatches are shape-backed.

None of these are rewrites — the PR3 `DispatchExecutor` is the same code with shape-lookup added
later. Audit-grade output-schema validation arrives with C; PR3 trusts the worker's `output.json`
(acceptable — `dev` is the only producer and we control both ends).

## 5. Files

- `packages/agora-orchestrator/src/executors/dispatch.ts` — `DispatchExecutor` + `DispatchExecutorOptions`.
- `packages/agora-orchestrator/src/index.ts` — re-export `DispatchExecutor`.
- `packages/agora-orchestrator/package.json` — add `@quarry-systems/agora-client` dependency.
- `packages/agora-client/src/index.ts` — add `client.dispatch.fire(...)` to the callable + its type.
- `packages/agora-orchestrator/test/executors/dispatch.test.ts` — unit.
- `packages/agora-orchestrator/test/executors/dispatch-orchestrator.int.test.ts` — integration.

## 6. Out of scope (deferred)

Reattach-by-handle crash-recovery (§2.6); the `SubagentShape`/pack system and output-schema
validation (§4 B/C); promoting `subagent`/`workerInput` to first-class `WorkItem` fields; any
non-`dispatch` executor (shell, batch-api, dag-plan).
