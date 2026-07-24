---
title: Callback Consumer Seam — Design Spec (ai-os-driven additive changes)
date: 2026-07-23
status: draft — plan-ready after slice A lands
branch: fix/callback-delivery-reliability
authors: [human:Brett, agent:claude-opus-4-8]
severity: medium (no defect; four additive seams a named consumer needs to integrate by direct dispatch)
consumer: ai-os (C:/Users/brett/source/repos/My_Projects/ai-os), charter 2026-07-22-pangolin-dispatch-seam-charter.md (merged PR #71)
related:
  - ./2026-07-23-callback-delivery-correctness-design.md # slice A — this spec amends its emit() signature (§5) and sequences after it
  - ./2026-07-23-callback-delivery-durability-design.md # slice B — shares the entrypoint key-resolution move; change 1 lands with it
  - ./2026-07-23-worker-termination-design.md # slice C — corrected by this work; consumes the emit() signal seam (§5)
  - ./2026-05-21-agora-mvp-design.md # §7.3 signing + replay window
---

# Callback Consumer Seam — Design Spec (ai-os-driven additive changes)

> **One line:** ai-os integrates Pangolin by **direct dispatch** — it calls `fireWork` in its own
> process, holds run state in its own append-only log, and correlates the callback home. It is the first
> real consumer of the callback channel, with a merged specification. This spec adds the **four additive
> seams** that integration needs, plus the `emit()` abort-surface decision that is cheapest to make now.
> No existing behaviour changes; every seam is opt-in or a pass-through field.

**Why this is a spec and not a decline.** Slice A twice invoked the discipline *"add it when a consumer
asks"* (client-side timeout, §2.2) and *"nothing inside Pangolin consumes the callback"* (retry, §2.2.1).
Both calls were right. **A consumer is now asking**, and it accepts both — at-most-once delivery,
reconcile-by-polling, `dispatch.abandoned` meaning *"go look"* not *"failed"*. So this is the demand-pull
event those declines were waiting for, not a reversal of them. Each change below is measured against the
same bar slice A used: it must not touch the seal path, the dep-allowlist, or `pangolin-core`'s dependency
surface, and it must not smuggle in a delivery *guarantee*. All four clear it.

---

## 1. Change 1 — `callback.bearerRef?`: a SecretStore ref the worker sends as `Authorization: Bearer`

### 1.1 The need

ai-os's ingress (`POST /observe/:source`) authenticates with `Authorization: Bearer`, timing-safe, and
**401s before it resolves the source**. Pangolin's lifecycle callback signs HMAC into custom headers
(`X-Pangolin-Signature` etc., `lifecycle.ts:52-54`) and sends **no bearer**. `DispatchWork.callback` is
`{ url: string; signatureAlgorithm?: 'sha256' }` (`pangolin-core/src/dispatch.ts:62`) — a bare URL, so the
only place a token could go today is the query string, which lands it in logs and audit manifests.

**Both mechanisms, two jobs — this does not replace HMAC.** Bearer is for *admission* (the ingress fence
checks it before doing anything). HMAC stays for *integrity* (bound to `dispatchId` + timestamp + payload,
so a holder of the ingress token still cannot forge a lifecycle event). They coexist on the same POST.

### 1.2 Design

`bearerRef` is a **SecretStore ref the consumer supplies** — unlike the HMAC key, which Pangolin
*mints*. ai-os stages its own ingress token in the SecretStore it configures and passes the ref down. So
this is a **pass-through**, not a mint:

- **`pangolin-core`:** `DispatchWork.callback` gains one optional field →
  `{ url: string; signatureAlgorithm?: 'sha256'; bearerRef?: string }`. Additive, optional; no verify
  path or manifest shape changes.
- **`pangolin-client` (`fireWork`):** when `work.callback.bearerRef` is set, emit it as a new env var
  `PANGOLIN_CALLBACK_BEARER_REF`, in the existing `if (work.callback) { … }` block
  (`dispatch.ts:280-285`), alongside `PANGOLIN_CALLBACK_URL` / `PANGOLIN_CALLBACK_TOKEN_REF`. Pure
  pass-through of the caller's ref — `fireWork` never resolves it.
- **`pangolin-worker` (`env-parser.ts`):** parse `PANGOLIN_CALLBACK_BEARER_REF` as **optional**
  (unlike `PANGOLIN_CALLBACK_TOKEN_REF`, which `env-parser.ts:173-177` makes mandatory-with-URL — the
  bearer token is genuinely optional, a receiver may want HMAC only).
- **`pangolin-worker` (`entrypoint.ts`):** the bearer ref is **optional and independent** of the HMAC key
  ref (which `env-parser.ts:173-177` makes mandatory-with-URL), so it resolves in its **own sibling
  conditional** — `if (cfg.callbackUrl && cfg.callbackBearerRef)` — not inside the existing
  `if (cfg.callbackUrl && cfg.callbackTokenRef)` block at `:259`. It reuses the same two primitives that
  block uses: `secretStore.resolve(ref)` (`:262`) then `logger.registerSecret(value)` (`:269`), and the
  resolved token feeds the *same* `new LifecycleEmitter({ …, bearerToken })` construction (`:273`, relocated
  by slice B §2.1). So it composes with, rather than branches off, the established resolution path.
- **`pangolin-worker` (`lifecycle.ts`):** `LifecycleEmitter` constructor gains `bearerToken?: string`; when
  present, `emit()` adds `'Authorization': \`Bearer ${bearerToken}\`` to the plain-object `headers`
  (`lifecycle.ts:50-55`). One line, inside the existing header literal. Absent ⇒ header omitted ⇒
  byte-identical to today.

### 1.3 Security posture

- **The bearer token is worker-held, exactly like the HMAC key.** The worker already holds callback-
  signing material; the threat model already accepts that. This adds one more secret of the *same class*
  and widens the trust boundary by nothing. The design's own integrity story is what makes that safe:
  because HMAC binds to `dispatchId`+timestamp+payload, a worker (or a token-holder) still cannot forge a
  lifecycle event — the brief's point, and it holds here.
- **Resolved value is registered for redaction** before first use (same set as the HMAC key). It never
  enters a log line, the audit manifest, or an outcome object.
- **It travels as a ref, never a value**, from client to worker — no new plaintext-secret path.
- **Scope: the lifecycle channel only.** ai-os's ingress *is* `work.callback`. Third-party
  `NotificationConfig` webhooks (`{ when, webhook }`) are a different, operator-owned channel and get no
  bearer. `bearerRef` lives on `callback`, flows only to `LifecycleEmitter`.

### 1.4 Sequencing

Touches `lifecycle.ts` (slice A) and `entrypoint.ts` (slice B). **Must land after slice A**, and its
entrypoint resolution rides on **slice B's key-resolution move** (§2.1) — resolve the bearer ref at the
same relocated site, or it inherits D5's hard-no-op-until-step-4 bug. Slice A's non-goals already record
this dependency (`2026-07-23-callback-delivery-correctness-design.md:434-435`).

### 1.5 Testing

1. **Header present when configured.** With `bearerToken` set, `emit()`'s POST carries
   `Authorization: Bearer <token>`; assert on the captured `init.headers`. Fails against a pre-change
   emitter by assertion (no such key).
2. **Header absent when unconfigured.** No `bearerToken` ⇒ no `Authorization` key. Pins that the default
   path is byte-identical, so a receiver relying on HMAC-only is unaffected.
3. **HMAC unchanged with bearer present.** The `X-Pangolin-Signature` value equals a locally computed
   HMAC whether or not `bearerToken` is set — bearer and HMAC are independent.
4. **Redaction.** The resolved token does not appear in any emitted log line on a failure path
   (assert against the `StructuredLogger` capture, given the token registered as a secret).

---

## 2. Change 2 — expose `callbackTokenRef` on `InFlightDispatch`

### 2.1 The need

ai-os cannot verify a single inbound HMAC without the key's ref. `mintCallbackHmac` already returns
`{ ref, ttlSeconds }` (`callback-hmac.ts:18,28`), but `fireWork` keeps `callbackTokenRef` as an internal
local (`dispatch.ts:167,174`) and does **not** include it in the returned `InFlightDispatch`
(`dispatch.ts:441-457`).

**No foreign credential plane.** Under direct dispatch ai-os *is* the client: `fireWork` runs in ai-os's
process, the key is `randomBytes(32)` generated locally (`callback-hmac.ts:21`), staged into a SecretStore
ai-os configures. ai-os is asking for the ref to a key it already owns. The deterministic-name workaround
(`pangolin/callback-hmac/<dispatchId>`, `callback-hmac.ts:22-23`) is declined precisely so that naming
convention stays Pangolin's to change.

### 2.2 Design

Add one optional readonly field to `InFlightDispatch` and populate it from the existing local:

```ts
export interface InFlightDispatch {
  readonly dispatchId: string;
  // …unchanged…
  /** SecretStore ref for the per-dispatch callback HMAC key, when a callback was configured.
   *  Exposed so a direct-dispatch consumer can fetch the key and verify inbound callback
   *  signatures without coupling to the internal key-naming convention. */
  readonly callbackTokenRef?: string;
}
```

In the returned object (`dispatch.ts:441`), add `callbackTokenRef` (the local is already in scope, set at
`:174` under `if (work.callback)`, `undefined` otherwise). Zero behaviour change; a field that was
computed and discarded is now returned.

### 2.3 Security posture

`callbackTokenRef` is an opaque ref, not a value, and it is **already handed to the worker** as
`PANGOLIN_CALLBACK_TOKEN_REF` (`dispatch.ts:284`). Returning it to the client that staged it exposes
nothing new. It does not enter the audit manifest (the manifest carries `secretRefs` for the *worker's*
env, a separate map; `callbackTokenRef` is a return value to the caller, not manifest content).

### 2.4 Testing

1. `fireWork` with a `callback` configured returns an `InFlightDispatch` whose `callbackTokenRef` equals
   the ref the injected SecretStore recorded at `stage()`. Fails against `main` by assertion (`undefined`).
2. `fireWork` with **no** `callback` returns `callbackTokenRef === undefined`.

---

## 3. Change 3 — `work.dedupeOnDispatchId?`: opt-in existence guard before `provider.run()`

### 3.1 The need — a correctness one

ai-os's executor reconciles its whole log on startup. Its idempotency check is a `caused_by` read that
only exists *after* the outcome is appended, so a crash **between `execute()` resolving and the outcome
being written re-fires the dispatch with the same `dispatchId`**. `fireWork` performs no dedupe lookup
(`dispatch.ts:114` onward), so the re-fire launches a **second concurrent container sharing one mutable
prefix**: the overwrite-put output sentinel, and `mintCallbackHmac` re-staging under the same name
(`callback-hmac.ts:22`) — **replacing the first container's key mid-run.**

**Why in Pangolin, not ai-os:** the check belongs next to the storage write. An ai-os-side guard is only a
TOCTOU race with a wider window. **Prior art — this is not a novel concern.** `orchestrator.extendRun`
already performs idempotent id-skip (`orchestrator.ts:216`: *"drop any item whose namespaced id already
exists in the store"*). Change 3 is the *same* concern one layer down, at the layer ai-os actually uses:
the orchestrator's `WorkItemStore` id-skip is unreachable under direct dispatch (ai-os does not host
`pangolin-orchestrator`), so `fireWork` needs the storage-level equivalent.

### 3.2 Design — client-written fire-marker

When `work.dedupeOnDispatchId` is true, `fireWork` checks for a **fire-marker** and writes it **before any
staging or minting** — the marker exists the instant the first fire commits, before the worker container
writes anything, so the guard does not depend on the worker having reached its first storage write. (A bare
prefix `list()` would miss a first fire that crashed before the worker wrote.)

**Placement is load-bearing — the check must precede `mintCallbackHmac`.** The bug this prevents is the
re-fire *re-staging the HMAC key under the same name, replacing the first container's key mid-run*
(`callback-hmac.ts:22`). A check placed after step 4 (`dispatch.ts:168`) runs *after* that re-stage has
already happened. So the block goes **immediately after `store` is resolved (`dispatch.ts:144`), before
per-dispatch secret staging (`:148`), before the HMAC mint (`:168`), and before `emit('dispatch.accepted')`
(`:318`)** — a duplicate throws before it can stage, mint, or emit anything.

- **`pangolin-core`:** `DispatchWork` gains `dedupeOnDispatchId?: boolean`. Additive, optional,
  default-absent ⇒ current behaviour.
- **`pangolin-client` (`fireWork`)** — using the existing dispatch-URI builder and the repo's storage-write
  idiom (no new helpers):

  ```ts
  // right after `store` is resolved (dispatch.ts:144), before staging/mint/accepted:
  if (work.dedupeOnDispatchId) {
    const markerUri = buildDispatchRecordUri(client.namespace, dispatchId, 'fired.json');
    if (await markerPresent(client.storage, markerUri)) {
      throw new DispatchAlreadyExistsError(dispatchId);
    }
    await client.storage.put(
      markerUri,
      new TextEncoder().encode(JSON.stringify({ dispatchId, firedAt: new Date().toISOString(), traceId: trace.traceId })),
    );
  }
  ```

  `buildDispatchRecordUri` (`uri.ts:212`) is the **documented escape hatch** for the reserved `dispatches/`
  prefix — the general `buildPangolinUri` deliberately *rejects* `type:'dispatches'`, so this is the only
  correct builder. `output-sentinel.ts:236` and `retention.ts` are the precedents. The body is encoded with
  the repo's `new TextEncoder().encode(JSON.stringify(...))` idiom (`retention.ts:66`,
  `output-sentinel.ts:227`).
