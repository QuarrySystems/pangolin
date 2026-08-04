---
title: Worker Termination on SIGTERM — Design (slice C of 3)
date: 2026-07-23
status: **SHIPPED — status corrected 2026-08-03.** Verified on main: `terminationSignal wired in pangolin-worker/src/entrypoint.ts`. This line previously read "designed — Q1/Q2 resolved 2026-07-24 (flush-only; set-on-start); spec-audit findings resolved (guarded claim closes the handler-first race; signal threaded through deliver.ts); ready for a plan", which was stale: the work landed and the marker was never updated. **Originally:** designed — Q1/Q2 resolved 2026-07-24 (flush-only; set-on-start); spec-audit findings resolved (guarded claim closes the handler-first race; signal threaded through deliver.ts); ready for a plan
branch: fix/callback-delivery-reliability
authors: [human:Brett, agent:claude-opus-4-8]
severity: medium-high (a cancelled dispatch loses its terminal event; a documented behaviour has never existed)
related:
  - ./2026-07-23-callback-delivery-correctness-design.md # slice A
  - ./2026-07-23-callback-delivery-durability-design.md # slice B — shares entrypoint.ts; landed first (#93)
  - ./2026-07-23-callback-consumer-seam-design.md # §5 supplies the emit() signal seam (Q3); §6.1 corrects this file's stale at-least-once assumption
  - ./2026-07-23-worker-env-block-exposure-design.md # its C1 candidate rewrites the same entry script — reconciled in §7
  - ./2026-05-21-agora-mvp-design.md # §7.6 claims a SIGTERM handler that has never existed
---

# Worker Termination on SIGTERM — Design (slice C of 3)

