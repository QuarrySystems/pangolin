---
title: Callback Delivery Reliability — Design Spec
date: 2026-07-23
status: draft (revised twice after audit)
branch: fix/callback-delivery-reliability
authors: [human:Brett, agent:claude-opus-4-8]
severity: high (every lifecycle and notification webhook currently fails; the five earliest failure paths emit nothing at all)
related:
  - ./2026-05-21-agora-mvp-design.md # §7.3 signing + replay window; original X-Agora-* names; §7.6 the SIGTERM claim
  - ./2026-07-23-patch-capture-env-scoping-design.md # sibling child-0 change; no file overlap
  - ./2026-07-23-worker-env-block-exposure-design.md # sibling finding; its C1 collides with §2.4 — see §3
---

# Callback Delivery Reliability — Design Spec

> **One line:** Every lifecycle and notification webhook Pangolin sends is **dead on arrival** — the
> header names contain a space and are rejected before the request leaves the process — and the path
> around them has no status check, no retry, and no timeout. Worse, the emitter is a **hard no-op until
> step 4**, so the five earliest failure paths emit nothing at all. Repair delivery, extend it to cover
> early failures, and make it survive cancellation.

---

## 1. The defects

Six defects on one path. D1 masks D2–D4 **in production**; D5 and D6 are independent of all of them.

### D1 — invalid header names (the whole channel is dead)

`lifecycle.ts:25-27` and `notifications.ts:86-88` send `'X-Pangolin Scale-Signature'`,
`'X-Pangolin Scale-Dispatch-Id'`, `'X-Pangolin Scale-Timestamp'`. A space is not valid in an HTTP field
name (RFC 9110 §5.1). Reproduced on Node v22.20.0: `TypeError: Headers.append: "X-Pangolin
Scale-Signature" is an invalid header name`. The request is never sent.

**Provenance, and the repo already holds the answer.** The original design specifies `X-Agora-Signature`
/ `-Dispatch-Id` / `-Timestamp` (`2026-05-21-agora-mvp-design.md:1080-1082`). Commit `37b19af` applied a
substitution of `Agora` → `Pangolin Scale`. **That commit's own message states the intended mapping as
`x-agora-* → x-pangolin-*`** — applied correctly under `test/` but not under `packages/`, which is why
`test/e2e/callback-signing-roundtrip.test.ts` asserts `post.headers['x-pangolin-signature']` while the
source sends something else. There is no naming decision to make.

**The two channels fail differently.** Lifecycle: `emit()` throws, `entrypoint.ts:163-170` catches and
logs. Notifications: the throw lands inside `Promise.allSettled` (`notifications.ts:91`) whose results are
never inspected — **completely silent**.

**The rename is definitionally non-breaking.** Invalid names mean `fetch` throws before sending; no
receiver has ever received these headers. Six occurrences in `src`, no other producer, no published doc.

### D2 — no HTTP status check

`lifecycle.ts:21-30` awaits `fetchFn(...)` and ignores the result. `fetch` does not reject on 4xx/5xx, so
once D1 is fixed a 500 neither throws nor logs and the worker proceeds as if delivery succeeded.

### D3 — no retry · D4 — no timeout

One attempt, no deadline. A briefly-unavailable receiver loses the event permanently; a receiver that
accepts the connection and never responds blocks the worker indefinitely.

### D5 — the emitter is a hard no-op until step 4

`entrypoint.ts:150-154` constructs the emitter with `hmacKey: undefined`, and `lifecycle.ts:12` returns
immediately when **either** `callbackUrl` or `hmacKey` is falsy. The key is set only at `:271`. So every
`failWith` before that point attempts **no request at all** — five sites, and this enumeration is
complete (there are no other `failWith` calls before `:271`):

| Site                | Reason                   | Today                                             |
| ------------------- | ------------------------ | ------------------------------------------------- |
| `entrypoint.ts:205` | storage construction     | no attempt                                        |
| `:216`              | adapter load             | no attempt                                        |
| `:224`              | bundle fetch / integrity | no attempt                                        |
| `:238`              | invalid pipeline spec    | no attempt                                        |
| `:264`              | callback key fetch       | no attempt (unavoidable — the key is what failed) |

