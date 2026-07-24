---
title: Callback Delivery Correctness — Design Spec (slice A of 3)
date: 2026-07-23
status: draft — plan-ready
branch: fix/callback-delivery-reliability
authors: [human:Brett, agent:claude-opus-4-8]
severity: high (every lifecycle and notification webhook currently fails before the request leaves the process)
related:
  - ./2026-05-21-agora-mvp-design.md # §7.3 signing + replay window; original X-Agora-* names
  - ./2026-07-23-callback-delivery-durability-design.md # slice B — consumes what this slice reports
  - ./2026-07-23-worker-termination-design.md # slice C — NOT designed; open questions only
  - ./2026-07-23-patch-capture-env-scoping-design.md # sibling child-0 change; no file overlap
---

# Callback Delivery Correctness — Design Spec (slice A of 3)

> **One line:** Every lifecycle and notification webhook Pangolin sends is **dead on arrival** — the
> header names contain a space and are rejected before the request leaves the process — and the path
> around them has no status check and no timeout. Fix the wire, bound it, and make the outcome
> **reportable**. Delivery stays **at-most-once by design** (§2.2.1). Acting on that outcome is slice B;
> surviving cancellation is slice C.

**Why this is a slice.** The original single spec funnelled six defects, a new deps seam, a signal
handler, a function extraction, and a control-flow move into one task owning `entrypoint.ts:150-179` — a
single-lane plan in DAG clothing. This slice is the part that is **independently shippable and touches
no control flow**: widening `emit`'s return type is source-compatible at all six call sites, and the
entrypoint already discards `fireNotifications`' result, so nothing outside these four files changes.
It is also the slice that turns the channel back on, without which every other item is unobservable.

---

## 1. The defects

### D1 — invalid header names (the whole channel is dead)

`lifecycle.ts:25-27` and `notifications.ts:86-88` send `'X-Pangolin Scale-Signature'`,
`'X-Pangolin Scale-Dispatch-Id'`, `'X-Pangolin Scale-Timestamp'`. A space is not valid in an HTTP field
name (RFC 9110 §5.1). Reproduced on Node v22.20.0: `TypeError: Headers.append: "X-Pangolin
Scale-Signature" is an invalid header name`. The request is never sent.

**The repo already holds the correct names.** The original design specifies `X-Agora-Signature` /
`-Dispatch-Id` / `-Timestamp` (`2026-05-21-agora-mvp-design.md:1080-1082`); commit `37b19af` substituted
`Agora` → `Pangolin Scale`, and **its own message states the intended mapping as `x-agora-* →
x-pangolin-*`** — applied under `test/` but not `packages/`, which is why
`test/e2e/callback-signing-roundtrip.test.ts:210-212` asserts `post.headers['x-pangolin-signature']`
while the source sends something else.

**Definitionally non-breaking:** invalid names mean `fetch` throws before sending, so no receiver has
ever received these headers. **Exactly six occurrences in `src`** — three at `lifecycle.ts:25-27`, three
at `notifications.ts:86-88` — no other producer, no published doc.

> **Path-scope every replacement to `packages/` and `test/`.** The working tree carries four stale
> source copies under `.claude/worktrees/` (`agent-a758713d7d25e656b`, `agent-a9bbc36e043575237`,
> `agent-af642df0583932d68`, `secret-handling-hardening`), so a repo-wide grep returns **17 hits across
> 30 files** rather than 6 in 2. An instruction to "replace all occurrences" without a path scope will
> have someone editing worktree copies and reporting a false completion.

**The two channels fail differently.** Lifecycle: `emit()` throws and `entrypoint.ts:163-170` logs it.
Notifications: the throw lands inside `Promise.allSettled` (`notifications.ts:91`) whose results are
never inspected — **completely silent**.

### D2 — no HTTP status check

`lifecycle.ts:21-30` awaits `fetchFn(...)` and ignores the result. `fetch` does not reject on 4xx/5xx,
so once D1 is fixed a 500 is indistinguishable from success.

### D3 — no retry — **WITHDRAWN, this is not a defect**

An earlier draft listed "one attempt, a briefly-unavailable receiver loses the event" as a defect and
specified bounded retry with exponential backoff. **That was wrong on Pangolin's own terms and is
withdrawn.** The number is kept rather than reused so sibling specs referencing D4–D6 stay stable, and so
nobody re-adds retry later believing it was an oversight. The reasoning is in §2.2.1.

