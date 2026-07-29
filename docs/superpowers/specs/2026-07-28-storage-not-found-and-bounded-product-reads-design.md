# Typed storage not-found

**Status:** design proposed 2026-07-28 · **Author:** agent:claude-opus-5 (with Brett) · **Confidence:** high
**Revision:** rev 4 — scope cut to the verified core after three audit rounds. See §9.

A missing storage object becomes a typed `StorageNotFoundError` instead of a
message the caller has to sniff. Today that sniff silently breaks the `absent`
path on S3: a finished dispatch with no output sentinel **throws** where the
published contract says it returns `{ status: 'absent' }`.

Bounded product reads — the `head()` size-ceiling work that shared this spec
through rev 3 — are deferred to their own spec (§6). So are two of the five
not-found call sites, for a reason worth stating up front: narrowing them as rev
3 specified would have created a silent-loss path worse than the fail-open
behaviour it replaced (§6.1).

**Evidence discipline for this spec.** Every factual claim about current behavior
carries a `file:line` citation. Claims about what *will* exist are marked as
decisions, not descriptions. §7 (documentation) may only describe surface that
lands in the same change.

---

## 1. Context

### 1.1 What is already unreleased

`main` carries six merged PRs since `v0.3.1`: the `pangolin-product` package
(#97), ADR-0019 and ADR-0020 (#98, #104), test lint/typecheck (#100), suite
determinism (#102), and doc inventories (#105). All are additive.

`packages/pangolin-product/package.json` is already at `0.4.0` while the other
fifteen packages sit at `0.3.1`, so lockstep is currently broken and a release
has to resolve it either way.

### 1.2 Why 0.4.0

§3 is not additive: it changes what `StorageProvider.get` must do on a missing
object and deletes the compensating logic from three callers. That is a breaking
change to the provider contract, so the release is `0.4.0` and all sixteen
packages move there in lockstep. This also lets `pangolin-product` stay where it
is rather than being walked backwards.

### 1.3 No external consumers

Pangolin has no third-party `StorageProvider` implementors and no published
consumer other than ai-os, which is developed in step. Back-compatibility for
unknown implementors is not a constraint, and §3 spends that freedom
deliberately: it deletes the fallback rather than layering the typed check on top
of it.

---

## 2. The defect — the `absent` path does not work on S3

`readOutputSentinel` promises that a missing sentinel is a normal outcome, not an
error. Its header comment states the reasoning:

> Missing objects become `absent` rather than throwing, because a finished
> dispatch with no sentinel is a normal outcome — `writeSentinel` is best-effort
> and the entrypoint emits `dispatch.finished` regardless.
> — `packages/pangolin-product/src/sentinel-read.ts:2-5`

On S3 it does not hold:

1. `readOutputSentinel` builds a **dispatch-record** URI
   (`packages/pangolin-product/src/sentinel-read.ts:15`) and reads it at
   `sentinel-read.ts:18`.
2. On S3 a dispatch-record URI routes to `getDispatchRecord`
   (`packages/pangolin-storage-s3/src/index.ts:443-449`), which sends
   `GetObjectCommand` and streams the body with **no not-found handling at all**.
   A missing key throws the SDK's `NoSuchKey` straight through.
3. The caller then asks `isNotFound(err)`
   (`packages/pangolin-product/src/sentinel-read.ts:34-39`), which returns true
   only for `err.code === 'ENOENT'` or a message matching `/not found/i`.
   An SDK `NoSuchKey` satisfies neither.

On the local provider it happens to work, because `LocalStorageProvider`'s
dispatch-record path throws a message containing the words "not found"
(`packages/pangolin-storage-local/src/index.ts:329`). The behaviour differs by
provider, and the provider that works does so by accident of phrasing.

**Inside Pangolin the defect is currently invisible.** All four in-repo callers
of `readOutputSentinel` swallow the throw — `packages/pangolin-cli/src/cmd-orch.ts:240`,
`packages/pangolin-orchestrator/src/executors/dispatch.ts:215`,
`examples/data-mapreduce/src/index.ts:285`, and
`examples/dogfood-gated/src/index.ts:160`. The user-visible victim is ai-os,
whose read adapter does not swallow. This is why §4's regression test sits on
`readOutputSentinel` itself rather than on any caller, and why none of the four
swallows is removed (§3.4).

The same defect sits on `readDispatchRecord`
(`packages/pangolin-client/src/retention.ts:82-88`), which returns `null` for a
missing record via an identical sniff at `retention.ts:90-97`.

### 2.1 The correct check already exists, one file away

`packages/pangolin-storage-s3/src/index.ts:112-121` defines a type-aware
`isNotFound`: `err instanceof NoSuchKey`, or `name` of `NoSuchKey`/`NotFound`, or
`$metadata.httpStatusCode === 404`. It pointedly does **not** sniff the message.
It is called from exactly one site — the index read at `index.ts:506` — and not
from either path the product read uses.

The provider knows precisely when an object is missing; it discards that
knowledge before the caller sees it, and its callers try to reconstruct it from
an error message.

### 2.2 The hazard the sniff carries

`sentinel-read.ts:30-33` documents its own blast radius: `/not found/i` is a
substring match, so an unrelated failure — DNS, misconfiguration, a throttle —
whose text happens to contain that phrase is reclassified as `absent`. For a
consumer that maps `absent` to "this dispatch produced nothing," a transient
infrastructure error is recorded as a durable business fact.

### 2.3 The dedupe guard fails open on the same gap

`packages/pangolin-client/src/dispatch.ts:520-527`:

```ts
async function markerPresent(storage: StorageProvider, uri: string): Promise<boolean> {
  try { await storage.get(uri); return true; } catch { return false; }
}
```

Every throw reads as "not present." Its caller is the dedupe guard
(`dispatch.ts:131-142`), whose comment (`:124-130`) states the stakes: a re-fire
"would otherwise re-stage the per-dispatch secrets / callback HMAC key under the
same name, replacing the first container's key mid-run." A throttle or transient
500 therefore opens the guard.

This site is **safe to narrow** because of where it sits: `markerPresent` is
called at `dispatch.ts:133`, and the durable dedupe marker is not written until
`dispatch.ts:136`. A throw from it happens before any marker, secret, or HMAC
exists, so nothing is stranded and the dispatch stays retryable. Two sibling
catches later in the same file do **not** have that property and are deferred —
see §6.1.

---

## 3. Design

### 3.1 Core

Add to `packages/pangolin-core/src/errors.ts`, alongside the six error classes
already there (`errors.ts:12,25,37,47,58,69`):

```ts
export class StorageNotFoundError extends Error {
  constructor(readonly uri: string) {
    super(`storage object not found: ${uri}`);
    this.name = 'StorageNotFoundError';
  }
}
```

`StorageProvider.get` (`packages/pangolin-core/src/storage.ts:18`) gains a
contract note: an object that does not exist **must** throw
`StorageNotFoundError`. `resolveLatest`, `list`, and `resolveByHash` already
return `null` for absence and are unchanged.

**Callers match on `err.name`, not `instanceof`.** This is the documented
convention at `packages/pangolin-core/src/errors.ts:1-5`:

> Each error class sets `name` to its class name so callers can use
> `err.name === 'IntegrityMismatchError'` for structural matching, even across
> realms / serialized payloads.

ai-os already applies it, with a comment naming the exact failure mode it guards
(`packages/adapter-pangolin-dispatch/src/executor.ts:73-75`: a dual-package split
making an imported class no longer `===` the one thrown internally). An earlier
revision of this spec mandated `instanceof` and then had to spend a §7 bullet
requiring ai-os to move both dependency pins in lockstep to avoid duplicate
`pangolin-core` copies. Name-matching dissolves that coupling (§5).

A small exported helper in core — `isStorageNotFound(err): boolean`, a `name`
comparison — keeps the three call sites from hand-rolling the check.

**This is the fix `sentinel-read.ts:26-29` asks for, not the one it forbids.**
That comment objects to hoisting *provider quirk-detection* into core ("would put
provider quirk-detection in the contract sink") and then names the real defect
itself: "`StorageProvider` has no typed not-found signal, so every caller sniffs."
This change puts a typed *class* in core and leaves *detection* in the provider
(`isNotFound`, `packages/pangolin-storage-s3/src/index.ts:112-121`).

### 3.2 Providers

- `LocalStorageProvider.getBlob` — `index.ts:286` currently rethrows `ENOENT` as
  a generic `Error`; it throws `StorageNotFoundError` instead.
- `LocalStorageProvider.getDispatchRecord` — same at `index.ts:329`.
- `S3StorageProvider.get` — the blob branch is **inline in `get()`** at
  `index.ts:230-242` (there is no `getBlob` method on this class); it gains a
  not-found catch using the existing `isNotFound` at `index.ts:112`.
- `S3StorageProvider.getDispatchRecord` — `index.ts:443-449`, same. **This is
  the call that fixes §2.**

### 3.3 Callers whose behaviour changes

Each narrows to "if not-found, today's behaviour; otherwise rethrow." A genuinely
absent object keeps current semantics; only transient errors change.

| Site | Absent → | Transient → (new) |
|---|---|---|
| `pangolin-product/src/sentinel-read.ts:20` | `{ status: 'absent' }` | throws; local `isNotFound` (`:34-39`) and its blast-radius comment deleted |
| `pangolin-client/src/retention.ts:85` | `null` | throws; local `isNotFound` (`:90-97`) deleted |
| `pangolin-client/src/dispatch.ts:520-527` | `false` | throws (§2.3 — pre-marker, strands nothing) |

Three copies of the heuristic become zero.

### 3.4 Callers deliberately left alone

**All four `readOutputSentinel` swallows stay.** In particular
`pangolin-orchestrator/src/executors/dispatch.ts:215`'s
`.catch(() => ({ status: 'absent' }))` is a documented contract at
`executors/dispatch.ts:199-206` — "NEVER throws — `absent`, `malformed`, and a
rejected promise (unrelated storage errors) all yield an empty object" — and
removing it strands the run:

1. `reconcile()` deletes the in-flight entry (`dispatch.ts:165`) and calls
   `entry.inflight.cleanup()` (`:171`) **before** `readSentinel` at `:174`.
2. A throw at `:174` escapes `reconcile()`. `engine/tick.ts:90` does not wrap
   that call, so the rest of the tick — later items, the audit-seal block — is
   abandoned.
3. On the next tick `reconcile` returns `null` (`dispatch.ts:164`) because the
   entry is gone. The item stays `running` until a configured `maxRuntimeMs`
   overrun (`tick.ts:74-88`) frees it, if one is configured at all.

An earlier revision proposed removing this `.catch` as "papering over §2." It is
not; §2's fix simply makes it fire far less often. The same reasoning covers
`cmd-orch.ts:240` ("best-effort — never fail the watch") and the two `examples/`
callers.

### 3.5 Doubles and stubs that encode the deleted behaviour

Deleting the sniff invalidates every test double that signals absence by message
or `ENOENT`. These are enumerated rather than left to a sweep, because two of
them are *assertions of the behaviour being removed* and must be inverted, not
merely updated:

| Site | Action |
|---|---|
| `packages/pangolin-product/test/sentinel-read.test.ts:40` — *"returns absent when the provider throws an error whose message matches `/not found/i`"* | **Inverted.** It becomes the §4 regression test: a `/not found/i` message is *not* absent. |
| `packages/pangolin-product/test/sentinel-read.test.ts:28` — *"returns absent when the provider throws an ENOENT-coded error"* | Rewritten: the double throws `StorageNotFoundError`. |
| `packages/pangolin-client/test/retention.test.ts:174` — *"returns null when the storage backend signals ENOENT"* | Same. |
| `packages/pangolin-client/test/retention.test.ts:8,24` — memory-storage double surfacing a `/not found/i` error | Throws `StorageNotFoundError`. |
| `packages/pangolin-client/test/dispatch-dedupe.test.ts:73` — same pattern | Throws `StorageNotFoundError`. |
| `examples/appendable-stream/src/index.ts:237-241` — hand-rolled `{ get }` stub throwing `` `storage: not found: ${ref}` `` | Throws `StorageNotFoundError`. Behaviourally inert today (its consumer `assembleBundle` absorbs any throw at `packages/pangolin-orchestrator/src/audit/bundle.ts:41-47`), but it is a src-tree stub whose entire contract is the message being deleted. |

The sweep covers all four workspace roots — `packages/*`, `examples/*`,
`deploy/*`, `docs-site` (`pnpm-workspace.yaml`). Prior revisions of this spec
twice enumerated `packages/` only and twice missed a caller; `deploy/` contains
only `serve-stack` and no storage reads.

### 3.6 Blast radius

A `StorageProvider` implementation that does not throw the typed error now
surfaces a missing object as an unhandled infrastructure throw rather than
`absent`/`null`. Per §1.3 there are no such implementations outside this repo.
The contract change is called out in the changelog as breaking.

---

## 4. Testing

- **A provider throwing a generic `Error` whose message contains "not found" is
  not treated as absent.** This is `sentinel-read.test.ts:40` inverted, and it is
  the point of the change.
- **Regression for §2:** a missing sentinel on an S3-backed provider returns
  `{ status: 'absent' }`. Asserted on `readOutputSentinel` directly, not through
  any of the four swallowing callers. This fails today.
- `LocalStorageProvider` `ENOENT` → `StorageNotFoundError`, on both the blob and
  dispatch-record paths.
- `S3StorageProvider` `NoSuchKey` → `StorageNotFoundError`, on both paths.
  **Unit tests, with the fixture constructed as a real `NoSuchKey` instance** so
  `err instanceof NoSuchKey` (`index.ts:113`) is genuinely exercised rather than
  the `name` fallback; a hand-rolled `{ name: 'NoSuchKey' }` would assert the
  mock, not the SDK. The LocalStack-gated
  `packages/pangolin-storage-s3/test/integration.test.ts` is not extended.
- `readDispatchRecord` returns `null` for a missing record and **rethrows** a
  generic error.
- `markerPresent` returns `false` for `StorageNotFoundError` and **rethrows** a
  generic error — the dedupe guard must not open on a throttle. Paired with a
  test that a rethrow from `markerPresent` leaves **no** dedupe marker written
  (`dispatch.ts:136` never reached), which is what makes §2.3's safety claim
  assertable rather than asserted.
- **§3.4 characterisation:** `readSentinel` still returns `{}` when the
  underlying read rejects, so `reconcile` completes and the item does not strand.
  This pins the `.catch` that must not be removed.
- `isStorageNotFound` matches an error crossing a package boundary — i.e. one
  constructed from a *different* copy of `pangolin-core` — which `instanceof`
  would not (§3.1).

---

## 5. Consumer impact (ai-os)

ai-os's child-3 plan pins `pangolin-product@^0.4.0` and `pangolin-core@^0.4.0`,
so those pins are correct as written.

- **The BLOCKED gate does not "pass" yet — it passes once this release
  publishes.** Its wording is "verify the *published* `pangolin-product@^0.4.0`
  actually exports `readOutputSentinel` + `fetchDispatchArtifact`" (plan
  `:437-439`). The source barrel
  (`packages/pangolin-product/src/index.ts:7-12`) exports all four symbols, but
  no `0.4.0` exists on npm — `git tag` tops out at `v0.3.1`, and §8 is the step
  that creates it. ai-os must not start that task before the publish.
- **ai-os's read adapter matches on `err.name`,** consistent with §3.1 and with
  what `packages/adapter-pangolin-dispatch/src/executor.ts:73-75` already does.
- **Bumping `adapter-pangolin-dispatch` to `^0.4.0` is now hygiene, not
  correctness.** `packages/adapter-pangolin-dispatch/package.json:12-13` pin
  `pangolin-client` and `pangolin-core` at `^0.3.0`, and on 0.x a caret pins the
  minor, so a mixed tree resolves two `pangolin-core` copies. Under
  `instanceof` that was a correctness bug; under name-matching it is duplicated
  bytes. The plan's "resolving `pangolin-core` 0.3 and 0.4 side-by-side"
  acceptance criterion (`:492`) therefore stands and needs no edit.
- **No product-read size bound ships in 0.4.0** (§6.2). ai-os's read adapter
  fetches artifacts unbounded, exactly as it would have before this spec existed.
  ai-os controls its own `StorageProvider` and can bound reads there in the
  interim.

---

## 6. Out of scope

### 6.1 Two `dispatch.ts` catches that must not be narrowed yet

`packages/pangolin-client/src/dispatch.ts:681-684` (`readSubagentCapabilities`,
`catch { return [] }` — fires with **zero capabilities**) and `:743-751`
(env-bundle read, `catch { continue }` — launches **without secrets**) are the
same fail-open defect as §2.3 with worse consequences. They are deferred anyway,
because narrowing them where they sit is a regression:

- Both run **after** the durable dedupe marker is written at `dispatch.ts:136` —
  `resolveCapabilities` at `:147`, `flattenEnvBundleSecrets` at `:327`. A new
  throw therefore leaves the marker behind with no container started. On retry
  `markerPresent` returns `true` → `DispatchAlreadyExistsError`, which ai-os
  treats as benign and reports as success
  (`packages/adapter-pangolin-dispatch/src/executor.ts:73-77`). One storage blip
  would mean the dispatch never ran, cannot be retried, and is durably recorded
  as `action.completed`.
- The env-bundle throw also lands **after** per-dispatch secrets are staged
  (`dispatch.ts:178`) and the callback HMAC is minted (`:193`), and the
  compensating `cleanup()` (`:463-467`) is reachable only through the returned
  `InFlightDispatch` — which `fireWork`'s callers never receive on the throw
  path (`dispatchWork` calls it at `:500`, outside the `try/finally` at
  `:501-506`). Stranded credentials, from a credential-hygiene change.

Fixing these properly means moving or rolling back the dedupe marker and making
staging cleanup reachable on the throw path — the dispatch lifecycle, not the
storage contract. **Leaving them alone regresses nothing:** they are fail-open
today and stay exactly as they are.

### 6.2 Bounded product reads

The `head()` size-ceiling design shared this spec through rev 3 and is deferred
whole. It is not ready:

- The proposed fixed 1 MiB sentinel ceiling does not survive the real worst case.
  Block count has no write-side cap (`packages/pangolin-core/src/pipeline.ts:94`
  rejects only an *empty* `blocks` array;
  `packages/pangolin-worker/src/pipeline-runner.ts:464` passes every outcome to
  `writeSentinel`), and each `BlockOutcome` carries a `verify.report` up to a
  caller-overridable `DEFAULT_REPORT_LIMIT = 8_000`
  (`packages/pangolin-worker/src/verify.ts:28,31`) plus up to 256 outputs. A
  legitimate large pipeline would become permanently unreadable.
- An optional `head` feeds a systematic `StorageHeadUnsupportedError` straight
  into the §3.4 swallows, turning "produced nothing" from transient into
  permanent for any provider without `head` — including six hand-rolled
  `implements StorageProvider` doubles in `pangolin-worker/test/`.
- The read inventory has to be rebuilt across `examples/` (five further
  `storage.get` sites beyond the twelve in `packages/*/src`) and `deploy/`.

### 6.3 Also deferred

- **Bounding `readDispatchRecord`.** `pangolin-client` does not depend on
  `pangolin-product`, so the size guard would cross a package boundary. Note this
  is a cost decision, not a safety one: the worker's credential *can* write
  `record.json`, since `S3StorageProvider.put` routes any dispatch-record URI to
  `putDispatchRecord` with no suffix allowlist (`index.ts:217-222`) and
  `buildDispatchRecordUri` accepts an arbitrary suffix
  (`packages/pangolin-core/src/uri.ts:212-229`).
- **Issue #103** (typecheck test files in the remaining 10 packages).
- **Release automation** (RELEASING.md "Future"). 0.4.0 is cut by hand.
- **A typed not-found on `list`/`resolveLatest`/`resolveByHash`.** They already
  return `null` for absence.

---

## 7. Documentation

- `CHANGELOG.md` — `[Unreleased]` becomes `## [0.4.0] - 2026-07-28`, absorbing
  the six already-merged PRs plus this change. A **Breaking** heading names the
  `StorageProvider.get` not-found contract. §2 is listed under **Fixed** as a
  provider-dependent `absent` path, which is what a reader upgrading needs to
  know.
- `packages/pangolin-core/src/storage.ts` — the `get` contract note.
- `docs-site/src/content/docs/how-to/write-a-provider.md:126-166` — reproduces
  the `StorageProvider` interface literally; it gains the `get` not-found MUST.
  This is the page a future implementor reads.
- `docs-site/src/content/docs/reference/dispatch-lifecycle.md:200-207` — states
  "A missing sentinel comes back as `{ status: 'absent' }` rather than throwing."
  That stays true and gains the provider-contract reason it now rests on.
- No change to `docs-site/test/product-read-docs.test.ts`. Its guard at `:91-105`
  forbids documenting a `head()` probe or a size-bounded read — correct, since
  §6.2 defers exactly that surface. (Rev 3 would have had to invert it.)
- An ADR is **not** warranted. ADR-0020 already established the product read as a
  public storage-keyed contract; this hardens the storage contract underneath it.

---

## 8. Release mechanics

Per `RELEASING.md`: bump all sixteen packages to `0.4.0` in lockstep
(`pangolin-product` is already there), move the changelog section, `pnpm -r run
build`, `pnpm -r publish --dry-run --no-git-checks` to confirm the tarballs carry
only `dist`/`README.md`/`LICENSE`, `pnpm -r publish --access public`, annotated
`v0.4.0` tag, then `gh release create`.

---

## 9. Revision history

**rev 4 (2026-07-28)** — third audit round. Scope cut to the verified core.

The audits converged on a pattern: §2 and its evidence were "solid, do not touch"
in all three rounds, while every added element churned — a 64 MiB default that
contradicted the worker's 100 MiB write cap, a required `head` that the type
system could not enforce, a removed orchestrator `.catch` that stranded runs, and
finally two narrowed catches that would have made a storage blip permanently
un-retryable *and* recorded as success. Each was a fix for the previous round's
fix.

| Change | Driver |
|---|---|
| `dispatch.ts:681` + `:745` deferred (§6.1) | Both sit after the dedupe marker write; narrowing them makes a transient blip un-retryable and reported to ai-os as `action.completed`. Deferring regresses nothing — they are fail-open today. |
| `markerPresent` retained | It is called at `:133`, before the marker write at `:136`, so its throw strands nothing. §4 asserts that. |
| All of B deferred (§6.2) | The sentinel ceiling arithmetic does not survive unbounded blocks × caller-overridable `verify.report`; optional `head` feeds a permanent failure into the §3.4 swallows; the read inventory was never built over `examples/`. |
| `err.name` matching replaces `instanceof` (§3.1) | `errors.ts:1-5` documents name-matching as the convention, ai-os already uses it, and it dissolves the dual-`pangolin-core` pin coupling rev 3 spent a §7 bullet on. |
| §2's caller inventory corrected to four | Two `examples/` callers were missed twice; `examples/` and `deploy/` are workspace roots (`pnpm-workspace.yaml`). |
| §3.5 enumerates the doubles, two of which invert | `sentinel-read.test.ts:40` asserts the exact behaviour being deleted. |
| §6.3 withdraws the `readDispatchRecord` threat-model reason | The worker's credential *can* write `record.json`; the exclusion rests on package boundaries, a cost decision. |

**rev 3** — reverted required-`head` (double assertions bypass structural
checking; enforcement was two files) and the orchestrator `.catch` removal
(strands the run); corrected the artifact-immunity argument to content-derived
blob keys.

**rev 2** — corrected the 64 MiB default against the worker's 100 MiB write cap;
named the oversize outcomes; added `markerPresent`; corrected the non-existent
`S3StorageProvider.getBlob`; added the stale doc pages.