This falsifies the comment at `entrypoint.ts:147-149` — _"We resolve it lazily below so an integrity
failure on the very first bundle still surfaces."_ It does not surface.

### D6 — no SIGTERM handler, and the default is worse than "terminate"

`boundedAwaitExit` (`pangolin-client/src/bounded-await-exit.ts:23-67`) resolves a synthetic timeout at the
dispatch deadline and calls `compute.cancel`. `packages/pangolin-worker/src` has no `SIGTERM` handler.

**The mechanism is not "Node's default terminates the process."** In the deployed container the worker is
**PID 1** — `Dockerfile:107` is exec-form `CMD` and the local-docker provider sets no `HostConfig.Init` —
and **Linux discards a default-action signal sent to PID 1.** So SIGTERM today is _ignored_: the container
sits out the entire grace and dies by `SIGKILL`
(`providers-local-docker/src/index.ts:243-249`). There is no default behaviour to rely on, which makes
installing a handler strictly necessary rather than merely better.

**The grace is not universal.** 10 s is local-docker's default (`index.ts:43`, applied at `:117`). Fargate
`cancel` issues `StopTaskCommand` (`providers-fargate/src/index.ts:214-221`) and that file's header says
the grace follows the task definition's `stopTimeout` — operator-owned, and set nowhere in this repo.
§2.4's budget is therefore **self-bounded**, not sized to an assumed grace.

This also falsifies MVP §7.6 (`:1107-1109`), which claims the worker traps SIGTERM and emits
`dispatch.cancelled`. It never has.

### 1.1 Why these survived — and what that means for ordering

`lifecycle.test.ts` and `notifications.test.ts` assert the header names **and assert the misspelled
ones**, passing because they inject a `fetchImpl` mock and read `init.headers` cast to
`Record<string,string>` (`notifications.test.ts:166`), where a space is an ordinary key.

**An injected-fetch mock that treats headers as a plain object is structurally incapable of catching an
invalid-header-name defect.** The tests did not miss the bug; they pinned it. §5 therefore requires a
change of _assertion style_, not of expected strings.

Because the unit suite never validates header names, **D1 does not mask D2–D6 in tests**, only in
production — so each defect's test can be written to fail against `main` without touching D1 first. See
§3 for why that logical independence does _not_ make them independently schedulable.

---

## 2. Design

### 2.1 Header names

Replace all six occurrences in `lifecycle.ts` and `notifications.ts` with `X-Pangolin-Signature`,
`X-Pangolin-Dispatch-Id`, `X-Pangolin-Timestamp`. Signature scheme unchanged: lowercase hex HMAC-SHA256
over `${dispatchId}.${timestamp}.${payload}`, prefixed `sha256=`.

**On the duplicated wire format.** `signCallback` exists (`pangolin-client/src/callback-hmac.ts`) and its
docstring says it is _"exported so the worker can compute identical signatures"_ — yet `lifecycle.ts:17-19`
and `notifications.ts:80-82` each hand-roll `createHmac`. Three copies. Consolidating means moving
`signCallback` into `pangolin-core`, since `pangolin-worker` does not depend on `pangolin-client` and
`pnpm check:deps` fails on undeclared specifiers. **Deferred** — but the mitigation must be stated
honestly: asserting construction in both worker test files covers **2 of the 3 pairwise drifts**. Drift
between the worker copies and `pangolin-client`'s — the copy the _receiver_ side uses — is guarded only by
`test/e2e/callback-signing-roundtrip.test.ts`, which §7 establishes has never executed. That is a real
residual, not a closed one, and it is a second reason §7's e2e requirement matters.

### 2.2 Delivery semantics for the lifecycle callback

