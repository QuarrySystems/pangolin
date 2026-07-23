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
> around them has no status check, no retry, and no timeout. Fix the wire and make the outcome
> **reportable**. Acting on that outcome is slice B; surviving cancellation is slice C.

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
ever received these headers. Six occurrences in `src`, no other producer, no published doc.

**The two channels fail differently.** Lifecycle: `emit()` throws and `entrypoint.ts:163-170` logs it.
Notifications: the throw lands inside `Promise.allSettled` (`notifications.ts:91`) whose results are
never inspected — **completely silent**.

### D2 — no HTTP status check

`lifecycle.ts:21-30` awaits `fetchFn(...)` and ignores the result. `fetch` does not reject on 4xx/5xx,
so once D1 is fixed a 500 is indistinguishable from success.

### D3 — no retry · D4 — no timeout

One attempt, no deadline. A briefly-unavailable receiver loses the event; a receiver that accepts the
connection and never responds blocks the worker indefinitely.

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

`LifecycleEmitter.emit` gains status checking, a per-attempt timeout, and bounded retry, and **returns a
`DeliveryOutcome`** instead of `Promise<void>`:

```ts
type DeliveryFailureReason = 'http-status' | 'network' | 'timeout' | 'aborted';
interface DeliveryOutcome {
  delivered: boolean;
  attempts: number;
  lastStatus?: number;
  lastReason?: DeliveryFailureReason; // closed enum — never a fetch error string (§3)
}
```

Both types live in the worker's `lifecycle.ts`; nothing crosses a package boundary. Verified
source-compatible: all six call sites (`entrypoint.ts:164` and five in `lifecycle.test.ts`) `await` and
discard, so widening the return type breaks nothing and **this slice does not edit `entrypoint.ts`**.

Classification reads **`response.status`**, not `response.ok`:

| Status | Treatment |
|---|---|
| 2xx | success |
| 5xx, 429, network error, timeout | retryable |
| other 4xx | **not** retryable — a contract error (bad auth, bad payload) |

3xx is not enumerated because `fetch` follows redirects by default.

> **Consequence §4.8 owns:** the three existing mocks that invoke fetch resolve `{ ok: true }` with **no
> `status`** (`lifecycle.test.ts:58, :97, :128` — exactly three repo-wide). A status-based implementation
> sees `undefined`, matching no row, so those tests would retry and break their
> `toHaveBeenCalledOnce()` assertions. They must gain `status: 200`. `notifications.test.ts` returns real
> `new Response('ok')` and is unaffected.

**Per-kind policy.** The four terminal kinds — `finished`, `failed`, `needs_input`, `cancelled` — get the
full budget. **`dispatch.started` is fire-and-forget**: one attempt, outcome returned, no retry. It is
awaited at `entrypoint.ts:279` *before* overlay, setup, and the pipeline, so a budget there would stall
every dispatch behind a down receiver before any work begins; losing it is recoverable because the
terminal event carries the same `dispatchId`. **`dispatch.accepted` is treated as `started`** (one
attempt) — it is client-side-only in production but *is* passed to `emit` in `lifecycle.test.ts:24-30,
:44-50`, so the default arm must be defined rather than left to two engineers' judgment.

**Defaults with injectable overrides — not fixed constants, and not an env knob.** Defaults: 3 attempts
total, 5 s per-attempt timeout, exponential backoff `1000 * 2 ** n` with ±20 % jitter. All three are
optional constructor options alongside the existing `fetchImpl`, mirroring the established pattern at
`orchestrator/src/engine/tick.ts:22` (`backoffMs?: (n: number) => number`, defaulted at `:37`).

This shape is deliberate, and two nearby alternatives are wrong:
- **An env knob would be dead.** The worker's environment is minted by the client
  (`pangolin-client/src/dispatch.ts:255-296`), not an operator — `PANGOLIN_SETUP_TIMEOUT_SECONDS` is the
  precedent: consumed at `entrypoint.ts:426`, produced by nothing.
- **A client-side dispatch option would be building ahead of demand**, against the ROADMAP's
  pull-don't-schedule discipline. Add it when a consumer asks.

The override seam is also the **test seam** — §4.5b needs the per-attempt timeout injectable, not just
the backoff, because the worker package has no `vitest.config.ts` and runs at vitest's 5 s default
`testTimeout`; a real 5 s abort inside a 5 s budget is a coin flip.

This is a fourth hand-rolled retry loop alongside `cmd-orch.ts:217-227`, `tick.ts:35-37`, and
`storage-s3/src/index.ts:559-575`; extracting a shared helper is deferred. (`bounded-command.ts` is not a
candidate — it runs child processes, not `fetch`.)

**Every attempt re-signs with a fresh timestamp.** MVP `:1087` requires integrators to *"reject events
older than 5 minutes"*; replaying the original bytes would make a backed-off retry fail when most
needed. Contract consequence: **delivery is at-least-once and the dedupe key is `(dispatchId, kind)`.**
Honest limit — `dispatchId` is caller-supplied and unenforced, so that uniqueness is a property of how
callers mint ids, not something this code guarantees.

### 2.3 Notifications

`fireNotifications` gets the header fix, **status classification**, and **returns a per-endpoint outcome
array** instead of `Promise<void>`.

Status classification is required, not optional: `Promise.allSettled` marks a fetch returning HTTP 500 as
`fulfilled`, so inspecting settled results alone would leave a 500-returning endpoint **completely
silent** — the most common dead-endpoint mode.

