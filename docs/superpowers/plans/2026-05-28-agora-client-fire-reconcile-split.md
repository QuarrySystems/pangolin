# AgoraClient fire/reconcile Split (PR1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose `AgoraClient`'s blocking `dispatchWork` into a `fireWork()` step (everything up to `provider.run()`) and a `reconcile(exit)` step (collect result + write record), with the existing blocking `dispatchWork` recomposed from the two — **zero behavior change**.

**Architecture:** This is decision **D9** of the orchestrator design (`docs/superpowers/specs/2026-05-28-agora-orchestrator-design.md`). The orchestrator (later PRs) needs to *fire* a dispatch without holding a process open for hours, then *reconcile* the result on a later tick (D6 fire-and-reconcile). Today `dispatchWork` welds the two together with a synchronous `awaitExit()`. We extract an `InFlightDispatch` seam — `{ dispatchId, handle, awaitExit(), reconcile(exit), cleanup() }` — returned by `fireWork()`. `dispatchWork()` becomes `fireWork()` → `awaitExit()` → `reconcile()` in a `try`, with `cleanup()` in `finally`, preserving the exact ordering and best-effort-cleanup semantics of the current code. This PR is the standalone, behavior-preserving prerequisite; nothing consumes the new seam yet.

**Tech Stack:** TypeScript (NodeNext ESM), vitest. Package: `@quarry-systems/agora-client`. All work is in `packages/agora-client/src/dispatch.ts`, `packages/agora-client/src/index.ts`, and `packages/agora-client/test/dispatch.test.ts`.

**Out of scope (do NOT do in this PR):** exposing `client.dispatch.fire()` on the callable surface (deferred to the PR that wires the dispatch-executor), any orchestrator code, any DB, any change to `durationMs` semantics (still `Date.now()`-based — cross-process duration is a later concern).

---

### Task 0: Baseline — confirm the regression net is green

**Files:**
- (none — verification only)

- [ ] **Step 1: Run the full agora-client suite and confirm it passes**

Run: `pnpm -F @quarry-systems/agora-client test`
Expected: PASS — all suites green, including `test/dispatch.test.ts` (24 cases). This is the regression net the refactor must keep green. If anything is red before you start, STOP and report — do not refactor on a red baseline.

- [ ] **Step 2: Run the package typecheck and confirm it passes**

Run: `pnpm -F @quarry-systems/agora-client typecheck`
Expected: PASS — no type errors.

---

### Task 1: Extract `fireWork` + `InFlightDispatch`, recompose `dispatchWork`

**Files:**
- Modify: `packages/agora-client/src/dispatch.ts` (add `InFlightDispatch` interface + `fireWork`; replace the trailing `try/finally` of `dispatchWork`)
- Test: `packages/agora-client/test/dispatch.test.ts` (add a new `describe` block; reuses the existing `makeMemoryStorage` / `makeCompute` / `makeCredentials` helpers and `beforeEach` stubs already in the file)

- [ ] **Step 1: Write the failing tests for the new seam**

Add `fireWork` to the existing import from `'../src/dispatch.js'` at the top of the file (it currently imports only `dispatchWork`):

```typescript
import { dispatchWork, fireWork } from '../src/dispatch.js';
```

`TaskExit` is already imported from `@quarry-systems/agora-core` in this file — no new core import needed. Then append this `describe` block to the end of `test/dispatch.test.ts`:

