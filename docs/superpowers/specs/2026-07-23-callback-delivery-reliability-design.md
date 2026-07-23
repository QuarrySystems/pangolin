---
title: Callback Delivery Reliability — Design Spec
date: 2026-07-23
status: draft
branch: fix/callback-delivery-reliability
authors: [human:Brett, agent:claude-opus-4-8]
severity: high (every lifecycle and notification webhook currently fails; terminal events are lost silently)
related:
  - ./2026-05-21-agora-mvp-design.md # §7.3 callback signing + replay window; original X-Agora-* header names
  - ./2026-07-23-worker-credential-custody-design.md # sibling child-0 change; no file overlap
---

# Callback Delivery Reliability — Design Spec

> **One line:** Every lifecycle and notification webhook Pangolin sends is currently **dead on
> arrival** — the header names contain a space and are rejected before the request leaves the process —
> and the delivery path around them has no status check, no retry, and no timeout, so once the names are
> fixed a single 5xx still silently loses a terminal event. Repair the whole path, and make the
> undelivered record durable when delivery genuinely fails.

---

## 1. The defects

Four defects on one code path. D1 masks the other three: while every POST throws before sending, no
delivery outcome is ever observed, so the missing status check, retry, and timeout have never been
exercised.

### D1 — invalid header names (the whole channel is dead)

`lifecycle.ts:25-27` and `notifications.ts:86-88` send:

```
'X-Pangolin Scale-Signature'
'X-Pangolin Scale-Dispatch-Id'
'X-Pangolin Scale-Timestamp'
```

A space is not a valid character in an HTTP field name (RFC 9110 §5.1). Verified on Node v22.20.0 —
`Headers`, `Request`, and `fetch` all reject with `TypeError: … is an invalid header name`. The request
is never sent.

**Provenance.** The original design specifies `X-Agora-Signature` / `-Dispatch-Id` / `-Timestamp`
(`2026-05-21-agora-mvp-design.md:1080-1082`). Commit `37b19af` ("Rename Agora → Pangolin Scale") applied
a substitution of `Agora` → `Pangolin Scale`, turning `X-Agora-` into `X-Pangolin Scale-`.

**The correct names are already specified in this repo.** `test/e2e/callback-signing-roundtrip.test.ts`
refers throughout (`:20`, `:144`, `:200-202`) to `X-Pangolin-Signature`, `X-Pangolin-Dispatch-Id`,
`X-Pangolin-Timestamp` — single hyphens, no "Scale". There is no naming decision to make; the source
must be brought in line with what the repo already documents.

**The two channels fail differently, and one is louder than the other:**

- **Lifecycle** — `emit()` throws; `entrypoint.ts:163-170` catches it and logs `lifecycle.emit.failed`.
  Visible in the worker log.
- **Notifications** — the throw lands inside `Promise.allSettled` (`notifications.ts:91`), whose results
  are never inspected. **Completely silent.**

**The rename is definitionally non-breaking.** Because the names are invalid, `fetch` throws before a
request is sent — no receiver has ever received these headers, so no consumer can depend on them.

### D2 — no HTTP status check

`LifecycleEmitter.emit` (`lifecycle.ts:21-30`) awaits `fetchFn(...)` and ignores the result. `fetch` does
not reject on 4xx/5xx. So once D1 is fixed, **a 500 from the receiver neither throws nor logs** — the
`entrypoint.ts:163-170` catch never fires, and the worker proceeds as if delivery succeeded.

### D3 — no retry

One attempt. A receiver that is briefly unavailable loses the event permanently. This matters most for
terminal events (`dispatch.finished`, `dispatch.failed`): the product is already written to storage, but
a receiver that never hears about it has no way to distinguish a completed run from an abandoned one.

### D4 — no timeout

`fetch` is called with no `signal` and no deadline. A receiver that accepts the connection and never
responds blocks the worker indefinitely. Without this, adding retry only multiplies the hang.

### 1.1 Why these survived

`lifecycle.test.ts:83-89,119-120` and `notifications.test.ts:169-175` assert on the header names — **and
assert the misspelled ones**. They pass because they inject a `fetchImpl` mock and read `opts.headers` as
a plain JavaScript object, where `'X-Pangolin Scale-Signature'` is a perfectly ordinary key.

**An injected-fetch mock that treats headers as a plain object is structurally incapable of catching an
invalid-header-name defect.** The tests did not merely miss the bug; they pinned it. §6 therefore
requires a change of *assertion style*, not just of expected strings — otherwise the same class of defect
recurs the next time these names change.

---

## 2. Design

### 2.1 Header names

Replace all six occurrences with `X-Pangolin-Signature`, `X-Pangolin-Dispatch-Id`,
`X-Pangolin-Timestamp`, in both `lifecycle.ts` and `notifications.ts`. The signature scheme is unchanged:
lowercase hex HMAC-SHA256 over `${dispatchId}.${timestamp}.${payload}`, prefixed `sha256=`.

### 2.2 Delivery semantics for the lifecycle callback

`LifecycleEmitter.emit` gains status checking, a per-attempt timeout, and bounded retry.

| Outcome | Treatment |
|---|---|
| 2xx | success |
| 5xx, 429 | retryable |
| network error, timeout | retryable |
| other 4xx | **not** retryable — a contract error (bad auth, bad payload); retrying burns the budget without changing the result |

Defaults, operator-overridable through the existing `PANGOLIN_*` config surface: **3 attempts**, **10 s
per-attempt timeout**, backoff **1 s then 3 s** — worst case ≈ 34 s.