It does **not** get retry. `notifications.ts:17-19` states the contract — best-effort, must not abort the
dispatch lifecycle — and it is fan-out to N third-party endpoints.

**Return shape on the early paths must be stated**, because an existing test asserts against it
(`notifications.test.ts:219-225` currently expects `resolves.toBeUndefined()`): the zero-match
early-return (`notifications.ts:76`) and the empty-sources path both return **`[]`**, not `undefined`.
§4.8 owns updating that assertion.

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

The index is carried because it is unambiguous for an operator reading their own config and carries zero
credential risk, and because an opaque-origin scheme would otherwise label every endpoint `"null"`.

---

## 3. Security posture

The path gains no new outbound surface in this slice — it repairs one — but the reported outcome will be
logged and persisted downstream, so it must be safe to hand on. The governing precedent is
`entrypoint.ts:186-189`: canonical `reason` over the wire, long-form detail only to the log.

- **`DeliveryOutcome` carries no free text.** `lastReason` is a closed enum; a `fetch` error string can
  embed the webhook URL.
- **No raw URL leaves this module.** Outcomes carry `safeEndpointLabel` output (§2.4).
- `redactString` **cannot** help here — it replaces *registered* secrets by substring
  (`logger.ts:20-32`, set registered at `entrypoint.ts:269, :362, :370, :393`), and no webhook URL is
  ever registered, so it would return the URL verbatim. Registering URLs as secrets would redact them
  from every existing log line and pipeline artifact — far too wide.
- **Unchanged:** retry sends the same signed payload N times and discloses nothing new; the signature
  scheme, key custody, and replay window are untouched.

Slice B owns the posture of the *persisted record* and the *log lines*; this slice owns making the value
they receive safe.

---

## 4. Testing

Each test must fail against `main` **by asserting** — not by failing to compile, and not by hanging.

1. **Header names, both files.** Construct a real `Headers` from the `init.headers` passed; assert
   construction succeeds and the three names are exact. Also assert the signature equals a locally
   computed HMAC — in **both** worker test files, which is what makes §2.1's accepted duplication safe.
2. **Non-2xx is a failure.** A 500 yields `delivered: false` after the configured attempts, using an
   injected backoff so no wall-clock elapses.
3. **4xx does not retry.** A 403 is attempted exactly once.
4. **Retry re-signs.** Timestamps differ across attempts and each signature verifies over its own.
5. **Timeout**, split because the whole cannot discriminate on `main`:
   **5a** — assert the `fetch` init carries an `AbortSignal`; fails by assertion today (none is passed).
   **5b** — a receiver settling only on abort yields a retryable attempt, with the per-attempt timeout
   injected to a small value. Post-fix only; explicitly **not** part of the pre-fix bar.
6. **`dispatch.started` and `dispatch.accepted` are attempted once** even when the receiver 500s.
7. **`fireNotifications` returns per-endpoint outcomes**, a healthy endpoint in the same fan-out still
   receives its POST, and a 500-returning endpoint is reported as failed rather than settled-ok.
8. **`safeEndpointLabel` never throws** for `not-a-url`, `""`, `//example.com/x`, `file:///etc/passwd`,
   `data:text/plain,hi`; strips userinfo from `https://u:p@h/a?t=1`; and returns an index-bearing label
   for every unparseable case.
9. **Existing tests updated in style and in fixtures.** `lifecycle.test.ts` and `notifications.test.ts`
   move to the test-1 assertion style; the three `{ ok: true }` mocks in `lifecycle.test.ts:58, :97,
   :128` gain `status: 200`; and `notifications.test.ts:219-225`'s `resolves.toBeUndefined()` becomes
   the `[]` contract from §2.3.

---

## 5. Non-goals

- **D5 — the emitter's keyless window** (`entrypoint.ts:150-154` constructs it with `hmacKey: undefined`,
  so the five earliest `failWith` sites attempt nothing). Slice B.
- **Persistence of undelivered events**, and **logging** of the outcomes this slice returns. Slice B.
- **D6 — SIGTERM handling.** Slice C, which is not designed.
- Consolidating `signCallback` into `pangolin-core` (§2.1).
- A client-side or environment-based retry knob (§2.2).
- Retry for notification webhooks (§2.3).
- **Populating `dispatchLevelNotifications`** — `entrypoint.ts:158` declares it and never populates it,
  so the source documented at `notifications.ts:7-8` is dead. Logged as its own `agora` task.
- Any coupling to the ai-os P15 work; `callback.authTokenRef` also touches `lifecycle.ts` and must
  sequence after this change.

---

## 6. Verification

Repo gate: `pnpm lint && pnpm typecheck && pnpm test`, plus `pnpm check:deps`.

**The e2e should be made to run, and it is out of this slice's scope to fund that.**
`test/e2e/callback-signing-roundtrip.test.ts` documents this contract but is `itIfDocker` and needs a
reachable Secrets Manager, so on Linux CI it **passes as skipped** — a green `pnpm test:e2e` is
compatible with it never executing, which is why the source/test mismatch survived. Making it run also
requires the e2e helper to pass `extraHosts` (a supported provider option,
`providers-local-docker/src/index.ts:85-91,:133`; the test's comment claiming otherwise is stale) and a
chosen Secrets Manager environment (real or LocalStack — neither is selected). Both are unowned by any
slice. **Tracked as its own task**, and noted here because it is §2.1's only guard on the third
`signCallback` drift.
