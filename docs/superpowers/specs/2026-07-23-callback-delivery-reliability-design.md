---
title: Callback Delivery Reliability — Design Spec
date: 2026-07-23
status: draft (revised after audit)
branch: fix/callback-delivery-reliability
authors: [human:Brett, agent:claude-opus-4-8]
severity: high (every lifecycle and notification webhook currently fails; the five earliest failure paths emit nothing at all)
related:
  - ./2026-05-21-agora-mvp-design.md # §7.3 signing + replay window; original X-Agora-* names; §7.6 the SIGTERM claim
  - ./2026-07-23-patch-capture-env-scoping-design.md # sibling child-0 change; no file overlap
  - ./2026-07-23-worker-env-block-exposure-design.md # sibling finding; not ready for a plan
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
name (RFC 9110 §5.1). Verified on Node v22.20.0 — `Headers`, `Request`, and `fetch` all reject with
`TypeError: … is an invalid header name`. The request is never sent.

**Provenance, and the repo already holds the answer.** The original design specifies `X-Agora-Signature`
/ `-Dispatch-Id` / `-Timestamp` (`2026-05-21-agora-mvp-design.md:1080-1082`). Commit `37b19af` applied a
substitution of `Agora` → `Pangolin Scale`. **That commit's own message states the intended mapping as
`x-agora-* → x-pangolin-*`** — and it was applied correctly under `test/` but not under `packages/`,
which is exactly why `test/e2e/callback-signing-roundtrip.test.ts:200-202` carries the correct names
while the source does not. There is no naming decision to make.

**The two channels fail differently.** Lifecycle: `emit()` throws, `entrypoint.ts:163-170` catches and
logs `lifecycle.emit.failed`. Notifications: the throw lands inside `Promise.allSettled`
(`notifications.ts:91`) whose results are never inspected — **completely silent**.

**The rename is definitionally non-breaking.** Invalid names mean `fetch` throws before sending; no
receiver has ever received these headers. Confirmed: six occurrences in `src`, no other producer, and no
published doc names them.

### D2 — no HTTP status check

`lifecycle.ts:21-30` awaits `fetchFn(...)` and ignores the result. `fetch` does not reject on 4xx/5xx, so
once D1 is fixed a 500 neither throws nor logs and the worker proceeds as if delivery succeeded.

### D3 — no retry · D4 — no timeout

One attempt, no deadline. A briefly-unavailable receiver loses the event permanently; a receiver that
accepts the connection and never responds blocks the worker indefinitely. Without D4, retry only
multiplies the hang.

### D5 — the emitter is a hard no-op until step 4

`entrypoint.ts:150-154` constructs the emitter with `hmacKey: undefined`, and `lifecycle.ts:12` returns
immediately when **either** `callbackUrl` or `hmacKey` is falsy. The key is set only at `:271`. So every
`failWith` before that point attempts **no request at all**:

| Site | Reason | Today |
|---|---|---|
| `entrypoint.ts:205` | storage construction | no attempt |
| `:216` | adapter load | no attempt |
| `:224` | bundle fetch / integrity | no attempt |
| `:238` | invalid pipeline spec | no attempt |
| `:264` | callback key fetch | no attempt (unavoidable — the key is what failed) |

This falsifies the comment at `entrypoint.ts:147-149` — *"We resolve it lazily below so an integrity
failure on the very first bundle still surfaces."* It does not surface. And because no request is
attempted, no retry runs and no exhaustion occurs, so any delivery backstop built on D3 is structurally
unreachable on precisely these paths.

### D6 — no SIGTERM handler

`boundedAwaitExit` (`pangolin-client/src/bounded-await-exit.ts:23-63`) resolves a synthetic timeout exit
at the dispatch deadline and calls `compute.cancel`, which SIGTERMs with a **10 s grace**
(`providers-local-docker/src/index.ts:39-42`, `:219`). **`packages/pangolin-worker/src` has no SIGTERM
handler**, so Node's default terminates the process and any in-flight delivery is lost.

This also falsifies MVP §7.6, which claims the worker traps SIGTERM and emits `dispatch.cancelled`. It
never has — a second reason `dispatch.cancelled` never reaches a receiver, the first being that the
client emits it only to an in-process telemetry hook.

### 1.1 Why these survived — and what that means for ordering

`lifecycle.test.ts:83-89,119-120` and `notifications.test.ts:169-175` assert the header names **and
assert the misspelled ones**, passing because they inject a `fetchImpl` mock and read `init.headers` cast
to `Record<string,string>` (`notifications.test.ts:166`), where a space is an ordinary key.

