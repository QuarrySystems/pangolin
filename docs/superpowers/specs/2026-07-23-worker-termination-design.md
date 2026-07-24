---
title: Worker Termination on SIGTERM — Finding and Open Questions (slice C of 3)
date: 2026-07-23
status: draft — defect verified; NOT designed. Q3 resolved; Q1 and Q2 still blocking. Not ready for a plan.
branch: fix/callback-delivery-reliability
authors: [human:Brett, agent:claude-opus-4-8]
severity: medium-high (a cancelled dispatch loses its terminal event; a documented behaviour has never existed)
related:
  - ./2026-07-23-callback-delivery-correctness-design.md # slice A
  - ./2026-07-23-callback-delivery-durability-design.md # slice B — shares entrypoint.ts; must land first
  - ./2026-07-23-callback-consumer-seam-design.md # §5 supplies the emit() signal seam (Q3); §6.1 corrects this file's stale at-least-once assumption
  - ./2026-07-23-worker-env-block-exposure-design.md # its C1 candidate rewrites the same entry script
  - ./2026-05-21-agora-mvp-design.md # §7.6 claims a SIGTERM handler that has never existed
---

# Worker Termination on SIGTERM — Finding and Open Questions (slice C of 3)

> **One line:** The worker has no SIGTERM handler, and because it runs as **PID 1** the kernel *discards*
> the signal rather than terminating it — so a cancelled dispatch burns its whole grace window and dies
> by SIGKILL, losing any in-flight delivery. The defect is verified. **The fix is not designed**, and an
> earlier attempt to write it produced two behaviour rules that contradict each other.

**This document is deliberately not a spec.** It carries the finding, the constraints, and three
questions that must be answered before a design section is written. §4 is the gate.

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
than merely better — a stronger argument than the one an earlier draft made.

**The grace is not universal.** 10 s is local-docker's default (`src/index.ts:117`, documented `:40-42`).
Fargate issues `StopTaskCommand` (`providers-fargate/src/index.ts:213-222`) and the grace follows the
task definition's `stopTimeout` — operator-owned, and set nowhere in this repo. Any budget must be
**self-bounded**, not sized to an assumed window.

**A documented behaviour that has never existed.** MVP §7.6 (`:1107-1109`) claims the worker traps
SIGTERM, emits `dispatch.cancelled`, and releases channel subscriptions. None of it is true. This is a
doc-asserts-a-property-the-code-lacks defect of the same class as the callback header names, and it is
worth correcting independently of whether this slice is built.

---

## 2. Constraints any design must satisfy

1. **The handler needs a seam, and the obvious placements both break something.** `runWorker` is called
   in-process by `orchestrator/test/fixtures/inproc-worker-executor.ts:189` and by every case in
   `entrypoint.test.ts`, so registering a listener inside it leaks listeners across the vitest process
   and a handler that exits would kill the test runner. The entry script
   (`docker/pangolin-worker/bin/pangolin-worker-entry.mjs:16-21`) is the right place for `process.on` and
   `process.exit` — it is the only such site on the worker container path — but it has no access to the
   emitter, storage, or namespace.
2. **The abort surface — now decided, not open.** `LifecycleEmitter` was
   `constructor(opts: { callbackUrl?, hmacKey?, fetchImpl? })` and `emit(event)` with no way in. **There
   is no "in-flight retry schedule" to interrupt** — slice A is at-most-once (§2.2.1), so `emit` makes one
   bounded attempt, and the only thing SIGTERM needs to interrupt is a single in-flight `fetch`. The
   abort surface is supplied by `2026-07-23-callback-consumer-seam-design.md` §5: `emit` gains
   `opts?: { signal?: AbortSignal }`, composed with the internal timeout via `AbortSignal.any`. The
   handler holds an `AbortController`, passes `controller.signal` to the flushing `emit`, and aborts when
   grace is nearly spent. See Q3.
3. **`entrypoint.ts` is shared with slice B**, so this must land after it.
4. **`bin/pangolin-worker-entry.mjs` is contested.** The sibling
   `worker-env-block-exposure` spec's candidate C1 — re-exec the worker from a thin launcher — would
   rewrite that same file and insert a process between PID 1 and `runWorker`, changing **which process
   receives SIGTERM**. Not merely a placement invalidation: a same-file collision.