```typescript
describe('fireWork / reconcile split (D9)', () => {
  it('fireWork runs the provider once and returns an in-flight handle WITHOUT awaiting exit', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    let awaitExitCalls = 0;
    const runs: RecordedRun[] = [];
    const compute: ComputeProvider = {
      name: 'fire-compute',
      async run(spec, ctx) {
        runs.push({ spec, credentials: ctx.credentials });
        return { providerTaskId: 'prov-fire' };
      },
      async awaitExit(): Promise<TaskExit> {
        awaitExitCalls += 1;
        return { exitCode: 0, startedAt: new Date(0), finishedAt: new Date(1000), stdout: 'x', stderr: '' };
      },
    };
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });

    const inflight = await fireWork(client, { subagent: 's', target: 'prod' }, { workerImage: WORKER_IMAGE });

    expect(runs).toHaveLength(1);
    expect(awaitExitCalls).toBe(0); // fire fires; it does NOT await exit
    expect(inflight.handle.providerTaskId).toBe('prov-fire');
    expect(inflight.dispatchId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reconcile(exit) builds the result and writes the dispatch record, independently of awaitExit', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { compute } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });

    const inflight = await fireWork(client, { subagent: 's', target: 'prod' }, { workerImage: WORKER_IMAGE });
    const syntheticExit: TaskExit = {
      exitCode: 3,
      startedAt: new Date(0),
      finishedAt: new Date(1000),
      stdout: 'RECON',
      stderr: '',
    };
    const result = await inflight.reconcile(syntheticExit);

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe('RECON');
    expect(result.resolved.subagent.contentHash).toBe('sha256:s');
    const recordUri = `agora://ns/dispatches/${result.dispatchId}/record.json`;
    expect(storage.blobs.has(recordUri)).toBe(true);
    const parsed = JSON.parse(new TextDecoder().decode(storage.blobs.get(recordUri)!));
    expect(parsed.providerTaskId).toBe('prov-1');
    expect(parsed.target).toBe('prod');
  });

  it('cleanup() sweeps per-dispatch staged secrets', async () => {
    const storage = makeMemoryStorage();
    storage.seed('s', 'subagent', 'ns', 'sha256:s', { name: 's' });
    const { compute } = makeCompute();
    const client = new AgoraClient({
      namespace: 'ns',
      compute: { default: compute },
      credentials: { default: makeCredentials() },
      storage,
      targets: { prod: { compute: 'default', credentials: 'default' } },
    });
    const cleanupSpy = secretsManager.InlineSecretStager.prototype
      .cleanup as unknown as ReturnType<typeof vi.fn>;

    const inflight = await fireWork(
      client,
      { subagent: 's', target: 'prod', secrets: { TOKEN: { inline: 'x' } } },
      { workerImage: WORKER_IMAGE },
    );
    inflight.cleanup();

    await new Promise((r) => setImmediate(r)); // cleanup is best-effort; flush microtasks
    expect(cleanupSpy).toHaveBeenCalledWith(inflight.dispatchId);
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `pnpm -F @quarry-systems/agora-client test -- dispatch.test.ts -t "fireWork / reconcile split"`
Expected: FAIL — `fireWork` is not exported from `../src/dispatch.js` (import error / "fireWork is not a function").

- [ ] **Step 3: Implement `fireWork` + `InFlightDispatch` and recompose `dispatchWork`**

In `packages/agora-client/src/dispatch.ts`:

(a) Add `TaskHandle` and `TaskExit` to the existing `@quarry-systems/agora-core` import (the others stay):

```typescript
import {
  buildAgoraUri,
  type DispatchWork,
  type DispatchResult,
  type CapabilityRef,
  type SubagentRef,
  type EnvRef,
  type TaskSpec,
  type TaskHandle,
  type TaskExit,
  type SecretRef,
  type InlineSecret,
} from '@quarry-systems/agora-core';
```

(b) Add the `InFlightDispatch` interface just above `export async function dispatchWork`:

```typescript
/**
 * A dispatch that has been *fired* (provider container started) but not yet
 * reconciled. Returned by `fireWork`. The orchestrator (D6 fire-and-reconcile)
 * holds this across ticks; the blocking `dispatchWork` composes it inline.
 *
 *   - `awaitExit()`  — block until the provider task exits (synchronous path).
 *   - `reconcile(exit)` — collect the DispatchResult (sink or minimal) and
 *                         write the dispatch record. Pure of awaiting.
 *   - `cleanup()`    — best-effort sweep of per-dispatch staged secrets;
 *                      never throws (TTL is the fallback).
 */
export interface InFlightDispatch {
  readonly dispatchId: string;
  readonly handle: TaskHandle;
  awaitExit(): Promise<TaskExit>;
  reconcile(exit: TaskExit): Promise<DispatchResult>;
  cleanup(): void;
}
```

(c) Rename the current `export async function dispatchWork(...)` to `export async function fireWork(...)` and change its return type to `Promise<InFlightDispatch>`. **Keep its body byte-for-byte through the telemetry `dispatch.accepted` emit** (the current lines from the `capabilities`/`addCapabilities` guard down to and including the `client.telemetry?.emit({ kind: 'dispatch.accepted', ... })` call). Then **replace the trailing `try { ... } finally { ... }` block** (the `awaitExit → sink → writeDispatchRecord → return` trio plus the `finally` cleanup) with the three closures and a return:

```typescript
  // ── fire complete: container is running. Bundle the reconcile/cleanup
  //    closures so the caller (blocking dispatchWork, or the orchestrator)
  //    can collect the result whenever the task exits. ────────────────────
  const awaitExit = (): Promise<TaskExit> =>
    compute.awaitExit(handle, { credentials, telemetry: client.telemetry });

  const reconcile = async (exit: TaskExit): Promise<DispatchResult> => {
    const durationMs = Date.now() - startTime;

    // 8. ResultSink.collect — or fall back to a minimal DispatchResult.
    const sink = client.resultSink;
    const result: DispatchResult = sink
      ? await sink.collect(handle, exit, {
          dispatchId,
          resolved: {
            subagent: resolvedSubagent,
            capabilities: resolvedCapabilities,
            env: resolvedEnv,
          },
          telemetry: client.telemetry,
        })
      : {
          dispatchId,
          exitCode: exit.exitCode,
          stdout: exit.stdout,
          stderr: exit.stderr,
          durationMs,
          resolved: {
            subagent: resolvedSubagent,
            capabilities: resolvedCapabilities,
            env: resolvedEnv,
          },
        };

    // 9. Write the dispatch record (storage-side retention enforcement).
    await writeDispatchRecord(
      client,
      dispatchId,
      { ...result, providerTaskId: handle.providerTaskId, target: work.target },
      work.retentionDays ?? client.retention.defaultDays,
    );

    return result;
  };

  // 10. Best-effort cleanup of per-dispatch staged secrets. Never throws —
  //     the .catch() preserves the "never throw from cleanup" contract; the
  //     stager's TTL tag is the fallback when cleanup itself fails.
  const cleanup = (): void => {
    stager.cleanup(dispatchId).catch(() => {
      // intentionally suppressed — see above.
    });
  };

  return { dispatchId, handle, awaitExit, reconcile, cleanup };
}
```

(d) Add the recomposed blocking `dispatchWork` immediately below `fireWork`. It reproduces the exact ordering of the original: fire, then await-exit + reconcile inside a `try`, with `cleanup` in `finally`:

```typescript
/**
 * Orchestrate a dispatch end-to-end against an `AgoraClient` (blocking).
 * Composed from `fireWork` + `awaitExit` + `reconcile`, with best-effort
 * secret cleanup in `finally`. Behavior is identical to the pre-D9 monolith:
 * cleanup runs whether or not `awaitExit`/`reconcile` throws.
 */
export async function dispatchWork(
  client: AgoraClient,
  work: DispatchWork,
  opts: ClientDispatchOpts,
): Promise<DispatchResult> {
  const inflight = await fireWork(client, work, opts);
  try {
    const exit = await inflight.awaitExit();
    return await inflight.reconcile(exit);
  } finally {
    inflight.cleanup();
  }
}
```

Leave every helper below (`isSecretRef`, `resolveSubagent`, `resolveEnvBundles`, `resolveCapabilities`, `resolveCapabilityRefs`, `readSubagentCapabilities`, `flattenEnvBundleSecrets`) and the `ClientDispatchOpts` interface unchanged. Update the file-header comment's step 7 note to read: "7. `fireWork` calls `provider.run()`; the returned `InFlightDispatch.reconcile()` later calls `provider.awaitExit()`." (cosmetic, keeps the header honest).

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `pnpm -F @quarry-systems/agora-client test -- dispatch.test.ts -t "fireWork / reconcile split"`
Expected: PASS — all three new cases green.

- [ ] **Step 5: Run the FULL agora-client suite to verify zero regressions**

Run: `pnpm -F @quarry-systems/agora-client test`
Expected: PASS — every pre-existing case (all of `dispatch.test.ts` plus the rest of the package) still green. This is the load-bearing check: the existing `dispatchWork` cases prove behavior is preserved. If any pre-existing case fails, the refactor changed behavior — fix it before proceeding.

- [ ] **Step 6: Typecheck**

Run: `pnpm -F @quarry-systems/agora-client typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/agora-client/src/dispatch.ts packages/agora-client/test/dispatch.test.ts
git commit -m "$(cat <<'EOF'
refactor(client): split dispatchWork into fireWork + reconcile (D9)

Extract an InFlightDispatch seam { dispatchId, handle, awaitExit,
reconcile, cleanup } returned by fireWork(). Blocking dispatchWork is
recomposed as fire -> awaitExit -> reconcile with cleanup in finally,
preserving exact ordering and best-effort-cleanup semantics. Prepares
the orchestrator's fire-and-reconcile executor (D6); no behavior change.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Re-export the seam from the package barrel

**Files:**
- Modify: `packages/agora-client/src/index.ts` (re-export `fireWork` + the `InFlightDispatch` type)
- Test: `packages/agora-client/test/scaffold-shape.test.ts` (assert the new export is present)

This makes `fireWork` / `InFlightDispatch` importable as `@quarry-systems/agora-client` so the orchestrator package can consume the seam in a later PR. It is purely additive — no existing export changes.

- [ ] **Step 1: Write the failing export test**

Append to `packages/agora-client/test/scaffold-shape.test.ts` (this file imports the package barrel; if it imports from `'../src/index.js'`, match that path):

```typescript
import { describe, it, expect } from 'vitest';
import * as agoraClient from '../src/index.js';

describe('package barrel — fire/reconcile seam (D9)', () => {
  it('re-exports fireWork', () => {
    expect(typeof agoraClient.fireWork).toBe('function');
  });
});
```

(If `scaffold-shape.test.ts` already imports `* as` the barrel under a name, reuse that import instead of adding a duplicate.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -F @quarry-systems/agora-client test -- scaffold-shape.test.ts -t "fire/reconcile seam"`
Expected: FAIL — `agoraClient.fireWork` is `undefined` (not yet re-exported).

- [ ] **Step 3: Add the re-export**

In `packages/agora-client/src/index.ts`, find the existing `import { dispatchWork, type ClientDispatchOpts } from './dispatch.js';` line and add a re-export near the other public re-exports of the barrel (the file already imports `dispatchWork` for internal wiring; add an explicit public re-export so consumers get the new seam):

```typescript
export { fireWork, dispatchWork } from './dispatch.js';
export type { InFlightDispatch, ClientDispatchOpts } from './dispatch.js';
```

If `dispatchWork` / `ClientDispatchOpts` are already re-exported elsewhere in `index.ts`, do not duplicate — add only the missing `fireWork` and `InFlightDispatch` to the existing `export {...}` / `export type {...}` statements.

- [ ] **Step 4: Run the export test to verify it passes**

Run: `pnpm -F @quarry-systems/agora-client test -- scaffold-shape.test.ts -t "fire/reconcile seam"`
Expected: PASS.

- [ ] **Step 5: Full suite + typecheck**

Run: `pnpm -F @quarry-systems/agora-client test`
Expected: PASS — all green.
Run: `pnpm -F @quarry-systems/agora-client typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agora-client/src/index.ts packages/agora-client/test/scaffold-shape.test.ts
git commit -m "$(cat <<'EOF'
feat(client): export fireWork + InFlightDispatch from barrel (D9)

Make the fire/reconcile seam importable as @quarry-systems/agora-client
so the orchestrator's dispatch-executor can consume it. Additive only.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Acceptance criteria (whole PR)

- `fireWork(client, work, opts)` returns an `InFlightDispatch` after `provider.run()`, **without** calling `provider.awaitExit()` (verified: `awaitExitCalls === 0`).
- `InFlightDispatch.reconcile(exit)` produces the `DispatchResult` and writes the dispatch record from a caller-supplied `TaskExit`, with no dependency on `awaitExit()`.
- `InFlightDispatch.cleanup()` invokes `InlineSecretStager.cleanup(dispatchId)` and never throws.
- Blocking `dispatchWork` is recomposed from the seam and **all 24 pre-existing `dispatch.test.ts` cases plus the full `@quarry-systems/agora-client` suite stay green** — the behavior-preservation guarantee.
- `fireWork` and `InFlightDispatch` are importable from `@quarry-systems/agora-client`.
- `pnpm -F @quarry-systems/agora-client typecheck` passes.

Test file: `packages/agora-client/test/dispatch.test.ts` (seam behavior) and `packages/agora-client/test/scaffold-shape.test.ts` (barrel export).

## Self-review notes

- **Spec coverage:** Implements D9 (fire/reconcile split) and nothing else — matches §13.7 "PR 1" scope exactly. The `client.dispatch.fire()` callable surface is deliberately deferred (out-of-scope note in the header) to the executor-wiring PR, honoring YAGNI.
- **Placeholder scan:** none — every step has concrete code/commands.
- **Type consistency:** `InFlightDispatch` members (`dispatchId`, `handle`, `awaitExit`, `reconcile`, `cleanup`) are used identically in Task 1's tests, the implementation, and `dispatchWork`'s recomposition. `fireWork`'s signature matches `dispatchWork`'s original `(client, work, opts)`. `TaskHandle`/`TaskExit` come from `@quarry-systems/agora-core` (already a dependency).
- **Behavior-preservation reasoning:** `cleanup` timing is unchanged — in the original it ran in a `finally` wrapping `awaitExit`→record-write; recomposed, it runs in a `finally` wrapping `awaitExit`→`reconcile` (same span). A throw during `fireWork` (e.g. unknown target) occurs before `dispatchWork`'s `try`, so `cleanup` does not run — identical to the original, where such throws happened before the `try` at the old line 217 (staged secrets fall back to their TTL tag in both).