**An injected-fetch mock that treats headers as a plain object is structurally incapable of catching an
invalid-header-name defect.** The tests did not miss the bug; they pinned it. §5 therefore requires a
change of *assertion style*, not of expected strings.

A consequence for planning: because the unit suite never validates header names, **D1 does not mask
D2–D6 in tests**, only in production. The six defects are independently orderable, and each one's test
can be written to fail against `main` without touching D1 first.

---

## 2. Design

### 2.1 Header names

Replace all six occurrences in `lifecycle.ts` and `notifications.ts` with `X-Pangolin-Signature`,
`X-Pangolin-Dispatch-Id`, `X-Pangolin-Timestamp`. The signature scheme is unchanged: lowercase hex
HMAC-SHA256 over `${dispatchId}.${timestamp}.${payload}`, prefixed `sha256=`.

**On the duplicated wire format.** `signCallback` already exists (`pangolin-client/src/callback-hmac.ts`)
and its docstring says it is *"exported so the worker can compute identical signatures"* — yet
`lifecycle.ts:17-19` and `notifications.ts:80-82` each hand-roll `createHmac`. Three copies, in a change
about wire-format drift. Consolidating means moving `signCallback` into `pangolin-core`, because
`pangolin-worker` does not depend on `pangolin-client` and `pnpm check:deps` fails on undeclared
specifiers. **That cross-package move is deliberately deferred**, and the duplication is accepted here on
one condition: §5.1 asserts the exact names *and* the signature construction in **both** worker files, so
drift between copies is caught by test rather than by incident. Logged for later consolidation.

### 2.2 Delivery semantics for the lifecycle callback

`LifecycleEmitter.emit` gains status checking, a per-attempt timeout, and bounded retry, and **returns a
`DeliveryOutcome`** — `{ delivered: boolean; attempts: number; lastStatus?: number; lastReason?: DeliveryFailureReason }`
— instead of resolving `void`. On `lastReason` see §4.

| Outcome | Treatment |
|---|---|
| 2xx | success |
| 5xx, 429, network error, timeout | retryable |
| other 4xx | **not** retryable — a contract error (bad auth, bad payload) |

3xx is not enumerated because `fetch` follows redirects by default; a redirect resolves to its final
status.

**Fixed constants, not configuration.** 3 attempts *total*, 5 s per-attempt timeout, exponential backoff
`1000 * 2 ** n` (1 s, then 2 s) with ±20 % jitter — worst case ≈ 18 s. **No environment knob is added.**
The worker's environment is minted by the client (`pangolin-client/src/dispatch.ts:255-296`), not by an
operator, so a `PANGOLIN_*` variable here would be a dead knob — exactly what
`PANGOLIN_SETUP_TIMEOUT_SECONDS` (`env-parser.ts:180-182`) already is, parsed and set by nothing. Making
the budget tunable is a change to pangolin-client's public dispatch options and belongs to whatever
consumer needs it. Jitter is included because N workers retrying one recovering receiver in lockstep is
the predictable failure mode of a fixed schedule.

The exponential shape matches the repo convention (`orchestrator/src/engine/tick.ts:35-37`). Three
hand-rolled retry loops already exist (`cmd-orch.ts:217-227`, `tick.ts:35-37`,
`storage-s3/src/index.ts:559-575`); this adds a fourth rather than extracting a shared helper — a
deliberate deferral. (`pangolin-core/src/bounded-command.ts` is **not** a candidate; it runs child
processes, not `fetch`.)

**Every attempt re-signs with a fresh timestamp.** MVP `:1087` requires integrators to *"reject events
older than 5 minutes for replay protection"*; replaying the original signed bytes would make a
backed-off retry fail exactly when it is needed. Consequence, stated as contract: **delivery is
at-least-once and the dedupe key is `(dispatchId, kind)`, not the signature.** Honest limit —
`dispatchId` is caller-supplied and unenforced, and the worker emits only four of the six kinds, so that
uniqueness is a property of how callers mint ids, not something this code guarantees.

### 2.3 Delivery coverage: resolve the key before it is needed

D5 is closed by **moving HMAC key resolution ahead of storage construction, bundle fetch, adapter load,
and pipeline-spec validation**, so the emitter is live before the first `failWith` that can fire. This is
what `entrypoint.ts:147-149` already claims. `env-parser.ts:173-177` makes `PANGOLIN_CALLBACK_TOKEN_REF`
mandatory whenever `PANGOLIN_CALLBACK_URL` is set, so the branch always runs when a callback is configured.

