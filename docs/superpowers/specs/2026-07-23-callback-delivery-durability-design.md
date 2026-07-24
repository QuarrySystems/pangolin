---
title: Callback Delivery Coverage and Durability — Design Spec (slice B of 3)
date: 2026-07-23
status: draft — plan-ready after slice A lands
branch: fix/callback-delivery-reliability
authors: [human:Brett, agent:claude-opus-4-8]
severity: high (the five earliest failure paths emit nothing at all)
related:
  - ./2026-07-23-callback-delivery-correctness-design.md # slice A — produces the DeliveryOutcome this slice consumes
  - ./2026-07-23-worker-termination-design.md # slice C — NOT designed; shares entrypoint.ts, must sequence after
  - ./2026-05-21-agora-mvp-design.md # §7.3 signing + replay window
---

# Callback Delivery Coverage and Durability — Design Spec (slice B of 3)

> **One line:** Slice A makes delivery correct and its outcome reportable. This slice makes delivery
> **reach the failures that matter** — today the emitter is a hard no-op until step 4, so the five
> earliest `failWith` sites send nothing at all — and makes a failed delivery leave a durable record
> instead of vanishing.

**Depends on slice A** for the `DeliveryOutcome` type and the `safeEndpointLabel` helper. **Must land
before slice C**, which edits the same file.

---

## 1. The defect

### D5 — the emitter is a hard no-op until step 4

`entrypoint.ts:150-154` constructs the emitter with `hmacKey: undefined`, and `lifecycle.ts:12` returns
immediately when **either** `callbackUrl` or `hmacKey` is falsy. The key is set only at `:271`. So every
`failWith` before that point attempts **no request at all**. The enumeration is complete — the next
`failWith` after these is `:311`, well past key resolution:

| Site | Reason | Today |
|---|---|---|
| `entrypoint.ts:205` | storage construction | no attempt |
| `:216` | adapter load | no attempt |
| `:224` | bundle fetch / integrity | no attempt |
| `:238` | invalid pipeline spec | no attempt |
| `:264` | callback key fetch | no attempt (irreducible — the key is what failed) |

This falsifies the comment at `entrypoint.ts:147-149` — *"We resolve it lazily below so an integrity
failure on the very first bundle still surfaces."* It does not surface. And because no request is
attempted, no retry runs and no exhaustion occurs, so **any backstop built on slice A's retry is
unreachable on precisely these paths** unless this slice lands.

---

## 2. Design

### 2.1 Move key resolution ahead of everything that can fail

Move the SecretStore construction **and the emitter rebuild** — `entrypoint.ts:245-276` inclusive,
which spans `secretsClient` at `:248-249`, `storeFromConfig` at `:252`, and the
`if (cfg.callbackUrl && cfg.callbackTokenRef) { … lifecycleEmitter = new LifecycleEmitter({ …, hmacKey: key }) }`
block at `:258-276` — ahead of storage construction, adapter load, bundle fetch, and pipeline-spec
validation.

> **The range matters.** `:245-256` is SecretStore construction *only*. Moving just that leaves the
> emitter still receiving its key after storage/adapter/bundles, delivering **none** of the fix. The
> emitter rebuild is the load-bearing half.

**Verified safe:** key resolution depends only on `secretStore`, built from `cfg.secretStoreKind` /
`cfg.secretStoreDir` / `deps.secretsManagerClient`, with no dependency on `storage`, `adapter`, or
`bundles`. The block **moves rather than being duplicated** — the same `secretStore` const is reused at
`:355` and `:385`. `env-parser.ts:173-177` makes `PANGOLIN_CALLBACK_TOKEN_REF` mandatory whenever
`PANGOLIN_CALLBACK_URL` is set, so the branch always runs when a callback is configured.

**One newly-reachable throw, checked and benign — but state it rather than assume it.** After the move,
`storeFromConfig` (`:252`) executes on paths that previously returned before reaching it, and it throws
for `local-file` without a `dir` (`pangolin-secret-store/src/store-from-config.ts:21`) or an unknown
kind. No current caller hits that: `env-parser.ts:163` defaults the kind to `aws-secrets-manager`, and
every in-process caller either injects `secretStore`/`secretsManagerClient` or sets both
`PANGOLIN_SECRET_STORE_KIND=local-file` **and** `PANGOLIN_SECRET_STORE_DIR` (`entrypoint.test.ts:508-509`,
`index.test.ts:244-245`, `inproc-worker-executor.ts:172`). It is also not inside a try/catch, so it
escapes `runWorker` to the entry script — wrapping it is **out of scope**, but this is the only thing
standing between the move and a repo-wide test break, so the plan must not disturb it.

**Two paths stay silent, by construction:** the key fetch itself (`:264`), and any failure before
`parseWorkerEnv` completes (`:133-141`).

### 2.2 Consume the outcome — `deliverLifecycle`

Extract the `emit` closure (`entrypoint.ts:161-179`) into a named function rather than growing it. Today
it owns the telemetry hook, lifecycle delivery, and notification fan-out; this slice would otherwise add
outcome policy, persistence, and two kinds of logging — six reasons to change inside a 460-line
function.

**Two functions, not one**, because the closure does two unrelated fan-outs:

```ts
deliverLifecycle(event, ctx): Promise<void>   // emit → outcome → log → persist on failure
deliverNotifications(event, ctx): Promise<void> // fireNotifications → outcomes → log each
```

`ctx` is `{ emitter, storage?, logger, namespace, dispatchId }`.

