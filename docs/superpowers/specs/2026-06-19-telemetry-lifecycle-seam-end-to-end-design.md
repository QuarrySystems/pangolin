# Telemetry lifecycle seam — end-to-end design

**Date:** 2026-06-19
**Status:** approved (design) — pending implementation plan
**Scope:** `pangolin-client` (emission + reference consumer); doc updates in `pangolin-core` comments + docs-site.

## Problem

Pangolin Scale defines a clean dispatch telemetry seam — `TelemetryHook` (`pangolin-core/src/telemetry.ts`) consuming a closed 6-event `LifecycleEvent` union (`pangolin-core/src/lifecycle.ts`): `dispatch.accepted | started | finished | needs_input | failed | cancelled`. It is documented as *"the only out-of-band observability surface the runtime exposes."*

In practice the seam is **defined but dead**:

- The default hook is `NoopTelemetryHook` (drops everything).
- Only `dispatch.accepted` is ever emitted (`pangolin-client/src/dispatch.ts:302`).
- The providers (`local-docker`, `fargate`) *receive* the telemetry hook in their `ctx` but **never call `.emit()`** — so `started / finished / failed / needs_input / cancelled` never reach a client telemetry consumer.

The real per-dispatch signal instead lives in a **second, unintegrated channel**: the worker emits structured events from inside its container to stdout (captured into `DispatchResult.stdout` + sealed as `blocks[]` audit evidence) and to notification webhooks.

This spec makes the dispatch-level telemetry seam **real and usable**, without merging the worker's container-internal stream into it.

## Goals

1. Emit all six `LifecycleEvent`s through the existing `TelemetryHook`, in-process, at the dispatch lifecycle transitions.
2. Ship one reference consumer (`ConsoleTelemetryHook`) so the seam is demonstrably real and immediately usable, opt-in; default stays `Noop`.
3. Make emission robust: a buggy hook must never break a dispatch.
4. Keep the change DRY/SRP — a single emission site, no per-provider work, uniform across all current and future providers.

## Non-goals (explicit scope boundaries)