**The one path that stays silent, stated rather than implied:** a failure to fetch the key itself
(`:264`) cannot emit, because the key is the thing that failed. Irreducible without a second unsigned
channel, which is not proposed.

### 2.4 Surviving cancellation

Install a SIGTERM handler that aborts any in-flight retry schedule, makes **one** final delivery attempt
with a 2 s timeout, persists on failure (§2.5), and exits — all inside the 10 s grace. It also emits
`dispatch.cancelled`, which MVP §7.6 has always claimed and no code has ever done.

Without this, §2.2's budget and §2.5's durable record are both unreachable in the one scenario they exist
for: a dispatch cancelled at its deadline.

### 2.5 Durable record on failure — owned by the entrypoint, not the emitter

When `emit` returns `delivered: false`, **the entrypoint** writes the undelivered event to
`pangolin://<namespace>/dispatches/<dispatchId>/undelivered/<kind>.json` and logs a distinct line.

The emitter takes no `persistUndelivered` callback and no logger. It performs delivery and reports an
outcome; the entrypoint already owns storage, the `StructuredLogger`, and the `failWith` policy, and is
the right place for the decision. This keeps the emitter to one job and removes two injection seams an
earlier draft required. (Path shape verified constructible: `pangolin-core/src/uri.ts:212-234` permits
slash-bearing suffixes, and `output-sentinel.ts:236` already writes `dispatches/<id>/output.json`.)

**File body:** the `LifecycleEvent` plus the `DeliveryOutcome`, subject to §4.

**Scope of the promise: forensic, not reconciliation.** Nothing enumerates `undelivered/`, and a receiver
that never got `dispatch.started` has no `dispatchId` to look up. This makes the loss *discoverable by an
operator who knows the dispatch id*; it gives a receiver no discovery path, and retention belongs to the
storage backend (`pangolin-client/src/retention.ts:1-11`), not this code. A reconciliation consumer would
need a listing mechanism — out of scope.

### 2.6 Notifications

`fireNotifications` gets the header fix and **per-endpoint failure logging** — inspecting the
`Promise.allSettled` results at `notifications.ts:91` rather than discarding them. Like `emit`, it takes
no logger injection: it returns a per-endpoint outcome array the entrypoint logs.

It does **not** get retry. `notifications.ts:17-19` states the contract — best-effort, must not abort the
dispatch lifecycle — and it is fan-out to N third-party endpoints. One cost to state:
`entrypoint.ts:161-178` awaits the lifecycle delivery **before** firing notifications, so §2.2's budget
delays this advisory channel too.

---

## 3. Ordering and independence

D1–D6 are independently implementable and independently testable (§1.1). Two ordering constraints only:
§2.5's persistence needs §2.2's `DeliveryOutcome` to exist, and §2.4's handler needs something to abort.
Nothing requires D1 to land first.

---

## 4. Security posture

This change adds two new outbound surfaces — a **durable record in storage** and **more log lines** — and
must not weaken the posture in doing so. The governing precedent is `entrypoint.ts:186-189`:

> *"Keep the lifecycle event's `reason` to the canonical token … The long-form detail goes only into the
> worker log — that way redacted secrets in `detail` never get POSTed to a webhook."*

**That rule extends to the undelivered record.** `dispatches/<id>/undelivered/` sits in the same prefix a
consumer reads, so it is an *outbound* surface, not a log — and **storage writes get no automatic
redaction**; only `StructuredLogger` redacts (`logger.ts:9-10, 20-32`, fed the registered secret set at
`entrypoint.ts:376-378`). Therefore:

- **`DeliveryOutcome` carries no free text.** `lastReason` is a **closed enum** —
  `http-status | network | timeout | aborted` — never a `fetch` error string, which can embed the webhook
  URL. This mirrors the reason/detail split rather than inventing a new policy.
- **The persisted body contains the `LifecycleEvent` and the outcome, and nothing else.** The event's
  payload is already the redaction-safe shape that goes over the wire today.
- **Anything long-form goes only to the log**, where redaction applies automatically.
- **Webhook URLs are redacted before logging** — `logger.redactString` (`entrypoint.ts:511` shows the
  established pattern) — since a notification URL can carry a token in a query parameter.

**Surfaces this change does not alter:** retry sends the same signed payload N times, so it discloses
nothing new; the signature scheme, key custody, and replay window are untouched (§7.3); and the SIGTERM
handler's `dispatch.cancelled` carries only the canonical `LifecycleEvent` fields, like every other kind.