**Every attempt re-signs with a fresh timestamp.** §7.3 requires the receiver to reject a timestamp
outside a five-minute replay window; replaying the original signed bytes would make a backed-off retry
fail exactly when it is needed. A consequence worth stating for receivers: **delivery is at-least-once
and the dedupe key is `(dispatchId, kind)`, not the signature**, since signature and timestamp differ per
attempt by design.

**Retry applies to all lifecycle kinds, not only terminal ones.** Uniform behaviour beats a special case
here. The cost is explicit: `dispatch.started` is awaited at `entrypoint.ts:279`, so a dead receiver
delays the agent by the full retry budget. That is the reason the budget is configurable rather than
hard-coded.

### 2.3 Durable record when delivery fails

When retries are exhausted on any lifecycle event, the worker writes the undelivered event to
`pangolin://<namespace>/dispatches/<dispatchId>/undelivered/<kind>.json` — alongside the sentinel — and
logs a distinct line. Delivery stays best-effort; the **record** becomes durable, so a receiver can
reconcile from storage rather than infer.

**Wiring.** `LifecycleEmitter` takes an optional injected `persistUndelivered?(event, meta)` callback
rather than a `StorageProvider`. This keeps the emitter free of storage concerns, matching the existing
injectable-`fetchImpl` shape, and keeps its unit tests storage-free. The callback is attached at the
**existing** emitter reassignment (`entrypoint.ts:271`), which happens after storage is constructed
(`:203`).

**A gap this design does not close, stated rather than implied.** The emitter is constructed at
`entrypoint.ts:150` with no storage, so a `dispatch.failed` emitted before storage exists — most
importantly the one raised when *storage construction itself* fails (`:205`) — cannot be persisted.
Those events remain log-only. Persisting them would require a second durable sink that does not depend on
the thing that just failed, which is out of scope here.

`persistUndelivered` must never throw out of `emit`; it is a backstop, not a new failure mode.

### 2.4 Notifications

`fireNotifications` gets the header fix (§2.1) and **per-endpoint failure logging** — inspecting the
`Promise.allSettled` results at `notifications.ts:91` instead of discarding them, so a failing webhook is
visible in the worker log.

It does **not** get retry. `notifications.ts:17-19` states the contract: delivery is best-effort and must
not abort the dispatch lifecycle. Notifications are fan-out to N endpoints a third party controls;
retrying each would multiply worker runtime by the number of failing endpoints for a channel that is
explicitly advisory. The lifecycle callback is the single control-plane signal and is the one that earns
retry.

---

## 3. Non-goals

- **Changing the signature scheme, the payload, or the replay window.** §7.3 is unchanged; this repairs
  its transport.
- **Retry for notification webhooks** — §2.4.
- **A delivery-id / idempotency-key header.** `(dispatchId, kind)` is already sufficient to dedupe, and
  adding a header is a contract addition that belongs with a consumer that needs it.
- **Any coupling to the ai-os P15 work.** This change must ship independently of that design's outcome.
  The `callback.authTokenRef` addition that work will need also touches `lifecycle.ts`; it is deliberately
  **not** here, and must sequence after this change to avoid a conflict in the same file.

---

## 4. Testing

**The acceptance bar is that each test fails against current `main`**, except where noted.

1. **Header names are valid and correct.** Construct a real `Headers` (or `Request`) from what the
   emitter passes and assert construction succeeds and the three names are exactly
   `X-Pangolin-Signature`, `X-Pangolin-Dispatch-Id`, `X-Pangolin-Timestamp`. **This test must observe a
   real `Headers` object** — asserting on a plain-object key is what let the defect through (§1.1).
   Applies to both `lifecycle.ts` and `notifications.ts`.
2. **Non-2xx is a failure.** A receiver returning 500 causes a retry, and exhaustion is reported — not
   silently treated as success.
3. **4xx does not retry.** A 400 or 403 is attempted exactly once.
4. **Retry re-signs.** Across attempts, timestamps differ and each attempt's signature verifies over
   *that attempt's* timestamp — not the first one.
5. **Timeout aborts.** A receiver that never responds does not block past the per-attempt timeout, and
   the attempt is treated as retryable.
6. **Exhaustion persists.** After the final failed attempt, `persistUndelivered` is invoked once with the
   event; a throw from it does not propagate out of `emit`.
7. **Notification failures are logged.** A failing endpoint produces a log line; a second, healthy
   endpoint in the same fan-out still receives its POST.
8. **Existing tests updated in style, not just in strings.** `lifecycle.test.ts` and
   `notifications.test.ts` currently assert the misspelled names against a plain object; they are rewritten
   to the §4.1 style. Every other existing assertion in those files continues to pass.

---

## 5. Verification

Repo gate: `pnpm lint && pnpm typecheck && pnpm test`, plus `pnpm check:deps`.

`test/e2e/callback-signing-roundtrip.test.ts` documents this contract in prose (`:200-202`) and runs
under the separate `vitest run --config vitest.e2e.config.ts` target — outside the default gate, which is
part of why the mismatch between it and the source persisted. The PR should confirm that e2e target
passes, and note in its description that the source now matches the names that test has always described.

One manual confirmation belongs in the PR: point a worker at a receiver that returns 500 for the first
two attempts and 200 for the third, and record that the event is delivered rather than lost. Before this
change the first attempt does not leave the process at all.