*(Numbering note: this section defines D1–D4 only. **D5** — the emitter's keyless window — and **D6** —
SIGTERM handling — belong to slices B and C and are described where they are deferred, in §5. They are
listed here so the numbering is not mistaken for a gap.)*

### D4 — no timeout

No deadline on any outbound request. A receiver that accepts the connection and never responds blocks the
worker indefinitely.

**This applies to both channels, and the fan-out is the worse one.** `fireNotifications` awaits
`Promise.allSettled` over N **third-party** endpoints (`notifications.ts:91-99`) with no `AbortSignal`, so
one hung endpoint the operator does not control stalls the dispatch. An unbounded wait in the worker is a
liveness defect in the execution mechanism, which is the worker's own remit — so both channels get a
per-attempt timeout in §2.2/§2.3. An earlier draft gave the timeout only to `emit`; the asymmetry was
unintentional.

### 1.1 Why these survived

`lifecycle.test.ts:83-89,119-120` and `notifications.test.ts:169-175` assert the header names **and
assert the misspelled ones**, passing because they inject a `fetchImpl` mock and read `init.headers` cast
to `Record<string,string>` (`notifications.test.ts:166`), where a space is an ordinary key.

**An injected-fetch mock that treats headers as a plain object is structurally incapable of catching an
invalid-header-name defect.** The tests did not miss the bug; they pinned it. §4 therefore requires a
change of *assertion style*, not of expected strings.

Because the unit suite never validates header names, D1 does not mask D2–D4 **in tests** — only in
production — so each defect's test can be written to fail against `main` independently.

---

## 2. Design

### 2.1 Header names

Replace all six occurrences with `X-Pangolin-Signature`, `X-Pangolin-Dispatch-Id`,
`X-Pangolin-Timestamp`. Signature scheme unchanged: lowercase hex HMAC-SHA256 over
`${dispatchId}.${timestamp}.${payload}`, prefixed `sha256=`.

**On the duplicated wire format.** `signCallback` exists (`pangolin-client/src/callback-hmac.ts`) and its
docstring says it is *"exported so the worker can compute identical signatures"*, yet `lifecycle.ts:17-19`
and `notifications.ts:80-82` each hand-roll `createHmac`. Consolidating means moving `signCallback` into
`pangolin-core`, because `pangolin-worker` does not depend on `pangolin-client` and `pnpm check:deps`
fails on undeclared specifiers. **Deferred**, with the mitigation stated honestly: asserting the
construction in both worker test files covers **2 of the 3 pairwise drifts**. Drift against
`pangolin-client`'s copy — the one the *receiver* side uses — is guarded only by the e2e, which §6
establishes has never executed. A real residual, not a closed one.

### 2.2 Delivery semantics for the lifecycle callback

`LifecycleEmitter.emit` gains status checking and a per-attempt timeout, and **returns a
`DeliveryOutcome`** instead of `Promise<void>`. It makes **one attempt**:

```ts
type DeliveryFailureReason = 'http-status' | 'network' | 'timeout';
interface DeliveryOutcome {
  delivered: boolean;
  status?: number;
  reason?: DeliveryFailureReason; // closed enum — never a fetch error string (§3)
}
```

There is no `attempts` field: at most-once makes it always 0 or 1 and readable from `delivered` plus
whether the emitter was configured. `'aborted'` is absent because worker-level cancellation is slice C's
scope, and this slice must not pre-declare a reason nothing can produce.

Both types live in the worker's `lifecycle.ts`; nothing crosses a package boundary. Verified
source-compatible: all six call sites (`entrypoint.ts:164` and five in `lifecycle.test.ts`) `await` and
discard, so widening the return type breaks nothing and **this slice does not edit `entrypoint.ts`**.

Classification reads **`response.status`**, not `response.ok`:

| Status | Treatment |
|---|---|
| 2xx | `delivered: true` |
| any non-2xx | `delivered: false`, `reason: 'http-status'`, `status` recorded |
| fetch rejects | `delivered: false`, `reason: 'network'` |
| per-attempt timeout fires | `delivered: false`, `reason: 'timeout'` |

3xx is not enumerated because `fetch` follows redirects by default. **Nothing distinguishes 5xx from
other 4xx**, because that distinction existed only to decide what to retry — with no retry, a failure is
a failure and the `status` is reported verbatim for the consumer to interpret.