- **Existence probe:** the marker is a **URI-addressed overwrite put** (like `output.json`), not a
  registered/versioned blob, so the reliable primitive is `storage.get(markerUri)` returning bytes vs.
  throwing not-found — `markerPresent` wraps that (`try { await get; return true } catch { return false }`).
  A prefix `list()` is only usable if the chosen provider is confirmed to enumerate the `dispatches/`
  prefix; `get`-and-catch works on both bundled providers without that assumption. `markerPresent` is a
  small file-local wrapper, not a new exported helper.
- **`pangolin-client` (`errors.ts`):** new `DispatchAlreadyExistsError`, matching the file's existing
  `SecretStoreMismatchError` shape exactly (extends `Error`, `public readonly` field, sets `this.name`):

  ```ts
  export class DispatchAlreadyExistsError extends Error {
    constructor(public readonly dispatchId: string) {
      super(`dispatch "${dispatchId}" was already fired (dedupeOnDispatchId)`);
      this.name = 'DispatchAlreadyExistsError';
    }
  }
  ```

  ai-os catches it and treats the dispatch as already fired.

### 3.3 Marker body and posture

Minimal and secret-free — it lives under `dispatches/<id>/`, the **consumer-read prefix**, so it is an
outbound surface, not a log. Body: `{ dispatchId, firedAt, traceId }`. No URL, no secret, no free text.
Storage-backend retention covers it (same prefix as the dispatch record). It is a *separate* artifact from
the dispatch record `writeDispatchRecord` writes at reconcile (`dispatch.ts:420`); the two do not collide.