`LifecycleEmitter.emit` gains status checking, a per-attempt timeout, and bounded retry, and **returns a
`DeliveryOutcome`** — `{ delivered: boolean; attempts: number; lastStatus?: number; lastReason?: DeliveryFailureReason }`
— instead of `Promise<void>`. Both types live in the worker's `lifecycle.ts`; nothing crosses a package
boundary. Verified source-compatible: all six call sites (`entrypoint.ts:164` and five in
`lifecycle.test.ts`) `await` and discard the result, so widening the return type breaks nothing.

Classification reads **`response.status`**, not `response.ok`:

| Status                           | Treatment                                                    |
| -------------------------------- | ------------------------------------------------------------ |
| 2xx                              | success                                                      |
| 5xx, 429, network error, timeout | retryable                                                    |
| other 4xx                        | **not** retryable — a contract error (bad auth, bad payload) |

3xx is not enumerated because `fetch` follows redirects by default.

> **Consequence for existing tests, which test 10 must own:** the three current mocks that invoke fetch
> resolve `{ ok: true }` with **no `status`**. A status-based implementation sees `undefined`, matching no
> row, and those tests would retry three times and break their `toHaveBeenCalledOnce()` assertions. They
> must gain `status: 200`.

**Retry applies to terminal kinds only.** `dispatch.finished`, `dispatch.failed`, `dispatch.needs_input`
and `dispatch.cancelled` get the full budget. **`dispatch.started` is fire-and-forget** — one attempt, no
retry, outcome logged. It is awaited at `entrypoint.ts:279` _before_ overlay, setup script, and the
pipeline, so a retry budget there would stall every dispatch behind a down receiver before any work
begins. Losing a `started` event is recoverable: the terminal event still arrives and carries the same
`dispatchId`.

**Fixed constants, not configuration.** 3 attempts total, 5 s per-attempt timeout, exponential backoff
`1000 * 2 ** n` (1 s, 2 s) with ±20 % jitter. **No environment knob** — the worker's environment is minted
by the client (`pangolin-client/src/dispatch.ts:255-296`), not an operator, so a `PANGOLIN_*` variable
here would be unmintable. (`PANGOLIN_SETUP_TIMEOUT_SECONDS` is the near-precedent: consumed at
`entrypoint.ts:426`, but no producer sets it.) The exponential shape matches
`orchestrator/src/engine/tick.ts:35-37`. This is a fourth hand-rolled retry loop alongside
`cmd-orch.ts:217-227`, `tick.ts:35-37`, and `storage-s3/src/index.ts:559-575`; extracting a shared helper
is deferred. (`bounded-command.ts` is not a candidate — it runs child processes, not `fetch`.)

**Timing must be injectable even though the budget is not configurable.** The emitter constructor gains
`sleepFn?` alongside the existing `fetchImpl?` — an internal test seam, not an operator knob. Without it
the tests are impossible: `packages/pangolin-worker` has no `vitest.config.ts`, so the suite runs at
vitest's **5 s default `testTimeout`**, and §2.2's own worst case is ≈18 s.

**Every attempt re-signs with a fresh timestamp.** MVP `:1087` requires integrators to _"reject events
older than 5 minutes"_; replaying the original bytes would make a backed-off retry fail when it is most
needed. Consequence, stated as contract: **delivery is at-least-once and the dedupe key is
`(dispatchId, kind)`.** Honest limits — `dispatchId` is caller-supplied and unenforced; the worker emits
**five** of the six kinds once §2.4 adds `dispatch.cancelled`; and `dispatch.cancelled` may _also_ be
emitted client-side (`pangolin-core/src/lifecycle.ts:6-8`, MVP `:1109`), so a receiver can see that kind
from two producers. Dedupe on `(dispatchId, kind)` handles it; a receiver keying on producer identity
would not.

### 2.3 Delivery coverage: resolve the key before it is needed

Move the SecretStore construction and key resolution block (`entrypoint.ts:245-256`) ahead of storage
construction, adapter load, bundle fetch, and pipeline-spec validation. Verified safe: key resolution
depends only on `secretStore`, which is built from `cfg.secretStoreKind` / `cfg.secretStoreDir` /
`deps.secretsManagerClient` and has no dependency on `storage`, `adapter`, or `bundles`. **The block
moves rather than being duplicated** — the same `secretStore` const is reused at `:355` and `:385`.