> **Consequence §4.7 owns:** the three existing mocks that invoke fetch resolve `{ ok: true }` with **no
> `status`** (`lifecycle.test.ts:58, :97, :128` — exactly three repo-wide). A status-based implementation
> reads `undefined` and silently reports `delivered: false`. **This does not break those tests** — they
> `await emitter.emit(event)` and discard the result, asserting only on `mockFetch.mock.calls[0]`
> (measured, not assumed). They must still gain `status: 200`, so the fixtures stop modelling a state the
> production path can no longer produce. `notifications.test.ts` returns real `new Response('ok')` and is
> unaffected.

**No per-kind policy.** Every kind — `accepted`, `started`, and the four terminal kinds — is one attempt
on one path. An earlier draft carved `dispatch.started` out as fire-and-forget while giving terminal
kinds a retry budget; with retry gone the distinction dissolves, and with it the need to define an arm
for `dispatch.accepted` (client-side-only in production, but passed to `emit` in
`lifecycle.test.ts:24-30, :44-50`). One code path, no kind-dependent branching.

**The timeout is a default with an injectable override — not a fixed constant, and not an env knob.**
Default 5 s per attempt, as an optional constructor option alongside the existing `fetchImpl`, mirroring
the established pattern at `orchestrator/src/engine/tick.ts:22` (`backoffMs?: (n: number) => number`,
defaulted at `:37`). Two nearby alternatives are wrong:

- **An env knob would be dead.** The worker's environment is minted by the client
  (`pangolin-client/src/dispatch.ts:255-296`), not an operator — `PANGOLIN_SETUP_TIMEOUT_SECONDS` is the
  precedent: consumed at `entrypoint.ts:426`, produced by nothing.
- **A client-side dispatch option would be building ahead of demand**, against the ROADMAP's
  pull-don't-schedule discipline. Add it when a consumer asks.

The override seam is also the **test seam** — §4.5b needs the timeout injectable because the worker
package has no `vitest.config.ts` and runs at vitest's 5 s default `testTimeout`; a real 5 s abort inside
a 5 s budget is a coin flip.

### 2.2.1 Why there is no retry — and why that is the stronger design

**Nothing inside Pangolin consumes the callback.** Verified by scoped grep across `packages/*/src`: the
only code touching `callbackUrl` is the client minting the env var (`pangolin-client/src/dispatch.ts:281`),
the worker parsing it (`env-parser.ts:171`), and the worker sending it. There is no receiver anywhere in
the repo. The orchestrator learns a dispatch finished by **polling** — `Executor.reconcile(dispatchHash)`
at `engine/tick.ts:90`, where `null` means still running (`contracts/executor.ts:4`). The webhook is pure
egress to an external party and Pangolin's own control flow never reads it.

So a retry loop here serves no Pangolin consumer — only an external one. Three consequences settle it:

1. **Tier — this argument does NOT settle it, and is recorded so nobody re-runs it.** The intuitive case
   ("backoff is policy, policy is `pangolin-orchestrator`, which already owns `maxAttempts`/`backoffMs`
   at `engine/tick.ts:22`") **fails on inspection**, three ways. `pangolin-core/src/channel.ts:8` states
   the opposite doctrine in the trust root itself — *"Adapters own backoff, reconnection, and cursor
   management internally"* — so transport-level backoff is explicitly delegated **down** to the mechanism
   owning the wire. `pangolin-storage-s3/src/index.ts:559-575` is the working precedent: a mechanism tier
   owning a bounded exponential-backoff loop over its own outbound I/O, routed through no orchestrator.
   And `tick.ts`'s backoff feeds exactly one call — `store.requeue(...)` — so it governs *re-admission of
   a work item to a queue*, a different object entirely from one HTTP frame. Decisively, the orchestrator
   **cannot see this channel**: `PANGOLIN_CALLBACK_URL` is minted by the client
   (`pangolin-client/src/dispatch.ts:281`) and handed to the worker, so hoisting would mean inventing a
   callback-delivery queue nobody has asked for. **If retry belonged anywhere, the worker is the right
   tier.** The case against it rests entirely on 2 and 3 below.
2. **It cannot work anyway.** Worker-side retry cannot outlive the worker. A terminal event that
   exhausts its budget is gone permanently — the container exits and nothing remains to retry from. A
   consumer that reconciles has no such ceiling: it survives its own restarts, works when the worker is
   long dead, and does not depend on the webhook ever having functioned. Retry here would buy resilience
   against a receiver being down for roughly seven seconds, and nothing else.
3. **Positioning.** Retrying a webhook toward a delivery guarantee treats the webhook as the guarantee.
   That is durable-message-delivery, a lane this project explicitly walks away from — *durable ≠
   provable*. The run is already reconcilable and the sealed bundle is already the record.

**Therefore delivery is at-most-once, by design.** The recovery path for a lost callback is
`reconcile(dispatchHash)`, available to any consumer holding the handle returned by `dispatch.fire()`.
This slice's job is to make the attempt correct, bounded, and honestly reported — not to guarantee it
lands.

Because there is no retry, nothing re-signs: one signature over one timestamp per event. The
at-least-once contract and its `(dispatchId, kind)` dedupe-key caveat, which an earlier draft required,
are both withdrawn along with the retry loop.

### 2.3 Notifications

`fireNotifications` gets the header fix, **status classification**, and **returns a per-endpoint outcome
array** instead of `Promise<void>`.

Status classification is required, not optional: `Promise.allSettled` marks a fetch returning HTTP 500 as
`fulfilled`, so inspecting settled results alone would leave a 500-returning endpoint **completely
silent** — the most common dead-endpoint mode.

It does **not** get retry — for the same reasons as §2.2.1, plus the one stated at `notifications.ts:17-19`:
best-effort, must not abort the dispatch lifecycle, fan-out to N third-party endpoints.

**It does get the same per-attempt timeout**, via an `attemptTimeoutMs?: number` option defaulting to
5 s, applied as an `AbortSignal` on each fan-out `fetch` (`notifications.ts:93`). This closes D4 on the
channel where it matters most: `fireNotifications` is awaited at `entrypoint.ts:172` on every terminal
path, so one unresponsive third-party endpoint currently hangs the dispatch forever.

**`NotificationOutcome.reason` reuses `DeliveryFailureReason`** rather than declaring its own union.
An earlier draft gave notifications a narrower union on the grounds that a channel with no retry and no
timeout could never produce `'timeout'` — adding the timeout above dissolves that reasoning, and the two
unions are now member-for-member identical. Two structurally identical unions exported from the same
barrel under different names would drift; `notifications.ts` imports the type from `./lifecycle.js`.
(`DeliveryOutcome` and `NotificationOutcome` remain distinct — different shapes, one carries a label.)

**Classifying `'timeout'` must not be mock-shaped.** A real `fetch` aborted by
`AbortSignal.timeout(n)` rejects with a `DOMException` whose `name` is `TimeoutError`, and — the
mock-independent part — the signal's `.aborted` is `true` at catch time. Classify on **`signal.aborted`**,
not on the error's name or message, so a hand-rolled mock rejecting with `new Error('aborted')` cannot
pin the wrong branch. Any test mock must reject only after observing the `abort` event on the `signal` it
was handed.

**Return shape on the early paths must be stated**, because an existing test asserts against it
(`notifications.test.ts:219-225` currently expects `resolves.toBeUndefined()`): the zero-match
early-return (`notifications.ts:76`) and the empty-sources path both return **`[]`**, not `undefined`.
§4.7 owns updating that assertion.

**This slice reports; slice B logs.** `fireNotifications` returns outcomes and `emit` returns a
`DeliveryOutcome`; the entrypoint's consumption of both — logging and persistence — is slice B, because
that is where `entrypoint.ts` is edited. The monitoring gap is therefore *closed by A + B together*, and
A alone does not claim to close it.

### 2.4 Safe endpoint labelling

Outcomes carry a **label**, never the raw webhook URL. The label is produced by a pure, never-throwing
helper:

```ts
export function safeEndpointLabel(webhook: string, index: number): string;
```

- `http`/`https` and parseable → the origin (`new URL(w).origin` — verified to strip userinfo, so
  `https://u:p@h.example.com/a?t=1` → `https://h.example.com`).
- Anything else → `notification[<index>] <unparseable>`.

**This helper exists because the naive form throws on ordinary input.** `new URL(u).origin` raises
`ERR_INVALID_URL` for `not-a-url`, `""`, and `//example.com/x`, and yields the literal string `"null"`
for `file:`/`data:`. `NotificationConfig` is `{ when, webhook: string }`
(`pangolin-core/src/dispatch.ts:26-29`) with **no validation anywhere** —
`loadCapabilityNotifications` is a bare `JSON.parse(raw) as NotificationConfig[]`
(`notifications.ts:44`). So a typo'd webhook in a capability's `pangolin-notifications.json` makes
`fetch` throw, which becomes a `network` outcome, and formatting that outcome would throw again —
inside `fireNotifications`, violating its documented never-throws contract, or in the entrypoint,
converting a dead webhook into a **worker crash**.

The index is carried because it disambiguates two endpoints reported in the same fan-out, carries zero
credential risk, and because an opaque-origin scheme would otherwise label every endpoint `"null"`.

**It is a position within the fan-out, not a position in the operator's config file.** `matches`
(`notifications.ts:67-74`) is the flattened merge of *both* sources — capability-content and
dispatch-level — then filtered by `when.includes(event.kind)`. Index 2 in `matches` is therefore index 2
in no file the operator has. An earlier draft claimed the index was *"unambiguous for an operator reading
their own config"*; **that is false and is withdrawn** — the index disambiguates entries within one
reported fan-out and nothing more. Carrying a genuine `(sourceIndex, configIndex)` pair would be
config-locatable and is deliberately **not** done: it widens the outcome shape for a diagnostic no
consumer has asked for. The signature and label format are unchanged.

---

## 3. Security posture

The path gains no new outbound surface in this slice — it repairs one — but the reported outcome will be
logged and persisted downstream, so it must be safe to hand on. The governing precedent is
`entrypoint.ts:186-189`: canonical `reason` over the wire, long-form detail only to the log.

- **`DeliveryOutcome` carries no free text.** `reason` is a closed enum; a `fetch` error string can
  embed the webhook URL.
- **No raw URL leaves this module.** Outcomes carry `safeEndpointLabel` output (§2.4).
- `redactString` **cannot** help here — it replaces *registered* secrets by substring
  (`logger.ts:20-32`, set registered at `entrypoint.ts:269, :362, :370, :393`), and no webhook URL is
  ever registered, so it would return the URL verbatim. Registering URLs as secrets would redact them
  from every existing log line and pipeline artifact — far too wide.
- **Unchanged:** one signed payload per event, sent once; the signature scheme, key custody, and replay
  window are untouched. With no retry there is no re-signing and no replay-window interaction at all.

Slice B owns the posture of the *persisted record* and the *log lines*; this slice owns making the value
they receive safe.

---

## 4. Testing

Each test covering a **pre-existing** code path must fail against `main` **by asserting** — not by
hanging, and not merely by throwing. **One** honest exemption: `safeEndpointLabel`'s tests import a
module that does not exist on `main`, so they can only fail at import.

The header test is **not** an exemption, contrary to an earlier draft: `expect(fn).not.toThrow()` catches
the `TypeError` and converts it into an `AssertionError` (measured — vitest reports *"expected [Function]
to not throw an error but 'TypeError: Headers.append: …' was thrown"*). It fails by asserting, as
required.

**Assert on the returned outcome object, never on call count alone.** `main`'s `emit` already makes
exactly one attempt for every status (`lifecycle.ts:11-31`), so any criterion of the form "attempted
exactly once" is **green on `main`** and proves nothing. Every delivery test asserts the outcome; call
count is a supplementary check, never the discriminator.

1. **Header names, both files.** Assert `new Headers(init.headers as HeadersInit)` does **not** throw,
   then assert the resulting key set for equality. The `.not.toThrow()` is the discriminator against
   `main`; the key-set equality is its positive control, so the pair cannot pass vacuously. Also assert
   the signature equals a locally computed HMAC — in **both** worker test files, which is what makes
   §2.1's accepted duplication safe.

   **Production keeps passing a plain object, deliberately.** Building a real `Headers` in production was
   considered and rejected: `Headers` validates header *values* as well as names, and `dispatchId` is a
   caller-supplied string that nothing character-validates (`env-parser.ts:75` checks presence only;
   `uri.ts:216-224` rejects only empty and `/`). Constructing it eagerly would turn a malformed
   `dispatchId` into a throw that escapes `fireNotifications` *before* `Promise.allSettled` and reaches
   `entrypoint.ts:172`, which awaits it with no `try/catch` — converting a currently-swallowed failure
   into a worker crash, and violating the never-throws contract at `notifications.ts:17-19`.

   Keeping the plain object also keeps this assertion **permanently live**: the test constructs `Headers`
   from whatever production actually passed, so a header added later with an invalid name fails this test
   without anyone writing a new one. Had production passed a `Headers` instance, the assertion would have
   been inert from its first green run, because a `Headers` instance cannot carry an invalid name.

   Residual, logged rather than fixed here: `dispatchId` is not validated for header-safety anywhere.
   Tracked as its own `agora` task; out of scope for this slice, whose consumers supply uuids.
2. **Non-2xx is a failure.** A 500 yields exactly `{ delivered: false, status: 500, reason: 'http-status' }`.
   On `main` this fails by asserting (`undefined` vs the object), not by throwing. A 403 yields the same
   shape with `status: 403` — no status-dependent branching remains, and the test exists to pin that.
3. **A rejecting fetch is `'network'`.** Yields `{ delivered: false, reason: 'network' }` with no `status`.
4. **Every kind takes one code path.** `dispatch.started`, `dispatch.accepted`, and a terminal kind
   against the identical 500 mock all yield the identical outcome shape. This pins the *absence* of
   per-kind policy, so a future reader does not reintroduce a budget for terminal kinds by accident.
5. **Timeout**, split because the whole cannot discriminate on `main`:
   **5a** — assert the `fetch` init carries an `AbortSignal`; fails by assertion today (none is passed).
   **5b** — a receiver settling only on abort yields `{ delivered: false, reason: 'timeout' }`, with the
   timeout injected to a small value. Classification is on **`signal.aborted`** (§2.3), and the mock must
   reject only after observing the `abort` event on the signal it was handed — a mock that rejects with a
   hand-written `Error('aborted')` would pin the wrong branch and is exactly the mock-shaped defect this
   spec exists to prevent. Post-fix only; explicitly **not** part of the pre-fix bar.
6. **`fireNotifications` returns per-endpoint outcomes**, a healthy endpoint in the same fan-out still
   receives its POST, and a 500-returning endpoint is reported failed rather than settled-ok. Assert
   positively that no returned label contains userinfo or a query token from a webhook given both.

   **Per-fetch signals are proved by identity, not by wall clock.** Assert that every `fetch` in one
   fan-out received a *distinct* `AbortSignal` — capture `init.signal` from each call and assert
   `signals[0] !== signals[1]`. A shared signal fails that by assertion, deterministically, with no timer
   involved.

   > **Do not attempt to prove it with timing.** An earlier draft required a slow-but-successful sibling
   > (`attemptTimeoutMs: 30`, sibling settling at 60 ms) asserted to still deliver, on the theory that a
   > shared signal would cross-abort it. **Measured on Node v22.20.0 over five runs: it cannot
   > discriminate.** All fan-out fetches launch in one synchronous `matches.map(...)`, so N
   > `AbortSignal.timeout(30)` instances and one shared `AbortSignal.timeout(30)` fire at the *same
   > instant*. If the sibling's mock honours the signal it was handed, it reports `'timeout'` under
   > **both** implementations — the criterion is unsatisfiable. If it ignores the signal, it reports
   > `delivered: true` under **both** — the criterion is vacuous. There is no third outcome.
   > `AbortSignal.timeout` cannot cross-abort; that would require a shared `AbortController` aborted on
   > first failure, which is not the implementation at issue.

   **Timeout classification is a separate, deterministic case.** With `attemptTimeoutMs: 20`, an endpoint
   whose mock rejects **only after observing the `abort` event on the signal it was handed** is reported
   `{ delivered: false, reason: 'timeout' }`, while a sibling resolving immediately with 200 is
   `{ delivered: true, status: 200 }`. Classification is on `signal.aborted` — never on the error's name
   or message. A mock rejecting with a hand-written `Error('aborted')` must land on `'network'`, and this
   test exists to pin exactly that.
7. **Existing tests updated in style and in fixtures.** `lifecycle.test.ts` and `notifications.test.ts`
   move to the test-1 assertion style; the three `{ ok: true }` mocks in `lifecycle.test.ts:58, :97,
   :128` gain `status: 200` (a status-classifying `emit` reads `undefined` from them and would report
   `delivered: false`); and `notifications.test.ts:219-225`'s `resolves.toBeUndefined()` becomes the `[]`
   contract from §2.3.
8. **`safeEndpointLabel` never throws** for `not-a-url`, `""`, `//example.com/x`, `file:///etc/passwd`,
   `data:text/plain,hi`; strips userinfo from `https://u:p@h/a?t=1`; preserves a non-default port; and
   returns an index-bearing label for every unparseable case. Include at least one input that succeeds,
   so "never throws" has a positive control.

---

## 5. Non-goals

- **D5 — the emitter's keyless window** (`entrypoint.ts:150-154` constructs it with `hmacKey: undefined`,
  so the five earliest `failWith` sites attempt nothing). Slice B.
- **Retry, on either channel — permanently, not pending.** At-most-once is the design (§2.2.1), not a
  gap. Do not reintroduce it later as an oversight fix. If a consumer ever genuinely pulls at-least-once
  delivery, the shape to reach for is *not* a loop in the worker — the worker cannot outlive its own
  container — but a consumer that reconciles, which already works today.
- **Logging** of the outcomes this slice returns. Slice B. *Note for slice B's design:* with delivery now
  at-most-once, **persistence of undelivered events** needs re-justifying before it is built — a durable
  store of pending deliveries is a delivery-guarantee mechanism, which §2.2.1 rejects. Logging the
  outcome is not in question; a pending-delivery store is.
- **D6 — SIGTERM handling.** Slice C, which is not designed. `'aborted'` is deliberately absent from
  `DeliveryFailureReason` until slice C has something that produces it.
- Consolidating `signCallback` into `pangolin-core` (§2.1).
- A client-side or environment-based delivery knob (§2.2).
- **Populating `dispatchLevelNotifications`** — `entrypoint.ts:158` declares it and never populates it,
  so the source documented at `notifications.ts:7-8` is dead. Logged as its own `agora` task.
- Any coupling to the ai-os P15 work; `callback.bearerRef` also touches `lifecycle.ts` and must
  sequence after this change.

**Shipping constraint — A alone makes the lifecycle channel quieter, not louder.** `entrypoint.ts:163-170`
wraps `lifecycleEmitter.emit(event)` in a `try/catch` that logs `lifecycle.emit.failed`. Today that fires
on *every* dispatch, because D1 makes `emit` throw every time. Once `emit` catches its own network and
status failures and returns an outcome instead, **that `catch` becomes unreachable and the log line dies**
— and since this slice deliberately does not edit `entrypoint.ts`, nothing consumes the returned outcome
until slice B. So A converts a loud-but-always-failing channel into a working-but-silent-on-failure one:
a net improvement in delivery, a regression in observability. **A is independently *mergeable* but should
not reach production without B.** Stated here because §2.3's "A alone does not claim to close the
monitoring gap" understates it.

---

## 6. Verification

Repo gate: `pnpm lint && pnpm typecheck && pnpm test`, plus `pnpm check:deps`.

**Two e2e tests should be made to run, and it is out of this slice's scope to fund that.**

- `test/e2e/callback-signing-roundtrip.test.ts` — the lifecycle channel. Documents this contract
  (`:210-212`) but is `itIfDocker` and needs a reachable Secrets Manager, so on Linux CI it **passes as
  skipped**.
- `test/e2e/notification-fanout.test.ts` — the **notifications** channel, and its **only** end-to-end
  guard. Both cases are `itIfDocker` (`:88`, `:210`) with the same host-reach caveat recorded in its own
  header (`:36`). It already asserts the correct lowercase names (`:182-184`, `:192`), which further
  corroborates the `37b19af` provenance story.

A green `pnpm test:e2e` is compatible with **neither** having executed, which is why the source/test
mismatch survived. Making them run also requires the e2e helper to pass `extraHosts` (a supported
provider option, `providers-local-docker/src/index.ts:85-91,:133`; the test comment claiming otherwise is
stale) and a chosen Secrets Manager environment (real or LocalStack — neither is selected). Both are
unowned by any slice. **Tracked as its own task.**

**Note which channel is the riskier one.** Notifications fail *completely silently* today (§1's throws
land in `Promise.allSettled` and are never inspected), yet under a gate naming only the roundtrip test,
the notifications half of D1 would ship guarded by §4.1's reconstructed-`Headers` assertion and §4.7's
mocked-fetch check — and §1.1's own argument is that an injected-fetch mock is *structurally incapable*
of catching an invalid-header-name defect. If only one e2e can be made to run, it should be
`notification-fanout`, not the roundtrip. This is also §2.1's only guard on the third `signCallback`
drift.