5. **A receiver may see `dispatch.cancelled` from two producers.** *(Corrected: an earlier draft of this
   constraint cited "Slice A establishes at-least-once delivery keyed on `(dispatchId, kind)`." That is
   wrong — slice A §2.2.1 establishes **at-most-once**, and the `(dispatchId, kind)` dedupe key was
   **withdrawn along with the retry loop**. There is no Pangolin-side dedupe contract to respect.)* What
   survives on its own merit: `dispatch.cancelled` is admitted by the union
   (`pangolin-core/src/lifecycle.ts:71-76`), is a legal `NotificationConfig.when` value, and may *also* be
   emitted client-side (`lifecycle.ts:6-8` header, MVP `:1109`) — so a receiver can see that kind from two
   producers and must be **idempotent on `(dispatchId, kind)` itself**. That is a receiver obligation, not
   a delivery guarantee Pangolin makes.

---

## 3. The blocking questions (Q1, Q2 open; Q3 resolved above)

### Q1 — when a terminal event is in flight, does the handler emit `cancelled`?

An earlier draft wrote both of these, and they contradict:

> *"Delivery in flight — finish or persist it, then emit `cancelled`."*
> *"…if the main path has already emitted `finished` or `failed`, the handler emits nothing."*

If a `dispatch.finished` delivery is in flight when SIGTERM lands, rule 1 orders *finish it, then emit
`cancelled`* — **two contradictory terminal kinds for one `dispatchId`**. A receiver made idempotent on
`(dispatchId, kind)` (corrected constraint 5) stores *both* as distinct terminal states rather than
collapsing them, so this is a real semantic conflict, not one a dedupe key resolves. Rule 2 forbids
exactly what rule 1 mandates.

The likely answer is that a run which produced a terminal outcome is not cancelled, and the handler's job
is only to flush — but that must be decided, not inferred.

### Q2 — where does the "already emitted a terminal event" state live?

No section named an owner, a location, or the *instant* it is set. The realistic race is precisely the
undefined one: SIGTERM arriving between `await emit({kind:'dispatch.finished'})` at `entrypoint.ts:577`
**beginning** and **returning**. Set-on-start and set-on-complete give different behaviour in exactly
that window.

Any test for the handler asserts on this flag, so it is load-bearing rather than incidental.

### Q3 — what is the abort surface? — **RESOLVED**

**Decided:** `emit` takes `opts?: { signal?: AbortSignal }`, composed with the internal per-attempt
timeout via `AbortSignal.any` — specified in `2026-07-23-callback-consumer-seam-design.md` §5 and folded
into `lifecycle.ts` **before slice A is committed**, so the signature is fixed once rather than re-edited
here. There is no "in-flight retry schedule"; the handler aborts a single in-flight `fetch`.

What remains **slice C's** to add (the caller that produces it): the `'aborted'` member of
`DeliveryFailureReason` and its classification (`opts.signal.aborted && !timeout.aborted ⇒ 'aborted'`).
Slice A deliberately omits it as unreachable until a caller passes a signal; this slice is that caller. The
handler's test seam is `opts.signal`.

---

## 4. Gate before this becomes a design

1. Answer Q1 and Q2 **in this document**, with the code sites they land on. (Q3 is resolved — the
   `emit()` signal seam is specified in `2026-07-23-callback-consumer-seam-design.md` §5.)
2. Confirm the sibling C1 decision (constraint 4). If a launcher is going to own PID 1, the handler
   belongs there, and designing it against today's entry script wastes the work.
3. Re-derive the budget arithmetic from the answers. An earlier draft claimed "≈2 s, self-bounded" while
   describing *two* deliveries plus a storage write — closer to 4 s plus I/O.
4. Decide whether MVP §7.6's other claim — releasing channel subscriptions (`entrypoint.ts:526`) — is in
   scope. The earlier draft quoted §7.6 as authority and silently dropped that half.

Only then write a design section and hand it to a plan.

---

## 5. Worth doing regardless

**Correct MVP §7.6.** It documents a SIGTERM handler, a `dispatch.cancelled` emission, and channel
release that have never existed. That correction is a statement of current fact and does not depend on
any of the above being built — the same reasoning that put the threat-model correction in a shippable
sibling rather than a blocked one.