**Two failure paths remain silent, stated rather than implied:**

- A failure to fetch the key itself (`:264`) cannot emit — the key is what failed.
- `storeFromConfig` (`entrypoint.ts:252`) is **not** inside a try/catch and throws for `local-file`
  without a `dir`, or an unknown kind. That escapes `runWorker` entirely to the entry script. D5's table
  enumerates `failWith` sites only; this move puts that throw _earlier_, and wrapping it is **out of
  scope** here — noted so it is a known gap rather than a discovered one.

### 2.4 Surviving cancellation

**Seam.** A directly-callable `handleTermination(ctx)` is exported from the worker. `runWorker` accepts
`deps.registerTerminationHandler?: (fn: () => Promise<void>) => void` and calls it once the emitter and
storage exist. `bin/pangolin-worker-entry.mjs` — the only place `process.exit` is called — supplies
`fn => process.on('SIGTERM', () => { void fn().finally(() => process.exit(0)); })`.

This placement is forced by two facts: `runWorker` is called in-process by
`orchestrator/test/fixtures/inproc-worker-executor.ts` and by every case in `entrypoint.test.ts`, so
registering a listener inside it would leak listeners across the vitest process and an exiting handler
would kill the test runner; and the entry script has no access to the emitter, storage, or namespace.
Tests call `handleTermination` directly — no signal delivery, no listener.

**Behaviour.** Abort any in-flight retry schedule, make **one** final delivery attempt with a 2 s timeout,
persist on failure (§2.5), and return. The total is self-bounded at ≈2 s rather than sized to a grace
window, because Fargate's `stopTimeout` is operator-owned and unknown to this code (D6).

**What it emits.** `dispatch.cancelled` — already admitted by the union
(`pangolin-core/src/lifecycle.ts:71-76`) and a legal `NotificationConfig.when` value. Two cases the
handler must distinguish, because the realistic cancellation moment has _no_ delivery in flight:

- **Delivery in flight** — finish or persist it, then emit `cancelled`.
- **Mid-`runPipeline`, nothing in flight** — emit `cancelled` and return. It must **not** race the main
  path into a second terminal event: if the main path has already emitted `finished` or `failed`, the
  handler emits nothing.

**Out of scope, named:** killing the adapter child, and `channel.stop()` (`entrypoint.ts:526`). MVP §7.6
couples channel release to the SIGTERM story; this spec deliberately takes only the delivery half, and
says so rather than silently dropping it.

### 2.5 Durable record on failure — owned by the entrypoint

When `emit` returns `delivered: false`, **the entrypoint** writes the event to
`pangolin://<namespace>/dispatches/<dispatchId>/undelivered/<kind>.json` and logs. The emitter takes no
`persistUndelivered` callback and no logger — it delivers and reports; the entrypoint owns storage, the
logger, and `failWith` policy. Path shape verified constructible (`pangolin-core/src/uri.ts:212-234`;
`output-sentinel.ts:236` is precedent).

**One key per kind, last-write-wins** — a second failed delivery of the same kind supersedes the first.
Intended: the latest state is the useful one.

**The storage-construction path cannot persist.** After §2.3's move, the first site that can emit is
`:205` — _storage construction failed_ — where there is no `StorageProvider` to write into. On that path
the event is **emitted but not persisted**, with a log line saying so. This is the one place §2.3's fix
and §2.5's backstop do not compose, and it is inherent: storage is the thing that failed.

**Extraction.** The `emit` closure (`entrypoint.ts:161-179`) would otherwise own six concerns — telemetry
hook, lifecycle delivery, outcome policy, persistence, notification fan-out, and outcome logging — inside
a 460-line function. Extract `deliverLifecycle(event, ctx)` taking `{ emitter, storage, logger, namespace,
dispatchId }`.

**File body:** the `LifecycleEvent` plus the `DeliveryOutcome`, subject to §4.