> **One line:** The worker has no SIGTERM handler, and because it runs as **PID 1** the kernel *discards*
> the signal rather than terminating it — so a cancelled dispatch burns its whole grace window and dies
> by SIGKILL, losing any in-flight delivery. This slice installs a handler that mints a `dispatch.cancelled`
> event through the same `emit()` path (so slice B's durable-undelivered record backstops it) without ever
> producing a second terminal kind for one dispatch.

**§1–2 carry the verified finding and constraints. §3 records the resolved decisions. §4–7 are the design.
§8 is the plan hand-off.** Slices A + B + the abort seam shipped in PR #93 (`625927d`); this slice is the
caller that produces the abort signal, plus the handler.

---

## 1. The finding

`boundedAwaitExit` (`pangolin-client/src/bounded-await-exit.ts:23-67`) resolves a synthetic timeout exit
at the dispatch deadline and calls `compute.cancel`. `packages/pangolin-worker/src` contains **no
`SIGTERM` handler** — verified, no `process.on` anywhere in that tree.

**The mechanism is not "Node's default terminates the process."** In the deployed container the worker is
**PID 1**: `docker/pangolin-worker/Dockerfile:107` is exec-form `CMD ["node", …]` and the local-docker
provider builds `HostConfig` from `Binds`/`ExtraHosts` only (`src/index.ts:139`), never setting `Init`.
**Linux discards a default-action signal sent to PID 1.** So SIGTERM today is *ignored*: the container
sits out the entire grace and is killed at `providers-local-docker/src/index.ts:247`.

There is therefore **no default behaviour to rely on**, which makes installing a handler necessary rather
than merely better.

**The grace is not universal.** 10 s is local-docker's default (`src/index.ts:117`, documented `:40-42`).
Fargate issues `StopTaskCommand` (`providers-fargate/src/index.ts:213-222`) and the grace follows the
task definition's `stopTimeout` — operator-owned, and set nowhere in this repo. Any budget must be
**self-bounded**, not sized to an assumed window (see §5).

**A documented behaviour that has never existed.** MVP §7.6 (`:1107-1109`) claims the worker traps
SIGTERM, emits `dispatch.cancelled`, and releases channel subscriptions. None of it is true. Corrected in §7.

---

## 2. Constraints any design must satisfy

1. **The handler needs a seam, and the obvious placements both break something.** `runWorker` is called
   in-process by `packages/pangolin-orchestrator/test/fixtures/inproc-worker-executor.ts:189` and by every
   case in `entrypoint.test.ts`, so registering a listener inside it leaks listeners across the vitest
   process and a handler that exits would kill the test runner. The entry script
   (`docker/pangolin-worker/bin/pangolin-worker-entry.mjs`) is the right place for `process.on` and
   `process.exit` — it is the only such site on the worker container path — but it has no access to the
   emitter, storage, or namespace. Resolved by the injected-signal seam (§4).
2. **The abort surface — decided, shipped.** `LifecycleEmitter.emit(event, opts?: { signal?: AbortSignal })`
   composes an external signal with the internal per-attempt timeout via `AbortSignal.any`
   (`lifecycle.ts:86`). Slice A is at-most-once (§2.2.1): `emit` makes one bounded attempt, so the only
   thing SIGTERM interrupts is a single in-flight `fetch`. This slice is the caller that passes
   `opts.signal`.
3. **`entrypoint.ts` is shared with slice B**, which landed first (#93). This slice builds on that.
4. **`bin/pangolin-worker-entry.mjs` is contested** by the `/proc` fix's C1 candidate. Reconciled in §7:
   C1 must use exec-replace, keeping the worker as PID 1.
5. **A receiver may see `dispatch.cancelled` from two producers.** `dispatch.cancelled` is admitted by the
   union (`pangolin-core/src/lifecycle.ts:71-76`), is a legal `NotificationConfig.when` value, and may
   *also* be emitted client-side (`lifecycle.ts:6-8` header, MVP `:1109`) — so a receiver can see that kind
   from two producers and must be **idempotent on `(dispatchId, kind)` itself**. That is a receiver
   obligation, not a delivery guarantee Pangolin makes. Slice C never emits a *second terminal kind* for
   one dispatch (§4), so it introduces no new same-kind duplication beyond this pre-existing one.

---

## 3. Resolved decisions (Q1, Q2, Q3)

### Q1 — when a terminal event is in flight, does the handler emit `cancelled`? — **RESOLVED: flush-only.**

A run that produced a terminal outcome (`dispatch.finished`/`failed`/`needs_input`) is **flushed, never
re-emitted as `cancelled`.** The handler's job when a terminal is already claimed is only to let the
outstanding delivery finish within the budget. This avoids two contradictory terminal kinds for one
`dispatchId` — which a receiver idempotent on `(dispatchId, kind)` (constraint 5) would store as two
distinct terminal states rather than collapse. (Resolves the earlier draft's self-contradiction.)

### Q2 — where does the "already emitted a terminal event" state live, and when is it set? — **RESOLVED: a `runWorker`-scoped flag, set-on-START of the terminal emit.**

A single function-scoped `let terminalClaimed = false` in `runWorker`. Every terminal emit sets it `true`
**immediately before** calling `emit(...)` (set-on-start), not after it returns. The realistic race is
SIGTERM arriving between `await emit({kind:'dispatch.finished'})` (`entrypoint.ts:580`) **beginning** and
**returning**; set-on-start makes the flag already `true` in that window, so the handler takes the flush
branch. This flag is load-bearing — every handler test asserts on it (§6). (§4.2 makes the flag a
read+set `claimTerminal()` guard, not a bare set, and enumerates every emit site it must cover.)

### Q3 — what is the abort surface? — **RESOLVED (shipped #93).**

`emit` takes `opts?: { signal?: AbortSignal }`, composed with the internal per-attempt timeout via
`AbortSignal.any` — `lifecycle.ts:86`. What remains **this slice's** to add (the caller that produces the
signal): the `'aborted'` member of `DeliveryFailureReason` and its classification (§4.3). Slice A omits it
as unreachable until a caller passes a signal; this slice is that caller.

---

## 4. Design

### 4.1 The seam — an injected `AbortSignal`

`process.on`/`process.exit` stay in the entry script; the emitter/flag stay in `runWorker`. Bridge them
with an injected signal, so **no listener leaks into any test process**:

- Add `terminationSignal?: AbortSignal` to `RunWorkerDeps` (`entrypoint.ts:79`).
- `docker/pangolin-worker/bin/pangolin-worker-entry.mjs` creates an `AbortController`, registers
  `process.on('SIGTERM', () => controller.abort())`, and passes `controller.signal` as
  `deps.terminationSignal`. It keeps its existing `.then((code) => process.exit(code))`.
- Every existing caller (both in-proc executors, all of `entrypoint.test.ts`) passes no signal → no
  listener, no handler, byte-identical behaviour. (Satisfies constraint 1.)

`runWorker` reacts internally by racing the main flow against termination:

```
const outcome = await Promise.race([mainFlow(), terminationOutcome(deps.terminationSignal)]);
return outcome; // an exit code
```

When termination wins, `runWorker` resolves a normal exit code and returns. The entry script's existing
`.then(process.exit)` force-exits, killing the (now-orphaned) adapter promise. When no signal is injected,
`terminationOutcome` never resolves and the race is a no-op wrapper around `mainFlow()`.

**`mainFlow` is a real extraction, not a wrapper.** `runWorker`'s body is one ~470-line function with 15+
early `return failWith(...)` / `return N` exits. Racing it means hoisting that body into an inner
`mainFlow()` and lifting the shared state — `terminalClaimed`, `terminalDelivery`, the `emit` closure, and
`failWith` — into the outer `runWorker` scope so `terminationOutcome` (itself an **inner closure**, not the
free function the pseudocode above abbreviates) can read and mutate them. The plan must budget for this
restructure explicitly (§8).

### 4.2 The handler state machine

State: a single `runWorker`-scoped flag behind a claim helper (§3, Q2 — set-on-START):

```
let terminalClaimed = false;
let terminalDelivery: Promise<void> | null = null;
function claimTerminal(): boolean {   // flips synchronously, before any await
  if (terminalClaimed) return false;  // someone already owns this dispatch's terminal
  terminalClaimed = true;
  return true;
}
```

**Every terminal emit is guarded by the claim — a read AND a set, not a bare set** (this is the correction
the spec audit forced: a bare set lets a late main-flow completion emit a second terminal kind *after* the
handler's `cancelled`). The first caller to claim wins and emits; any later caller sees `false` and emits
nothing. **The worker has four terminal-emit sites, and the guard goes on each** — enumerate them exactly,
because the second audit caught one missing:

- `finished` (`entrypoint.ts:580`) and `needs_input` (`:548`) — the tail success emits.
- **the direct `provider-failed` `dispatch.failed`** on the adapter-non-zero-exit path (`:570`) — this
  does **NOT** route through `failWith` (whose signature takes only the worker-side reasons
  `integrity-failed | fetch-failed | worker-failed`), so it needs its own guard. Missing this site was the
  gap the second audit found; unguarded, it re-opens the double-terminal defect on exactly the
  adapter-failure path.
- **`failWith`** (`:187`) — its **15** call sites all funnel through one emit, so a single guard inside
  `failWith` covers them all.

Plus the handler's own `cancelled` emit. (The fifth `emit(` in the file — `dispatch.started` at `:295` — is
**non-terminal** and must **not** be guarded; the claim is for terminal kinds only. These four + `started`
are the complete `emit(` set, verified by grep.) The uniform wrap at each site:

```
if (claimTerminal()) {
  terminalDelivery = emit(terminalEvent);   // finished | failed | needs_input
  await terminalDelivery;
}
```

On `terminationSignal` abort (`Promise.race` does **not** cancel the loser — `mainFlow` keeps running):

- **claim already taken** (`claimTerminal()` returns `false` — a terminal outcome owns this dispatch, or its
  emit is mid-flight): do **not** emit `cancelled` (Q1). Await `terminalDelivery` if present — it is
  **self-bounded by its own internal per-attempt timeout** (5 s; the main-flow emit passed no termination
  signal). Resolve exit code **0**. slice B's durable-undelivered record is the backstop if the flush does
  not finish before SIGKILL.
- **handler wins the claim** (`claimTerminal()` returns `true` — adapter still running, no terminal
  produced): `await emit({ kind: 'dispatch.cancelled', dispatchId, at }, { signal: budgetSignal })`. On
  delivery failure `deliverLifecycle` persists `dispatches/<id>/undelivered/dispatch.cancelled.json`
  (`deliver.ts:41` builds the path from `event.kind`) → the receiver reconciles by polling. Resolve exit
  code **0**.

**The claim closes both orderings** — this is the load-bearing correctness argument:

- *Main-first* (SIGTERM lands during an in-flight terminal emit, `entrypoint.ts:580`): the emit already
  claimed, so the handler sees `false` and takes the flush branch.
- *Handler-first* (SIGTERM while the adapter runs, then the adapter completes **within** the cancel budget):
  the handler claimed first, so `mainFlow`'s trailing terminal emit sees `false` and is **suppressed** — the
  `cancelled` outcome stands, the late `finished`/`failed` is discarded.

Neither ordering produces two terminal kinds for one `dispatchId`.

**Exit code: 0 on cancellation** — a graceful cancellation is not a worker failure (mirrors the
`finished`/`needs_input` paths). The container is being torn down regardless; the code is provider
bookkeeping only.

**Adapter cancellation is out of scope.** The running compute is a child process that dies with the
container at exit/SIGKILL. Actively killing it inside the budget buys no durable benefit and is not what
the finding is about (losing the terminal *event*). Noted as deferred, not built.

### 4.3 The `'aborted'` classification — this slice's one piece of shared-file code

- Add `'aborted'` to `DeliveryFailureReason` (`lifecycle.ts:4`, currently `'http-status' | 'network' |
  'timeout'`).
- In the `emit` `catch` (`lifecycle.ts:101`): classify `opts.signal?.aborted && !timeout.aborted ⇒
  'aborted'`, else the existing `timeout.aborted ? 'timeout' : 'network'`. Classify on the **internal**
  timeout for `'timeout'` (unchanged) so an external abort never reads as `'timeout'`.

This is **observability only** — `deliverLifecycle` persists the undelivered record on *any* non-delivered
reason, so reconciliation is unaffected. The value is distinguishing "we aborted for grace" from "endpoint
timed out" in the log and the durable record. (`notifications.ts:160`'s parallel classification is out of
scope — notifications do not receive this slice's signal.)

**The signal is not yet wired end-to-end — this slice must thread it (the audit's B2).** The `AbortSignal.any`
seam exists *only* on `LifecycleEmitter.emit` (`lifecycle.ts:86`). The path the worker actually uses drops
any `opts`: the `emit` closure (`entrypoint.ts:155`, signature `async (event) => Promise<void>`) →
`deliverLifecycle(event, ctx)` (`deliver.ts:50`) → `ctx.emitter.emit(event)` (`deliver.ts:51`). So
`emit({…}, { signal })` as written in §4.2 **does not compile today**, the `B` budget is inert, and the
`'aborted'` branch is unreachable until the signal is plumbed. Required plumbing: the `emit` closure gains an
optional `signal`; `deliverLifecycle` (and `DeliverContext`, or its call) forwards it to
`emitter.emit(event, { signal })` for the **lifecycle webhook only** — never to the `deliverNotifications`
call in the same closure (notifications stay out of scope, per above). This is a `deliver.ts` change, listed
as its own build step in §8.

---

## 5. Budget arithmetic

With Q1 = flush, the cancel path is **one** delivery, not two — the earlier "≈2 s vs ~4 s" contradiction
dissolves. Worst-case handler cost is one bounded `fetch` + (on failure) one `storage.put` of
`undelivered/dispatch.cancelled.json`.

Grace is **not knowable in-worker** (local-docker default 10 s; Fargate `stopTimeout` operator-owned, set
nowhere in-repo), so the budget is **self-imposed and conservative**, sized to leave room for the durable
write:

- `budgetSignal = AbortSignal.timeout(B)`, `B = 2000 ms`, passed to the cancel `emit`. The internal
  per-attempt timeout is 5 s, so `AbortSignal.any` makes the 2 s budget dominate: a hung endpoint aborts at
  2 s (→ `'aborted'`), leaving ~8 s of a 10 s grace for the `storage.put`.
- If an operator sets `stopTimeout` below ~3 s, SIGKILL may win before the durable write — that is the
  at-most-once ceiling slice B already accepts, **not** a regression introduced here.
- `B` is a **named constant with the derivation in a comment**, not a magic number. **No new env var** to
  pass grace in (YAGNI until an operator actually tightens `stopTimeout`; the durable record covers the
  loss). If that need materialises, the seam is: read grace from env, `B = grace − margin`.
- **`B` bounds the lifecycle `fetch`, not the follow-on `storage.put`.** `persistUndelivered`
  (`deliver.ts:42`) has no timeout, so under a hung storage backend the durable write itself can miss the
  grace window and be SIGKILLed with neither the callback delivered nor the record written. The backstop is
  therefore **best-effort, not guaranteed** — the same at-most-once ceiling slice B already accepts. This
  slice does not promise the record always lands; it promises the `cancelled` event is *minted and attempted*
  through the durable path.
- **`B` also does not bound the notification fan-out.** The `emit` closure awaits `deliverNotifications`
  *after* `deliverLifecycle` (`entrypoint.ts:173-174`), and B2 threads the budget signal to lifecycle only
  (§4.3). So the handler's `await emit(cancelled, { signal })` still awaits any
  `NotificationConfig.when === 'dispatch.cancelled'` fan-out, bounded only by its own per-endpoint internal
  timeout. **Decision:** the cancel emit goes through the normal closure (lifecycle + notifications), exactly
  like every other terminal kind — a `dispatch.cancelled` notification is legitimately useful — so worst-case
  handler cost is one budgeted lifecycle `fetch` + the (internally-timed, unbudgeted) notification fan-out +
  one `storage.put`. Do **not** thread `B` into notifications (they stay out of scope, §4.3); accept the
  fan-out as best-effort within grace.

---

## 6. Testing

The handler's seam is `deps.terminationSignal` + `deps.onLifecycleEvent` (the synchronous event observer,
`entrypoint.ts:100`) — no container, no real signals. Every test drives `runWorker(env, { terminationSignal,
onLifecycleEvent, fetchImpl })` and asserts on the **captured event sequence and returned exit code**, not
call counts alone (green-on-main = vacuous). Cases:

1. **Cancel path** — abort the signal while the adapter is mid-run (a `fetchImpl`/adapter that blocks on an
   unreleased latch); assert exactly one `dispatch.cancelled` is observed, no terminal precedes it, exit 0.
2. **Flush path (terminal already complete)** — let the run reach `dispatch.finished`, then abort; assert
   **no** `dispatch.cancelled` is observed, exit 0.
3. **Main-first race (Q2)** — abort *during* the terminal emit (a `fetchImpl` that blocks after the handler's
   `onLifecycleEvent` fires); assert set-on-start took the flush branch: `finished` observed, `cancelled`
   **not** observed. Mutate the claim to set-on-complete and it must fail (positive control).
4. **Handler-first race (the audit's B1 — the one the first draft missed)** — abort while the adapter runs,
   then release the adapter latch so it completes **within** the cancel budget (after the handler's
   `cancelled` emit has begun). Assert `dispatch.cancelled` is delivered and the trailing terminal is
   **suppressed** (not observed), exit 0. Mutate the terminal wrap to a bare set (drop the `claimTerminal`
   read-guard) and it must fail (positive control on the guard). **Drive this race through each tail terminal
   path** — a clean `finished`, the **direct `provider-failed`** adapter-non-zero-exit emit (`:570`), and an
   early `failWith` (setup failure concurrent with SIGTERM) — so the guard is proven on the `provider-failed`
   site specifically (the one the first revision left unguarded), not only on `failWith`'s 15 sites and the
   tail successes.
5. **`'aborted'` classification** — a `fetchImpl` that hangs until the budget signal fires; assert the
   delivery outcome reason is `'aborted'`, not `'timeout'`/`'network'`, and that
   `undelivered/dispatch.cancelled.json` is persisted (assert the storage write, not just the reason). This
   case fails until the B2 signal-threading (§4.3) exists — it is the end-to-end proof of that plumbing.
6. **No-signal regression** — `runWorker(env, {})` with no `terminationSignal` registers no listener and
   behaves identically to today (guard the test-safety seam).

Discipline (from the arc): verify any container/PID-1 mechanism in Docker before relying on it; MEASURE
runtime claims, never reason them; tell every review subagent **not to write the working tree**.

---

## 7. Cross-spec reconciliations

**C1 collision (`/proc` fix, `worker-env-block-exposure`, branch `security/worker-credential-custody`).**
That finding's surviving candidate is C1 — a thin launcher that **`exec`s** the worker with a clean envp.
Because `execve` *replaces* the process image, the worker still becomes PID 1 and receives SIGTERM
directly. **Requirement (load-bearing in both specs): C1 uses exec-replace, never fork-and-supervise.**
Slice C's `process.on('SIGTERM')` goes in `pangolin-worker-entry.mjs` (the post-exec entry C1 keeps as the
real worker's entry). The two specs then touch adjacent code with **zero semantic conflict** — whoever
lands second only rebases. If C1 ever chose a supervising PID 1, SIGTERM would hit the launcher and the
handler would have to move there instead — which is why the constraint must be recorded on both sides.

**Channel release + MVP §7.6.** `channel.stop()` already runs in the pipeline `finally`
(`entrypoint.ts:527`) on the normal path. On the termination race we resolve past that `finally`, but the
subscription is an in-container background loop that dies with the container at exit/SIGKILL. **The handler
does NOT separately release it** — that is I/O inside the 2 s budget for no durable benefit. Instead,
**correct MVP §7.6 (`:1107-1109`)** to describe what actually happens: the worker (post-slice-C) traps
SIGTERM and emits `dispatch.cancelled` when no terminal was produced; it does *not* separately release
channel subscriptions (container teardown does). This correction is a statement of current fact and ships
regardless of the rest (it was false before this slice too).

---

## 8. Plan hand-off — scope summary

Build order (all in `packages/pangolin-worker` + the entry script + MVP doc):

1. `DeliveryFailureReason += 'aborted'` and the `catch` classification (`lifecycle.ts:4,101`).
2. **Signal-threading (B2 — do this before the handler, or the handler won't compile).** Add an optional
   `signal` to the `emit` closure (`entrypoint.ts:155`) and to `deliverLifecycle`/`DeliverContext`
   (`deliver.ts:50-51`), forwarding it to `emitter.emit(event, { signal })` for the lifecycle webhook
   **only**, never to `deliverNotifications` (§4.3).
3. **Restructure (N4).** Hoist `runWorker`'s body into an inner `mainFlow()`; lift `terminalClaimed`,
   `terminalDelivery`, the `emit` closure, and `failWith` into the outer scope. Add the `claimTerminal()`
   helper (§4.2) and guard **all four** worker terminal-emit sites: `finished` (`:580`), `needs_input`
   (`:548`), the **direct `provider-failed` `dispatch.failed`** (`:570`, which does NOT go through
   `failWith`), and inside `failWith` (`:187`, one edit for its 15 call sites).
4. `RunWorkerDeps.terminationSignal?: AbortSignal` (`entrypoint.ts:79`); the
   `Promise.race([mainFlow(), terminationOutcome()])` wrapper with `terminationOutcome` as an inner closure
   over the lifted state; the flush/cancel branches (§4.2) with the `B = 2000 ms` budget signal on the cancel
   emit (§5).
5. `docker/pangolin-worker/bin/pangolin-worker-entry.mjs`: `process.on('SIGTERM', …)` →
   `controller.abort()`, pass `controller.signal` as `deps.terminationSignal` (§4.1).
6. Tests §6 (six cases; positive controls on **both** race orderings — set-on-complete for main-first,
   bare-set for handler-first — and the end-to-end `'aborted'` case that proves the B2 plumbing).
7. Correct MVP §7.6 (§7).
8. Record the exec-replace requirement in `worker-env-block-exposure` (§7) — a one-line cross-reference.

Gate order is BUILD-FIRST (`pnpm -r build` before `typecheck`); `check:deps` is the orthogonality guard;
no `docs:check` in agora.