> **`storage` is optional, and that is load-bearing.** `entrypoint.ts:201` is
> `let storage: StorageProvider;` and `tsconfig.base.json` sets `"strict": true`, so referencing it
> inside the `:204` catch is TS2454 (used before assigned). `deliverLifecycle` branches internally on
> its absence.

### 2.3 Durable record on failure

When `emit` returns `delivered: false`, write the event to
`pangolin://<namespace>/dispatches/<dispatchId>/undelivered/<kind>.json` and log a distinct line. Path
shape verified constructible (`pangolin-core/src/uri.ts:212-234`; `output-sentinel.ts:236` is precedent).

**File body:** the `LifecycleEvent` plus the `DeliveryOutcome` — nothing else, and no free text (§3).

**One key per kind, last-write-wins.** A second failed delivery of the same kind supersedes the first;
the latest state is the useful one. Stated because a fixed key per kind is otherwise a silent overwrite.

**A failed `dispatch.started` IS persisted.** It is one-attempt fire-and-forget in slice A, and this
trigger is unconditional, so a down receiver writes `undelivered/dispatch.started.json` on every
dispatch. That is intended — it is the only record that the dispatch began.

**The storage-construction path cannot persist.** After §2.1's move the first site that can emit is
`:205` — *storage construction failed* — where there is no `StorageProvider` to write into. On that path
the event is **emitted but not persisted**, with a log line saying so. This is the one place §2.1's fix
and §2.3's backstop do not compose, and it is inherent rather than incidental: storage is the thing that
failed.

**Scope: forensic, not reconciliation.** Nothing enumerates `undelivered/`, and a receiver that never got
`dispatch.started` has no `dispatchId` to look up. This makes the loss discoverable by an operator who
knows the id; it is not a receiver discovery path, and retention belongs to the storage backend
(`pangolin-client/src/retention.ts:1-11`).

### 2.4 Logging

`deliverNotifications` logs one line per failed endpoint, carrying slice A's `safeEndpointLabel` output
— **never the raw webhook URL**. This closes a real monitoring gap: today a notification failure is
completely silent, so an operator cannot distinguish a delivering endpoint from a dead one.

**This also repairs an existing leak.** `entrypoint.ts:168` currently logs `(err as Error).message` for
`lifecycle.emit.failed`; on a network failure that string embeds the URL. Replacing it with
outcome-based logging removes the leak rather than adding a second instance.

---

## 3. Security posture

`dispatches/<id>/undelivered/` sits in the prefix a consumer reads, so it is an **outbound surface, not
a log** — and **storage writes get no automatic redaction**; only `StructuredLogger` redacts
(`logger.ts:9-10, :20-32`) against the set registered at `entrypoint.ts:269, :362, :370, :393`.

- The persisted body is the `LifecycleEvent` plus the `DeliveryOutcome`, whose `lastReason` is slice A's
  closed enum. No free text, no URL.
- Log lines carry `safeEndpointLabel` output only.
- **Threat-model rows:** none weakened. This slice neither reads nor relocates credentials; the
  *Identity theft* correction belongs to `2026-07-23-patch-capture-env-scoping-design.md` §6.

---

## 4. Testing

1. **Early failure emits.** With a callback configured, force a bundle-integrity failure and assert a
   `dispatch.failed` POST is attempted. Achievable against the real harness —
   `entrypoint.test.ts:114-128,:262` already has `setupHarness({ capabilityHashCorrect: false })` and
   `makeDeps` supplies a fake `secretsManagerClient` returning `{ SecretString: 'unused' }` — and on
   `main` the integrity failure returns at `:224` *before* key resolution at `:262`, so zero fetch calls
   → **fails by assertion**. This is the cleanest discriminator in the suite.
   **Two harness additions this test requires, neither present today:** `PANGOLIN_CALLBACK_URL` +
   `PANGOLIN_CALLBACK_TOKEN_REF` in `h.env` (`env-parser.ts:173-175` rejects one without the other), and
   a `fetchImpl` field on `makeDeps`. Both trivial; both must be stated or the implementer discovers them.
2. **Each of the five `failWith` sites attempts delivery** after the move — except `:264`, which asserts
   the opposite (no attempt, because the key is what failed).
3. **Exhaustion persists, positively asserted.** The persisted body **deep-equals** `{ event, outcome }`
   with `lastReason` drawn from the enum. A "contains no URL" assertion passes vacuously if nothing is
   written at all.
4. **The storage-failure path emits but does not persist**, and logs that it could not.
5. **`deliverLifecycle` tolerates `ctx.storage === undefined`** without throwing.
6. **Notification failures are logged with a safe label**, and a healthy endpoint in the same fan-out
   still receives its POST.
7. **No existing `entrypoint.test.ts` case regresses** — the move changes ordering, and that suite is the
   guard on it.

---

## 5. Non-goals

- **D6 / SIGTERM handling** — slice C, which shares this file and must sequence after.
- Wrapping `storeFromConfig`'s throw (§2.1).
- A reconciliation or discovery path for `undelivered/` (§2.3).
- Anything in slice A's scope: header names, retry, timeout, status classification, `safeEndpointLabel`.

---

## 6. Verification

Repo gate: `pnpm lint && pnpm typecheck && pnpm test`, plus `pnpm check:deps`.

Beyond the gate: confirm by inspection that the moved block is `:245-276` inclusive and that
`secretStore` still resolves at its later use sites (`:355`, `:385`) — a partial move is the most likely
implementation error and it fails silently, since the emitter simply stays keyless for longer.