**Scope: forensic, not reconciliation.** Nothing enumerates `undelivered/`, and a receiver that never got
`dispatch.started` has no `dispatchId` to look up. This makes the loss discoverable by an operator who
knows the id; it is not a receiver discovery path, and retention belongs to the storage backend.

### 2.6 Notifications

`fireNotifications` gets the header fix, **status classification**, and **per-endpoint failure logging** —
returning a per-endpoint outcome array the entrypoint logs, rather than taking a logger.

Status classification is required, not optional: `Promise.allSettled` marks a fetch returning HTTP 500 as
`fulfilled`, so inspecting settled results alone would leave a 500-returning endpoint **completely
silent** — the most common dead-endpoint mode, and precisely the one §4 claims to close.

It does **not** get retry. `notifications.ts:17-19` states the contract — best-effort, must not abort the
dispatch lifecycle — and it is fan-out to N third-party endpoints.

---

## 3. Ordering

**Logically independent, but not independently schedulable.** D1's notifications half, D2, D5, D6, and
§2.6 all edit `entrypoint.ts:150-179` — the same ~30 lines. A DAG plan must give **one task ownership of
that region**, or parallel tasks will conflict by construction. §2.5's `deliverLifecycle` extraction
should land first, inside that task, so the rest edit a function instead of a closure.

Two content constraints: §2.5's persistence needs §2.2's `DeliveryOutcome`; §2.4's handler needs something
to abort.

**Forward interaction with a sibling.** `2026-07-23-worker-env-block-exposure-design.md`'s candidate C1 —
re-exec the worker from a thin launcher — would insert a process between PID 1 and `runWorker`, changing
which process receives SIGTERM and invalidating §2.4's placement. If C1 lands, §2.4 must be revisited.
Neither spec blocks the other today; this is a sequencing note, not a dependency.

---

## 4. Security posture

Two new outbound surfaces — a durable record in storage, and more log lines. The governing precedent is
`entrypoint.ts:186-189`: canonical `reason` over the wire, long-form detail only to the log, _"that way
redacted secrets in `detail` never get POSTed to a webhook."_

**The record is an outbound surface, not a log.** `dispatches/<id>/undelivered/` sits in the prefix a
consumer reads, and **storage writes get no automatic redaction** — only `StructuredLogger` redacts
(`logger.ts:9-10, :20-32`), against the secret set registered at `entrypoint.ts:269, :362, :370, :393`.
Therefore `DeliveryOutcome` carries **no free text**: `lastReason` is a closed enum —
`http-status | network | timeout | aborted` — never a `fetch` error string, which can embed the URL. The
persisted body is the `LifecycleEvent` plus the outcome and nothing else.

**Webhook URLs: log the origin only.** `redactString` **cannot** help here — it replaces registered
secrets by substring, and no webhook URL is ever registered, so it returns the URL verbatim. Registering
URLs as secrets would redact them from every existing log line and every `redactString`-ed pipeline
artifact — far too wide. Stripping the query string is also insufficient: Slack-style webhooks carry the
token in the **path**. So log `new URL(u).origin` — scheme and host only. That identifies which endpoint
failed for an operator who knows their endpoints, and carries no credential.

**This also repairs an existing leak.** `entrypoint.ts:168` currently logs `(err as Error).message` for
`lifecycle.emit.failed`; on a real network failure that string embeds the URL. Replacing it with
outcome-based logging removes the leak rather than adding a second instance of it.

**Unchanged surfaces:** retry sends the same signed payload N times and discloses nothing new; signature
scheme, key custody, and replay window are untouched; `dispatch.cancelled` carries only canonical
`LifecycleEvent` fields.

**Threat-model rows:** none weakened. This spec neither reads nor relocates credentials, so the
_Identity theft_ row and its correction belong to `2026-07-23-patch-capture-env-scoping-design.md` §6.

**One posture improvement:** a failing notification webhook is completely silent today. §2.6 closes that
monitoring gap.

---

## 5. Testing

Each test must fail against `main` **by asserting** — not by failing to compile, and not by hanging.
Where a new symbol makes compile-failure the only pre-fix outcome, it is called out.