### 3.4 The accepted residual, stated

**Two genuinely concurrent fires can still race** — both can pass the existence check before either
`put()` commits (TOCTOU at the check itself). The reconcile scenario this exists for is **serial** (a
crash-restart re-fire happens after the first process is gone), so the marker is committed long before the
second fire runs, and the guard holds. This is a best-effort dedupe, **not a mutex**, and the spec says so
plainly rather than implying a lock. A distributed lock is explicitly out of scope; no consumer has pulled
one.

### 3.5 Testing

1. **Second fire of the same id throws.** Fire once (marker written), fire again with
   `dedupeOnDispatchId: true` and the same `dispatchId` ⇒ `DispatchAlreadyExistsError`, and
   `compute.run` is **not** called a second time (assert the mock's call count is 1). Fails against `main`
   by throwing nothing / running twice.
2. **First fire writes the marker before staging and mint.** Assert the injected storage received the
   `fired.json` `put` and that it ordered *before* the per-dispatch secret `stage()` and the
   `mintCallbackHmac` `stage()` (capture call order across the injected store). Ordering before
   `compute.run` is implied; the load-bearing assertion is before the HMAC re-stage — that is the bug
   §3.2 exists to prevent.
3. **Flag off ⇒ no marker, no check.** `dedupeOnDispatchId` absent ⇒ no `put`, no `list`, and a repeated
   id fires twice exactly as today. Pins that the seam is inert by default.
4. **Marker body carries no secret or URL** — deep-equals `{ dispatchId, firedAt, traceId }`.

---

## 4. Change 4 — publish the `pangolin-*` packages at a pinnable version

### 4.1 The need

ai-os's read adapter imports `computeContentHash` (`pangolin-core/src/content-hash.ts:82`) to re-hash
every fetched artifact on arrival — the charter requires it be **imported, never re-implemented**, since a
divergent hash makes verification vacuous. **`computeContentHash` is already exported from the public
barrel** (`pangolin-core/src/index.ts:9` → `content-hash.js`), so the import is real once the package is
published. Packages sit at local `0.2.0` with `publishConfig` set; it is not established they are
published where ai-os can pin.

### 4.2 Design — this is a release task, not code

- **Publish the dependency closure ai-os pins, at one aligned version.** Direct dispatch means ai-os
  imports `pangolin-client` (for `fireWork`), which depends on `pangolin-core`, plus the leaf
  implementations it wires (a `SecretStore`, a `ComputeProvider`, a `StorageProvider`). Publish that
  closure together at the same `0.2.0` (or a chosen pin), not `pangolin-core` alone.
- **Registry + identity:** npm `@quarry-systems/pangolin-*`, `publishConfig.access: public`, 2FA-on-writes
  (per the prior `@quarry-systems/agora-*` v0.1.0 launch and the npm/GHCR identity split — npm scope
  `@quarry-systems`, GHCR org `quarrysystems`). Confirm each `package.json` `name` reflects the
  agora→pangolin rename and no stale `agora-*` name ships.
- **Build-order gotcha:** a clean-CI publish must survive `pnpm -r build`; workspace **dep cycles** break
  build order on a clean install (a known repo failure mode). Treat any install-time cycle warning as a
  release gate, and simulate clean order before the first publish.
- **Version discipline:** the four code changes above are additive — a **minor** bump (0.2.0 → 0.3.0)
  once they land, and ai-os pins that. The publish of the *current* `0.2.0` (for `computeContentHash`
  alone) can precede the code changes if ai-os needs the hash import before the seams.

### 4.3 Verification

- `npm view @quarry-systems/pangolin-core@<pin>` resolves after publish.
- A throwaway external consumer can `import { computeContentHash } from '@quarry-systems/pangolin-core'`
  and `fireWork` from `@quarry-systems/pangolin-client` against the published tarballs (not the workspace),
  proving the barrel exports and the closure are complete.

---

## 5. Amendment to slice A — the `emit()` abort surface (decided now, while `lifecycle.ts` is uncommitted)

Slice C's Q3 asks whether `emit` accepts an `AbortSignal` or the emitter owns a shared `AbortController`,
and notes: *"if `emit` takes an `AbortSignal`, that is an A-shaped API change and should be pulled into A
rather than bolted on later."* `lifecycle.ts` is uncommitted; this is the cheapest moment to fix the
signature so slice C never re-edits it.

### 5.1 Design — add the param and composition now; leave `'aborted'` to slice C

`emit` already builds `AbortSignal.timeout(delayMs)` internally (`lifecycle.ts:76`). Add an optional
external signal and compose:

```ts
async emit(event: LifecycleEvent, opts?: { signal?: AbortSignal }): Promise<DeliveryOutcome> {
  // …guard, sign, headers, clamp (unchanged)…
  const timeout = AbortSignal.timeout(delayMs);
  const signal = opts?.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  try {
    const res = await (this.opts.fetchImpl ?? fetch)(this.opts.callbackUrl, { method: 'POST', headers, body: payload, signal });
    return res.status >= 200 && res.status < 300
      ? { delivered: true, status: res.status }
      : { delivered: false, status: res.status, reason: 'http-status' };
  } catch {
    // NOTE: classify on `timeout.aborted`, not `signal.aborted`, so an external abort (slice C)
    // is not miscounted as a per-attempt timeout. Until slice C passes a signal, `opts` is
    // undefined and this reduces to today's behaviour exactly.
    return { delivered: false, reason: timeout.aborted ? 'timeout' : 'network' };
  }
}
```

`AbortSignal.any` is available on Node v22.20.0 (slice A's pinned runtime).

### 5.2 What stays slice C's — and why that keeps slice A honest

- **The `'aborted'` reason is NOT added now.** Slice A's rule — *don't ship an unreachable enum member
  from a published package* — still binds: no caller passes `opts.signal` until slice C exists, so
  `'aborted'` would be unreachable. Adding the **param** is different: a param is a reachable API seam
  (callable, just not yet called), not a dead value. So the signature is fixed now; the reason enum and
  its precise classification land with slice C, the caller that produces them.
- **Documented latent edge:** until slice C, if a caller *did* pass `opts.signal` and it aborted,
  `timeout.aborted` is false ⇒ the outcome is `'network'`. That branch is unreachable in-repo until slice
  C wires the caller (which also adds `'aborted'` and the correct classification). Stated so it is not
  mistaken for a bug.

### 5.3 Slice A spec touch

Slice A §2.2's emitter description should gain one line noting `emit` takes `opts?: { signal? }`, so its
spec and `lifecycle.ts` stay in step. Applied when this work is implemented, not before approval.

---

## 6. Corrections owned by Pangolin (found reading the slices against the ai-os charter)

### 6.1 Slice C contradicts slice A — corrected in this work

`2026-07-23-worker-termination-design.md` constraint 5 asserts *"Slice A establishes at-least-once
delivery keyed on `(dispatchId, kind)`."* Slice A §2.2.1 (`:219-226`) establishes the **opposite** —
at-most-once, retry withdrawn, the `(dispatchId, kind)` dedupe key **explicitly withdrawn along with the
retry loop**. Slice C was written against a superseded draft. The cascade: constraint 2 and Q3 both reason
about aborting an *in-flight retry schedule* that no longer exists. The two-producer point (a receiver may
see `dispatch.cancelled` from both a client-side and a worker-side emission) **survives on its own merits**
and becomes a *receiver-idempotency* note, not a Pangolin dedupe-key claim. Slice C is corrected in this
same change set (see the companion edits to that file).

### 6.2 The patch-capture child-0 item (tracked; no action requested)

The charter's child 0 hardens `patch-capture.ts`'s git invocation — `spawn('git', …)` with no `env`
inherits the worker's full `process.env`, and a repo-local `core.fsmonitor` executes during `git add -A`
with the tampering invisible in the patch. It is the charter's only **verified-exploitable** threat-table
row and gates the seam's first consumer. Slice A's frontmatter references
`2026-07-23-patch-capture-env-scoping-design.md`, **which does not yet exist as a file** — a dangling
reference to resolve (write the spec or drop the frontmatter line). Confirming it is tracked; not designed
here.

---

## 7. Sequencing

```
slice A (correctness; lifecycle.ts) ──┬─▶ §5 emit() signal seam  (same file; fold in before A is committed)
                                      │
slice B (durability; entrypoint move) ─┼─▶ change 1 bearerRef (resolve bearer ref at B's relocated site)
                                      │
independent of A/B ───────────────────┼─▶ change 2 callbackTokenRef (pangolin-client only)
                                      ├─▶ change 3 dedupeOnDispatchId (pangolin-client + core flag)
                                      └─▶ change 4 publish (release task; 0.2.0 now, 0.3.0 after 1-3)

slice C (SIGTERM) ── consumes §5's signal seam; corrected by §6.1 before it is designed
```

Changes 2, 3, and the §6.1 slice-C corrections have **no dependency on A/B** and can land first. Change 1
sequences after A+B. The §5 seam should be folded into `lifecycle.ts` **before slice A is committed**, so
the signature is fixed once.

---

## 8. Non-goals (mirroring what ai-os is not asking for)

- **Not retry.** Withdrawn in slice A, correctly; nothing here reintroduces it.
- **Not a client-side timeout option.** Agreed: build when a consumer asks; ai-os does not need one.
- **Nothing in `pangolin-core`'s dependency surface, the seal path, or the dep-allowlist.** All four
  changes are additive fields / a pass-through env var / a client-side guard / a release. **Seal-path
  non-impact, verified:** the `DispatchManifest` (`audit.ts:26`) seals `executorManifest`,
  `secretRefs[]`, `actor`, `inputRefs`, `pipelineRef`, `firedAt`, `authorization`. Its `secretRefs` is
  built solely from `Object.values(flight.resolved.secretRefs)` (`executors/dispatch.ts:138`) — and the
  callback token refs live in `taskSpec.env` (`dispatch.ts:280-285`), *not* `resolved.secretRefs`, so
  neither the existing HMAC ref nor the new bearer ref (change 1) is sealed. Change 2's `callbackTokenRef`
  is a sibling field the executor never reads. Change 3's `fired.json` is referenced by no manifest, so
  `verifyBundle` never inspects it. Change 4 distributes `computeContentHash` unchanged. No sealed field,
  the content-hash function, or the verify path is altered.
- **No HTTP submission API**, no orchestrator hosting — ai-os dispatches directly.
- **No `'aborted'` reason yet** (§5.2) — slice C.
- **No distributed lock** for change 3 (§3.4) — best-effort dedupe only.
- **Not `patch-capture` env-scoping** (§6.2) — charter child 0, tracked separately.

---

## 9. Verification

Repo gate: `pnpm lint && pnpm typecheck && pnpm test`, plus `pnpm check:deps` (confirms no new cross-Quarry
or undeclared dependency slipped in via the pass-through env var or the new error type).

Cross-repo smoke (out of this spec's build scope, tracked with change 4): a throwaway consumer resolving
the published tarballs exercises `fireWork` → `callbackTokenRef`, a bearer-carrying callback, and
`computeContentHash`, proving the seams work from *outside* the workspace — the only place the direct-
dispatch shape is actually validated.

---

## 10. Prior-art conformance (audited 2026-07-23)

Each mechanism reuses an existing repo seam rather than inventing one; the implementer should not add a
parallel helper where a row below names the canonical one.

| Mechanism | Reuse (do NOT reinvent) | Principle |
|---|---|---|
| Dispatch-scoped URI (change 3 marker) | `buildDispatchRecordUri(ns, id, suffix)` `uri.ts:212` — the documented escape hatch; `buildPangolinUri` rejects `type:'dispatches'` | DRY |
| Encode a JSON blob for storage | inline `new TextEncoder().encode(JSON.stringify(x))` (`retention.ts:66`, `output-sentinel.ts:227`) — no `encodeMarker` helper | DRY |
| Resolve a secret ref in the worker | `secretStore.resolve(ref)` (`entrypoint.ts:262`) | DRY / SoC |
| Register a resolved secret for redaction | `logger.registerSecret(value)` (`entrypoint.ts:269`) | consistency |
| Typed client error | mirror `SecretStoreMismatchError` shape (`errors.ts`) | consistency |
| Idempotent id-skip | conceptual precedent `orchestrator.extendRun` `orchestrator.ts:216` (client-side equivalent, since the orchestrator store is unreachable under direct dispatch) | SRP / SoC |
| Default-with-injectable-override seam (change §5 timing already; bearer/bearerToken as ctor opts) | `LifecycleEmitter` ctor options + `tick.ts:22/:37` pattern | SRP |

**SRP note on `LifecycleEmitter`:** adding `bearerToken?` and `opts?.signal` keeps the class within its one
responsibility — *sign and POST the lifecycle callback*. The constructor option count grows to five, all
cohesively "how to perform that POST"; no second responsibility is introduced. If it later grows a sixth
concern (e.g. persistence), that is the signal to split — not now.