- **Block-level / worker-internal events** (`worker.boot`, per-pipeline-block events) stay in their native home: worker stdout + the `blocks[]` audit evidence. They are a finer altitude, only observable inside the sandboxed container, and already durably captured. Not funneled through the hook. (Approach "(a)" from brainstorming.)
- **Metrics, tracing, health/readiness, OTel/export** — separate future work (observability specs #2/#3). This spec only produces the event *spine* those would later hang off.
- **No narrowing of `ctx.telemetry`** on the provider/sink contracts — it remains available (non-breaking) for future provider-specific telemetry, but is documented as *not* the canonical home of the dispatch lifecycle.

## Decision: emit from the client dispatch path (Approach A)

The client's `fireWork` / `awaitExit` / `reconcile` / `cancel` (in `pangolin-client/src/dispatch.ts` + `cancel.ts`) already *is* the dispatch lifecycle — it resolves refs, starts the provider, awaits exit, reconciles the result, and cancels. It already emits `accepted` and already tracks `startTime`/`durationMs`. We emit all six events from there.

Rejected alternative — **emit from each provider** (via the `ctx.telemetry` they already receive): providers only know `started`/`finished`; `accepted`, `needs_input` (a worker-sentinel scan) and `cancelled` (the client cancel path) are not provider concepts. That forces **split emission** across the client + every provider — duplicated, drift-prone, the opposite of DRY/SRP. Centralizing in the client gives uniform behavior across `local-docker`, `fargate`, and every future provider for free, and matches `lifecycle.ts`'s own words (*"the runtime emits ... for each state transition"*).

## Design

### Components (all in `pangolin-client`)

1. **`emitLifecycleEvent(telemetry, event)`** — guarded emit helper (new file, e.g. `src/lifecycle-emit.ts`). Wraps `telemetry?.emit(event)` in try/catch; on throw, logs a loud, prefixed line and **never rethrows**:

   ```
   [pangolin telemetry] hook '<name>' threw on <event.kind>: <message>
   ```

   This is the single chokepoint every emission goes through. It is a deliberate, documented change to `telemetry.ts`'s current *"runtime does not catch"* contract — observability must never take down the dispatch path (same principle as the audit-completeness loud-by-default work). Emission stays synchronous, fire-and-forget.

2. **`ConsoleTelemetryHook`** — reference consumer, sibling to `NoopTelemetryHook` in `src/bundled-impls.ts`. `name = 'console'`; `emit(event)` writes one structured JSON line per event to **stderr** (`console.error(JSON.stringify(event))`). Stderr — not stdout — so it never collides with a command's stdout data (e.g. `pangolin dispatch run` prints its `DispatchResult` JSON to stdout), and it matches the repo's operator-output-on-stderr convention (`AuditLog`, `serve`, `orchestrator` all log to `console.error`). Opt-in via the existing `telemetry:` config field on `PangolinClient`; default stays `Noop`. Exported from the package index.

3. **`RecordingTelemetryHook`** — small test fake (pushes events to an array) for assertions. Inlined in the test file, matching the existing `dispatch.test.ts` fake conventions (no new exported test surface).

### Emission points & event→source mapping

All transitions are points the client already owns:

| Event | Where (client dispatch path) | Payload source |
|---|---|---|
| `accepted` | `fireWork`, **before** `compute.run` (moved earlier — semantically "refs resolved, not yet started"; today it fires after `run`) | dispatchId, target, resolved capabilities |
| `started` | immediately **after** `compute.run` returns the handle | `handle.providerTaskId`; sets `startTime` |
| `finished` | `reconcile(exit)` — clean exit that is **not** a failure or needs-input | `exit.exitCode` (including a non-zero *app* exit), `durationMs` |
| `failed` | `reconcile` when `result.failure` is set (provider/infra) **and** in the `awaitExit` wrapper on **rejection** (emit, then rethrow) | `providerFailureReason` / error message |
| `needs_input` | `reconcile` when the needs-input sentinel is detected | `durationMs` |
| `cancelled` | `cancel.ts` (`cancelDispatch`) after the best-effort provider cancel | dispatchId |

This honors the hardened `failure`-vs-`exitCode` contract (`bundled-impls.ts`): a non-zero *app* exit is `finished` (with its code); only a provider/infra failure (`providerFailureReason`) is `failed`.

**Both consumption paths are covered** because both go through the client seams:
- the blocking `client.dispatch()` calls `fireWork` → `awaitExit()` → `reconcile(exit)`;
- the orchestrator's `DispatchExecutor` calls the same `fireWork`, `flight.awaitExit()`, `inflight.reconcile(exit)`, and (for deadline/CLI cancel) `client.dispatch.cancel` → `cancelDispatch`.

The `awaitExit` wrapper (catch→emit `failed`→rethrow) is what covers the infra-**rejection** path for *both* consumers, since on a rejected `awaitExit` the orchestrator does not call the client's `reconcile`.

### Cancellation: two terminals, by decision (option i)

A cancelled dispatch can produce **two** terminal events: `cancelled` (intent, from the cancel path) followed later by the actual `finished`/`failed` when the killed container's `awaitExit` settles. We **accept both and document it** — both are true facts (you asked to cancel; it then exited). This avoids cross-component shared state between `cancel` and `awaitExit`. Consumers that want a single terminal can treat `cancelled` as authoritative and ignore a subsequent terminal for the same `dispatchId`.

### Error handling

- Guarded emit (above) — a throwing hook is swallowed + logged loudly; the dispatch is unaffected.
- No ordering guarantees beyond the per-dispatch transition order described; emission is best-effort fire-and-forget.

## Testing plan (TDD, client-level)

Using the existing `makeDeferredCompute` harness in `pangolin-client/test/dispatch.test.ts` plus a `RecordingTelemetryHook`:

1. `fire` emits `accepted` (before `run`) then `started` (after `run`), with correct payloads (`providerTaskId` on `started`).
2. `reconcile` emits exactly one of: `finished` on a clean exit (asserted for both `exitCode 0` and a non-zero *app* exit), `failed` when `providerFailureReason` is set, `needs_input` when the sentinel is present.
3. `awaitExit` rejection emits `failed` **and** rethrows (orchestrator path still observes the error).
4. `cancel` emits `cancelled`.
5. Guarded emit: a hook whose `emit` throws is swallowed + logged; the dispatch still completes (assert the result is unaffected).
6. `ConsoleTelemetryHook` emits one JSON-parseable line per event.

All are unit tests; no new integration surface required.

## Docs

- `docs-site reference/config.md` — document the `telemetry: new ConsoleTelemetryHook()` opt-in.
- `pangolin-core/src/telemetry.ts` + `lifecycle.ts` doc comments — emission is now real; note the guarded-emit contract change (runtime now catches + logs hook throws).
- A short "dispatch lifecycle events" note in the observability/explanation docs (what the six events mean, that they are dispatch-level, that block-level lives in the audit/worker stream).

## Risks / edge cases

- **Double terminal on cancel** — accepted by decision (i), documented.
- **`accepted` move** — relocating `accepted` to before `compute.run` changes its timing slightly; the existing single emission test must move with it. Low risk.
- **Output channel** — `ConsoleTelemetryHook` writes JSONL to **stderr**, keeping stdout clean for any command's data output (e.g. `pangolin dispatch run`'s result JSON). Consistent with the repo's operator-diagnostics-on-stderr convention.
- **`ctx.telemetry` retained but unused by providers** — intentional; documented as non-canonical to avoid a breaking contract change.