**Threat-model rows touched:** none negatively. This spec neither reads nor relocates credentials, so the
*Identity theft* row and its correction belong entirely to the sibling
`2026-07-23-patch-capture-env-scoping-design.md` §6. Worth stating explicitly so a reviewer does not
expect that correction here.

**One posture improvement worth naming:** today a notification webhook failure is *completely* silent
(`notifications.ts:91`). An operator cannot currently tell a delivering endpoint from a dead one, which
is itself a monitoring gap. §2.6 closes it.

---

## 5. Testing

Each test must fail against current `main` **by asserting** — not by failing to compile and not by
hanging. Where a new symbol makes compile-failure the only pre-fix outcome, that is called out.

1. **Header names, both files.** Construct a real `Headers` from the `init.headers` the emitter passes,
   assert construction succeeds, and assert the three names exactly. Also assert the signature equals a
   locally computed HMAC over `${dispatchId}.${timestamp}.${payload}` — in **both** `lifecycle.ts` and
   `notifications.ts` tests, which is what makes §2.1's accepted duplication safe. *(The test reconstructs
   a `Headers`; production is not required to pass a `Headers` instance.)*
2. **Non-2xx is a failure.** A 500 triggers retry and yields `delivered: false`; not treated as success.
3. **4xx does not retry.** A 403 is attempted exactly once.
4. **Retry re-signs.** Across attempts, timestamps differ and each attempt's signature verifies over
   *that attempt's* timestamp.
5. **Timeout aborts.** Assert the `fetch` init carries an `AbortSignal`, that a non-responding receiver
   yields a retryable attempt, and that elapsed time is bounded. Do **not** rely on the test timing out —
   against `main` that is a hang, not an assertion.
6. **Early failure emits.** With a callback configured, force a bundle-integrity failure and assert a
   `dispatch.failed` POST is attempted. Fails against `main` by assertion (zero attempts today), making
   this the cleanest discriminator for D5.
7. **SIGTERM flushes.** Deliver SIGTERM with a delivery in flight; assert one final attempt is made, that
   `dispatch.cancelled` is emitted, and that the undelivered record is written when that attempt fails.
8. **Exhaustion persists, redacted.** `emit` returns `delivered: false`, the entrypoint writes
   `undelivered/<kind>.json`, and — per §4 — assert the persisted body contains **no** free-text error and
   no webhook URL, with `lastReason` drawn from the closed enum. *(New symbols mean this cannot fail by
   assertion on `main`; test 2 is the discriminator that the outcome is computed at all.)*
9. **Notification failures are logged with the URL redacted, and a healthy endpoint in the same fan-out
   still receives its POST.**
10. **Existing tests updated in style, not just strings** — `lifecycle.test.ts` and
    `notifications.test.ts` move to the §5.1 style; every other assertion in them continues to pass.

---

## 6. Non-goals

- **Changing the signature scheme, payload, or replay window.** §7.3 is unchanged; this repairs its transport.
- **Retry for notification webhooks** — §2.6.
- **Consolidating `signCallback` into `pangolin-core`** — §2.1, deferred with a test-based mitigation.
- **A configurable retry budget** — §2.2; it would be a dead knob at this layer.
- **A reconciliation/discovery path for `undelivered/`** — §2.5.
- **Populating `dispatchLevelNotifications`.** `entrypoint.ts:158` declares it and never populates it, so
  the dispatch-level notification source documented at `notifications.ts:7-8` is dead — those webhooks
  never fire. A real defect in a file this change edits, but it is a *config-plumbing* gap needing the
  `DispatchWork.notifications` → worker path designed. **Logged separately.**
- **Any coupling to the ai-os P15 work.** The `callback.authTokenRef` addition that work needs also
  touches `lifecycle.ts`; it is deliberately not here and must sequence after this change.

---

## 7. Verification

Repo gate: `pnpm lint && pnpm typecheck && pnpm test`, plus `pnpm check:deps`.

**The e2e test must be made to run, not merely to pass.** `test/e2e/callback-signing-roundtrip.test.ts`
documents this exact contract (`:200-202`) but is `itIfDocker` (`:95`) and additionally needs a reachable
Secrets Manager (`:183-191`), so on Linux CI it **passes as skipped** (`:31-38`). A green `pnpm test:e2e`
is therefore compatible with the test never executing — which, together with its exclusion from the
default gate, is why the source/test mismatch survived this long. The PR must record a run in which it
actually executed, asserting the receiver observed at least two events.