1. **Header names, both files.** Construct a real `Headers` from the `init.headers` the emitter passes;
   assert construction succeeds and the three names are exact. Also assert the signature equals a locally
   computed HMAC — in **both** worker test files (§2.1). _(The test reconstructs a `Headers`; production
   need not pass one.)_
2. **Non-2xx is a failure.** A 500 yields `delivered: false` after the configured attempts, using the
   injected `sleepFn` so no wall-clock elapses.
3. **4xx does not retry.** A 403 is attempted exactly once.
4. **Retry re-signs.** Timestamps differ across attempts and each signature verifies over its own.
5. **Timeout.** Split, because the whole thing cannot discriminate on `main`:
   **5a** — assert the `fetch` init carries an `AbortSignal`. Fails by assertion on `main` (no signal is
   passed today). **5b** — a receiver that settles only on abort yields a retryable attempt. Post-fix
   only; on `main` it would hang, so it is explicitly **not** part of the pre-fix bar.
6. **Early failure emits.** Force a bundle-integrity failure with a callback configured and assert a
   `dispatch.failed` POST is attempted. Achievable against the real harness — `entrypoint.test.ts` already
   has `setupHarness({ capabilityHashCorrect: false })` and a fake `secretsManagerClient` — and yields
   zero calls on `main`, so it fails by assertion. **This is the cleanest discriminator in the suite.**
7. **Termination flushes.** Call the exported `handleTermination(ctx)` directly with a fake ctx: assert one
   final attempt, that `dispatch.cancelled` is emitted, that the undelivered record is written when that
   attempt fails, and that **nothing is emitted** when the main path has already emitted a terminal event.
8. **Exhaustion persists, redacted.** Assert the persisted body **deep-equals** `{ event, outcome }` with
   `lastReason` drawn from the enum — a positive assertion, since "contains no URL" passes vacuously if
   nothing is written. _(New symbols mean this cannot fail by assertion on `main`; test 2 discriminates
   that the outcome is computed at all.)_
9. **Notification failures.** An endpoint returning **500** produces a log line carrying only the origin;
   a second healthy endpoint in the same fan-out still receives its POST.
10. **Existing tests updated in style and in mocks.** `lifecycle.test.ts` and `notifications.test.ts` move
    to the test-1 assertion style, **and the three `{ ok: true }` fetch mocks gain `status: 200`**
    (§2.2). Every other assertion in them continues to pass.

---

## 6. Non-goals

- Changing the signature scheme, payload, or replay window.
- Retry for notification webhooks (§2.6).
- Consolidating `signCallback` into `pangolin-core` (§2.1, with the residual stated).
- A configurable retry budget (§2.2).
- A reconciliation/discovery path for `undelivered/` (§2.5).
- Killing the adapter child or `channel.stop()` on termination (§2.4).
- Wrapping `storeFromConfig`'s throw (§2.3).
- **Populating `dispatchLevelNotifications`** — `entrypoint.ts:158` declares it and never populates it, so
  the source documented at `notifications.ts:7-8` is dead. Logged as its own `agora` task.
- Any coupling to the ai-os P15 work; `callback.authTokenRef` also touches `lifecycle.ts` and must
  sequence after this change.

---

## 7. Verification

Repo gate: `pnpm lint && pnpm typecheck && pnpm test`, plus `pnpm check:deps`.

**The e2e test must be made to run, not merely to pass.** `test/e2e/callback-signing-roundtrip.test.ts`
documents this contract but is `itIfDocker` and needs a reachable Secrets Manager, so on Linux CI it
**passes as skipped**. A green `pnpm test:e2e` is compatible with the test never executing — which,
together with its exclusion from the default gate, is why the source/test mismatch survived. It is also
the **only** guard on the third `signCallback` drift (§2.1). The PR must record a run in which it
executed, asserting the receiver observed at least two events.

_Cheaper than it looks:_ that test's comment claiming the local-docker provider cannot configure
`extraHosts` is stale — `extraHosts` is a supported provider option (`providers-local-docker/src/index.ts:85-91`,
`:131-133`); the helper simply never passes it.
