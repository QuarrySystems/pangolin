# Typed storage not-found

**Status:** design proposed 2026-07-28 · **Author:** agent:claude-opus-5 (with Brett) · **Confidence:** high
**Revision:** rev 6 — five audit rounds. See §9.

A missing storage object becomes a typed `StorageNotFoundError` instead of a
message the caller has to sniff. Today that sniff silently breaks the `absent`
path on S3: a finished dispatch with no output sentinel **throws** where the
published contract says it returns `{ status: 'absent' }`.

**Scope is the storage contract and the two read paths that consume it.** There
are no changes to the dispatch fire path (§6.1) and no bounded-read work
(§6.2). Nothing in this release alters when a dispatch fires, fails, or retries.

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
fifteen packages sit at `0.3.1`, so lockstep is broken and a release has to
resolve it either way.

### 1.2 Why 0.4.0

§3 is not additive: it changes what `StorageProvider.get` must do on a missing
object and deletes the compensating logic from two callers. That is a breaking
change to the provider contract, so the release is `0.4.0` and all sixteen
packages move there in lockstep.

### 1.3 No external consumers

Pangolin has no third-party `StorageProvider` implementors and no published
consumer other than ai-os, which is developed in step. Back-compatibility for
unknown implementors is not a constraint, and §3 spends that freedom
deliberately: it deletes the fallback rather than layering the typed check on top
of it.

---

## 2. The defect — the `absent` path does not work on S3

`readOutputSentinel` promises that a missing sentinel is a normal outcome:

> Missing objects become `absent` rather than throwing, because a finished
> dispatch with no sentinel is a normal outcome — `writeSentinel` is best-effort
> and the entrypoint emits `dispatch.finished` regardless.
> — `packages/pangolin-product/src/sentinel-read.ts:2-5`

On S3 it does not hold:

1. `readOutputSentinel` builds a **dispatch-record** URI
   (`packages/pangolin-product/src/sentinel-read.ts:15`) and reads it at `:18`.
2. On S3 a dispatch-record URI routes to `getDispatchRecord`
   (`packages/pangolin-storage-s3/src/index.ts:443-449`), which sends
   `GetObjectCommand` and streams the body with **no not-found handling at all**.
   A missing key throws the SDK's `NoSuchKey` straight through.
3. The caller then asks `isNotFound(err)` (`sentinel-read.ts:34-39`), true only
   for `err.code === 'ENOENT'` or a message matching `/not found/i`. An SDK
   `NoSuchKey` satisfies neither.

On the local provider it happens to work, because its dispatch-record path throws
a message containing the words "not found"
(`packages/pangolin-storage-local/src/index.ts:329`). The behaviour differs by
provider, and the one that works does so by accident of phrasing.

**Inside Pangolin the defect is currently invisible.** Every path that reaches
`readOutputSentinel` swallows the throw somewhere: `pangolin-cli/src/cmd-orch.ts:240`
and `pangolin-orchestrator/src/executors/dispatch.ts:215` catch at the call site;
`examples/dogfood-gated/src/index.ts:162` catches at its call site; and
`examples/data-mapreduce/src/index.ts:285` propagates out of the exported
`readSentinelBlocks` helper (`:280-287`) into a caller-side catch at `:449-461`.
The user-visible victim is ai-os, whose read adapter will not swallow. This is
why §4's regression test sits on `readOutputSentinel` itself rather than on any
caller, and why none of these swallows is removed (§3.4).

The same defect sits on `readDispatchRecord`
(`packages/pangolin-client/src/retention.ts:82-88`), which returns `null` for a
missing record via an identical sniff at `retention.ts:90-97`.

### 2.1 The correct check already exists, one file away

`packages/pangolin-storage-s3/src/index.ts:112-121` defines a type-aware
`isNotFound`: `err instanceof NoSuchKey`, or `name` of `NoSuchKey`/`NotFound`, or
`$metadata.httpStatusCode === 404`. It pointedly does **not** sniff the message.
It is called from exactly one site — the index read at `index.ts:506`.

The provider knows precisely when an object is missing; it discards that
knowledge before the caller sees it, and its callers try to reconstruct it from
an error message.

### 2.2 The hazard the sniff carries

`sentinel-read.ts:30-33` documents its own blast radius: `/not found/i` is a
substring match, so an unrelated failure — DNS, misconfiguration, a throttle —
whose text happens to contain that phrase is reclassified as `absent`. For a
consumer that maps `absent` to "this dispatch produced nothing," a transient
infrastructure error becomes a durable business fact.

---

## 3. Design

### 3.1 Core

Add to `packages/pangolin-core/src/errors.ts`, alongside the six error classes
already there (`errors.ts:12,25,37,47,58,69`):

```ts
export class StorageNotFoundError extends Error {
  constructor(
    readonly uri: string,
    message = `storage object not found: ${uri}`,
  ) {
    super(message);
    this.name = 'StorageNotFoundError';
  }
}
```

**`uri` is always the caller-facing `pangolin://…` URI, never a backend key.**
This must be stated because it is not free to honour: `S3StorageProvider.get`
receives `uri` at `index.ts:225` but calls `this.getDispatchRecord(parsed)` at
`:228` without it, and that method's only in-scope identifier is an S3 key
(`:446`). Threading `uri` into `getDispatchRecord` is part of §3.2. The local
provider already passes it (`storage-local/src/index.ts:314-317`). Without this
rule the two providers would populate the same field with different URI spaces —
the provider-divergence-by-accident that §2 exists to eliminate.

`uri` has **no readers** in this release; it is diagnostic surface for logs and
future callers, and is recorded as such rather than left to look load-bearing.

**The optional `message` preserves existing diagnostics.**
`LocalStorageProvider` throws two *distinct* messages — "blob not found for URI"
(`storage-local/src/index.ts:286`) and "dispatch record not found for URI"
(`:329`) — and two tests assert on that specificity:
`packages/pangolin-storage-local/test/smoke.test.ts:58-63` matches
`/blob not found/i`, and `test/integration.test.ts:315-318` matches `/not found/i`
on the dispatch-record path. Providers pass their existing message; the type
carries the signal. `S3StorageProvider` has no not-found message today (neither
`index.ts:230-243` nor `:443-449` has a catch), so it takes the default — a
deliberate, stated asymmetry rather than an oversight.

`StorageProvider.get` (`packages/pangolin-core/src/storage.ts:18`) gains a
contract note: an object that does not exist **must** throw
`StorageNotFoundError`. `resolveLatest`, `list`, and `resolveByHash` already
return `null` for absence and are unchanged.

**Detection is one exported helper.** Core exports
`isStorageNotFound(err: unknown): boolean` — `err instanceof StorageNotFoundError
|| err?.name === 'StorageNotFoundError'`, null-safe and non-object safe. Both
callers in §3.3 use it, so there is one definition of "is this a not-found."

It is **not** a type predicate: a `name` comparison cannot soundly narrow to the
class. This costs nothing here — neither call site reads `.uri`.

The `name` leg is the one that matters, per the documented convention at
`errors.ts:1-5`: *"Each error class sets `name` to its class name so callers can
use `err.name === 'IntegrityMismatchError'` for structural matching, even across
realms / serialized payloads."* The `instanceof` leg is cheap insurance for the
single-copy case and mirrors the shape ai-os already uses
(`packages/adapter-pangolin-dispatch/src/executor.ts:73-75`, rationale at
`:68-72`). It adds no behaviour the `name` leg does not already cover.

**This is the fix `sentinel-read.ts:26-29` asks for, not the one it forbids.**
That comment objects to hoisting *provider quirk-detection* into core, then names
the real defect itself: "`StorageProvider` has no typed not-found signal, so every
caller sniffs." This change puts a typed *class* in core and leaves *detection*
in the provider (`storage-s3/src/index.ts:112-121`, which stays private).

### 3.2 Providers

- `LocalStorageProvider.getBlob` — `index.ts:286` rethrows `ENOENT` as a generic
  `Error`; it throws `StorageNotFoundError` with the same message.
- `LocalStorageProvider.getDispatchRecord` — same at `index.ts:329`.
- `S3StorageProvider.get` — the blob branch is **inline in `get()`** at
  `index.ts:230-243` (there is no `getBlob` method on this class); it gains a
  not-found catch using the existing `isNotFound` at `index.ts:112`.
- `S3StorageProvider.getDispatchRecord` — `index.ts:443-449`, same, **and its
  signature gains the `uri`** threaded from `get()` at `:228` (§3.1). **This is
  the call that fixes §2.**

`AwsS3MailboxClient` already hand-rolls a third not-found shape
(`packages/pangolin-storage-s3/src/aws-s3-mailbox-client.ts:18`). It is a
different interface and out of scope, but the implementation must reuse
`isNotFound` rather than add a *fourth* variant.

### 3.3 Callers whose behaviour changes

Both are **read** paths. Each narrows to "if `isStorageNotFound(err)`, today's
behaviour; otherwise rethrow." A genuinely absent object keeps current
semantics; only errors that were *misclassified* as absent change.

| Site | Absent → | Previously-misclassified transient → |
|---|---|---|
| `pangolin-product/src/sentinel-read.ts:20` | `{ status: 'absent' }` | throws; local `isNotFound` (`:34-39`) and its blast-radius comment deleted |
| `pangolin-client/src/retention.ts:85` | `null` | throws; local `isNotFound` (`:90-97`) deleted |

Two copies of the heuristic become zero. The third
(`pangolin-client/src/dispatch.ts:520-527`) is deferred with its siblings — §6.1.

**`readDispatchRecord`'s two consumers need no code change**, which is worth
stating because an earlier revision wrongly claimed otherwise:

- `describeDispatch` (`packages/pangolin-client/src/describe.ts:41-42`) already
  documents the post-change behaviour at `describe.ts:33-35`: *"Throws
  `DispatchRecordExpiredError` if `readDispatchRecord` returns `null` … Unrelated
  storage errors are re-thrown unchanged."* `retention.ts:72-74` says the same
  ("Re-throws any other backend error"), and `describe.test.ts:160-180` pins it
  with a storage that throws `'S3 bucket policy denies access'`. Nothing breaks;
  the only delta is that an error whose message *happens* to contain "not found"
  stops being misclassified — §2.2's hazard, removed. **This is not a breaking
  change and must not be listed as one.**
- `cancelDispatch` (`packages/pangolin-client/src/cancel.ts:32`) likewise does not
  catch, so a non-not-found backend error already rejects it today. Its header
  comment (`cancel.ts:17-21`) claims "failures of any participant (storage,
  credentials, provider) collapse to a silent no-op," which is **already
  inaccurate** against `retention.ts:86`. **Decision: correct the comment, change
  no code.** Wrapping the call to make the comment true would add an
  unconditional swallow — including of the `JSON.parse` at `retention.ts:83`,
  turning a corrupt `record.json` into a silent no-op — which is the opposite of
  this spec's direction.

### 3.4 Callers deliberately left alone

**Every `readOutputSentinel` swallow stays.** In particular
`pangolin-orchestrator/src/executors/dispatch.ts:215`'s
`.catch(() => ({ status: 'absent' }))` is a documented contract at `:199-206` —
"NEVER throws — `absent`, `malformed`, and a rejected promise (unrelated storage
errors) all yield an empty object" — and removing it strands the run:

1. `reconcile()` deletes the in-flight entry (`dispatch.ts:165`) and calls
   `entry.inflight.cleanup()` (`:171`) **before** `readSentinel` at `:174`.
2. A throw at `:174` escapes `reconcile()`. `engine/tick.ts:90` does not wrap
   that call, so the rest of the tick — later items, the audit-seal block — is
   abandoned.
3. On the next tick `reconcile` returns `null` (`dispatch.ts:164`) because the
   entry is gone. The item stays `running` until a configured `maxRuntimeMs`
   overrun (`tick.ts:74-88`) frees it, if one is configured at all.

An earlier revision proposed removing this as "papering over §2." It is not;
§2's fix simply makes it fire far less often. The same reasoning covers
`cmd-orch.ts:240` and both `examples/` paths (§2).

### 3.5 Sweep: doubles and stubs that encode the deleted behaviour

Deleting the sniff invalidates every double that signals absence by message or
`ENOENT`. **The plan runs an explicit sweep**, because three prior revisions of
this spec each shipped a table claimed complete that was not. The list below is
the sweep's known starting point, not a completeness claim.

**Scope — five trees.** The four `pnpm-workspace.yaml` roots (`packages/*`,
`examples/*`, `deploy/*`, `docs-site`) **plus `test/`** — `test/e2e/` and
`test/monorepo-bootstrap.test.ts` sit outside every workspace root and have their
own runner (`vitest.e2e.config.ts`), so a workspace-scoped sweep would miss them.

**Pass criterion.** Grep every `.ts` under those five trees for `/not found/i`,
`ENOENT`, and `NoSuchKey`. For each hit, record either "reaches `storage.get` on
a §3.3 path" (→ must throw `StorageNotFoundError`) or "does not" (→ no change,
reason noted). The sweep is complete when every hit carries one of those two
dispositions — not when someone has "looked."

**Assertion of the deleted behaviour — this inverts:**

- `packages/pangolin-product/test/sentinel-read.test.ts:40` — *"returns absent
  when the provider throws an error whose message matches `/not found/i`"*.
  Becomes §4's regression test: such a message is **not** absent.

**Doubles that must throw `StorageNotFoundError`:**

- `packages/pangolin-product/test/sentinel-read.test.ts:28` (ENOENT-coded)
- `packages/pangolin-client/test/retention.test.ts:8,24,174`
- `examples/appendable-stream/src/index.ts:237-241` — a **src** stub whose entire
  contract is the deleted message. Behaviourally inert today (its consumer
  `assembleBundle` absorbs any throw at
  `packages/pangolin-orchestrator/src/audit/bundle.ts:41-47`), but it must move.

**Doubles that would silently stop testing what their name claims** — no red
suite, which makes them the more dangerous class:

- `packages/pangolin-orchestrator/test/dispatch-sentinel-read.test.ts:84` throws
  `memory storage: not found: ${uri}`, and its header comment at `:28-30` says so
  explicitly ("matching pangolin-product's isNotFound sniff") — a comment that
  becomes a false statement about deleted code. Its test at `:235` currently
  exercises the genuine `absent` branch; after the change it would exercise the
  `.catch` at `executors/dispatch.ts:215` instead, becoming a duplicate of `:268`
  while still claiming absent coverage.
- `packages/pangolin-orchestrator/test/executors/dispatch.test.ts:72`, test at
  `:725`, same pattern.
- `packages/pangolin-cli/test/cmd-orch.test.ts:561-565` — the double for the
  duck-typed storage §3.6 calls out; after the change it exercises the `catch {}`
  at `cmd-orch.ts:240` rather than the `absent` branch.

All move to `StorageNotFoundError` so the real `absent` coverage survives.

`packages/pangolin-client/test/dispatch-dedupe.test.ts:73` and
`test/cancel.test.ts` / `test/describe.test.ts` are **not** in scope: their paths
are unchanged by §3.3 (`markerPresent` deferred; `describe`/`cancel` unchanged per
§3.3).

### 3.6 Blast radius

Any `StorageProvider` that does not throw the typed error now surfaces a missing
object as an unhandled infrastructure throw rather than `absent`/`null`. Per §1.3
there are none outside this repo — but there are duck-typed `{ get }` storages
**inside** it, in src, cast to `StorageProvider`: `OrchContext.storage` at
`packages/pangolin-cli/src/cmd-orch.ts:38`, cast at `:235`. That one is
behaviourally safe only because of the `catch {}` at `:240`, which is worth
stating rather than leaving to be rediscovered.

---

## 4. Testing

**Provider translation — lives in the provider packages.**

- `LocalStorageProvider` `ENOENT` → `StorageNotFoundError` on both the blob and
  dispatch-record paths, **with the existing messages preserved** so
  `smoke.test.ts:58-63` and `integration.test.ts:315-318` pass unchanged (§3.1),
  and with `.uri` carrying the `pangolin://` URI.
- `S3StorageProvider` `NoSuchKey` → `StorageNotFoundError` on both paths, **with
  the fixture constructed as a real `NoSuchKey` instance** so
  `err instanceof NoSuchKey` (`index.ts:113`) is genuinely exercised rather than
  the `name` fallback. `.uri` carries the `pangolin://` URI, not the S3 key —
  this is the assertion that pins the §3.1/§3.2 threading. The LocalStack-gated
  `packages/pangolin-storage-s3/test/integration.test.ts` is not extended.

**Read-path classification — lives in `pangolin-product` / `pangolin-client`.**

`packages/pangolin-product` declares `dependencies: { pangolin-core }` and no
devDependencies (`package.json:34-37`), and its stated identity is "Depends only
on pangolin-core" (`package.json:5`). Its tests therefore use a double that
throws `StorageNotFoundError` — **they must not import a storage provider**, and
the plan must not add that dep edge. The provider tests above are what connect
the chain; neither half is sufficient alone, and that split is deliberate.

- **Regression for §2:** `readOutputSentinel` returns `{ status: 'absent' }` when
  the provider throws `StorageNotFoundError`, asserted directly rather than
  through any swallowing caller.
- **The inversion:** a provider throwing a generic `Error` whose message contains
  "not found" is **not** treated as absent. This is `sentinel-read.test.ts:40`
  turned around, and it fails today.
- `readDispatchRecord` returns `null` for `StorageNotFoundError` and **rethrows**
  a generic error (already true per `retention.test.ts:214`; re-pinned against the
  new mechanism).
- `describeDispatch` still converts `null` → `DispatchRecordExpiredError` and
  still propagates a generic storage error unchanged — `describe.test.ts:160-180`
  passes without modification (§3.3).

**§3.4 characterisation:** `readSentinel` still returns `{}` when the underlying
read rejects, so `reconcile` completes and the item does not strand. This pins the
`.catch` that must not be removed.

No test is specified for "`isStorageNotFound` matches across duplicate
`pangolin-core` copies." Within one vitest process there is a single module copy,
so the only expressible test is `const e = new Error(); e.name = '…'` — which
proves a name comparison compares names. That is the vacuity this spec rejects
elsewhere; the cross-copy behaviour is a property of the design, not something
this suite can assert.

---

## 5. Consumer impact (ai-os) — two hard preconditions

The fix does **not** reach ai-os automatically. Neither precondition is currently
true.

**1. ai-os unifies on the 0.4 `pangolin-core`.**
`packages/adapter-pangolin-dispatch/package.json:12-13` pins `pangolin-client`
and `pangolin-core` at `^0.3.0`; on 0.x a caret pins the minor, so a mixed tree
resolves **two** `pangolin-core` copies. The child-3 plan's read adapter maps a
tampered artifact via a bare `instanceof IntegrityMismatchError` with no `name`
fallback (plan `:475-477`) — under two copies that check silently fails and a
**tampered artifact is misclassified as an infra throw**. That alone requires a
single core copy.

Consequently the plan's "two core majors resolve side-by-side" design must be
withdrawn — it is asserted in five places, not one: `:14` (DAG node label), `:44`,
`:52`, `:445-446` (the design prose), and `:492` (the acceptance criterion).
Updating only the AC leaves the prose contradicting it. Note child-3 also adds a
third and fourth dependency line (`pangolin-product` and `pangolin-core` on the
new read package), so "bump both pins" is really "land all four on the 0.4
train."

**2. Whatever `StorageProvider` ai-os injects must throw `StorageNotFoundError`.**
The §2 fix lives in the *providers* (§3.2), not in `pangolin-product`;
`readOutputSentinel` only stops sniffing. An ai-os tree that pins
`pangolin-product@^0.4.0` alongside a `0.3.x` provider gets the deleted sniff and
no typed throw — **strictly worse than today**. ai-os declares no
`@quarry-systems/pangolin-storage-*` dependency at present, and
`createPangolinClient` (`packages/adapter-pangolin-dispatch/src/client.ts:12`) is
exported but never called, so the provider is genuinely unchosen. Either a
bundled `pangolin-storage-*@^0.4.0` or an ai-os implementation honouring the
contract satisfies this; the choice belongs to ai-os's plan.

**The BLOCKED gate does not pass until this release publishes.** Its wording is
"verify the *published* `pangolin-product@^0.4.0` actually exports
`readOutputSentinel` + `fetchDispatchArtifact`" (plan `:437-439`). The source
barrel (`packages/pangolin-product/src/index.ts:7-12`) exports all four symbols,
but no `0.4.0` exists on npm — `git tag` tops out at `v0.3.1`.

**No product-read size bound ships in 0.4.0** (§6.2), and **no dispatch fire-path
behaviour changes** (§6.1). ai-os's dispatch dedupe guard stays fail-open exactly
as today.

---

## 6. Out of scope

### 6.1 All three `dispatch.ts` not-found catches

`markerPresent` (`packages/pangolin-client/src/dispatch.ts:520-527`, dedupe guard
opens on a transient error), `readSubagentCapabilities` (`:681-684`, fires with
**zero capabilities**), and the env-bundle read (`:743-751`, launches **without
secrets**) are all fail-open on this same gap. They defer **as one unit** because
they share a root cause and a consumer-visible failure mode:

- **Consumer un-retryability.** A throw out of `fireWork` reaches ai-os's action
  seam, which durably records `action.failed`
  (`packages/action/src/handle.ts:29-36`) and then early-returns on any
  redelivery whose `causedBy` already has an event (`handle.ts:16`). No consumer
  re-fires. So narrowing *any* of the three converts a transient blip into a
  permanent, un-retryable failure. An earlier revision kept `markerPresent` on
  the argument that it throws before anything is staged — true inside Pangolin
  (`dispatch.ts:133` precedes the marker write at `:136`), but the argument was
  scoped to the wrong boundary.
- **Marker ordering.** `:681` and `:743` additionally run *after* the durable
  marker (`resolveCapabilities` at `:147`, `flattenEnvBundleSecrets` at `:327`),
  so a throw leaves the marker with no container started; on retry
  `markerPresent` returns `true` → `DispatchAlreadyExistsError`, which ai-os
  treats as benign success (`adapter-pangolin-dispatch/src/executor.ts:73-77`) —
  the dispatch never ran and is recorded as `action.completed`.
- **Stranded credentials.** The env-bundle throw lands after per-dispatch secrets
  are staged (`dispatch.ts:178`) and the callback HMAC is minted (`:193`), and
  `cleanup()` (`:463-467`) is reachable only through the returned
  `InFlightDispatch` — which `fireWork`'s callers never receive on the throw path
  (`dispatchWork` calls it at `:500`, outside the `try/finally` at `:501-506`).

The follow-up must address marker ordering (or rollback), reachable cleanup, and
the consumer's retry story together. **Leaving all three alone regresses
nothing:** they are fail-open today and stay exactly as they are.

### 6.2 Bounded product reads

The `head()` size-ceiling design shared this spec through rev 3 and is deferred
whole:

- The proposed fixed 1 MiB sentinel ceiling does not survive the real worst case.
  Block count has no write-side cap (`packages/pangolin-core/src/pipeline.ts:94`
  rejects only an *empty* `blocks` array;
  `packages/pangolin-worker/src/pipeline-runner.ts:464` passes every outcome to
  `writeSentinel`), and each `BlockOutcome` carries a `verify.report` up to a
  caller-overridable `DEFAULT_REPORT_LIMIT = 8_000`
  (`packages/pangolin-worker/src/verify.ts:28,31`) plus up to 256 outputs.
- An optional `head` feeds a systematic error into the §3.4 swallows, turning
  "produced nothing" from transient into permanent for any provider without it.
- The read inventory must be rebuilt across `examples/` (five further
  `storage.get` sites beyond the twelve in `packages/*/src`), `deploy/`, and
  `test/`.

### 6.3 Also deferred

- **Bounding `readDispatchRecord`.** `pangolin-client` does not depend on
  `pangolin-product`, so the size guard would cross a package boundary. A cost
  decision, **not** a safety one: the worker's credential *can* write
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
  the six merged PRs plus this change. A **Breaking** heading names exactly one
  thing: the `StorageProvider.get` not-found contract. §2 is listed under
  **Fixed** as a provider-dependent `absent` path. `describeDispatch` and
  `cancelDispatch` are **not** listed as breaking (§3.3).
- `packages/pangolin-core/src/storage.ts` — the `get` contract note.
- `packages/pangolin-client/src/cancel.ts:17-21` — correct the no-op comment,
  which is already inaccurate against `retention.ts:86` (§3.3).
- `docs-site/src/content/docs/how-to/write-a-provider.md:126-166` — reproduces
  the `StorageProvider` interface literally; it gains the `get` not-found MUST.
  This is the page a future implementor reads. It is **not** in the guarded file
  list of `docs-site/test/product-read-docs.test.ts:91-108`, so the edit is
  unconstrained.
- `docs-site/src/content/docs/reference/dispatch-lifecycle.md:200-207` — states
  "A missing sentinel comes back as `{ status: 'absent' }` rather than throwing."
  That stays true and gains the provider-contract reason it now rests on.
- No change to `docs-site/test/product-read-docs.test.ts`. Its guard forbids
  documenting a `head()` probe or size-bounded read — correct, since §6.2 defers
  exactly that surface.
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

Five audit rounds. The pattern was consistent enough to be worth recording: every
round's blocking findings landed in text the *previous* round had added, while §2
— the original defect and its evidence — came back "verified, do not touch" every
time. The resolution was not to keep fixing but to keep cutting, until what
remained was only what had never moved.

**rev 6** — dropped `markerPresent` from scope, leaving zero fire-path changes.
Its "safe to narrow" argument (nothing staged before `dispatch.ts:133`) was true
inside Pangolin but scoped to the wrong boundary: at ai-os a throw becomes a
durable, un-retryable `action.failed` (`packages/action/src/handle.ts:16,29-36`).
All three `dispatch.ts` catches now defer as one unit (§6.1). Also: withdrew the
false claim that `describeDispatch` breaks (`describe.ts:33-35` has always
documented the rethrow, and `describe.test.ts:160-180` pins it) and the **Breaking**
changelog entry it would have produced; dropped the `cancelDispatch` wrap in
favour of correcting its already-inaccurate comment; pinned `StorageNotFoundError.uri`
to the `pangolin://` URI and threaded it into `S3StorageProvider.getDispatchRecord`,
which could not construct it; resolved where the §2 regression test lives without
inverting `pangolin-product`'s dependency layering; extended the sweep to `test/`
(a fifth tree outside every workspace root) and gave it a pass criterion.

**rev 5** — reversed §5: bumping ai-os's pins is correctness, not hygiene; added
the provider precondition; mandated a sweep in place of a third "complete" table.

**rev 4** — cut scope to typed-not-found only; deferred `dispatch.ts:681`/`:745`
and all bounded-read work.

**rev 3** — reverted required-`head` (double assertions bypass structural
checking) and the orchestrator `.catch` removal (strands the run); corrected the
artifact-immunity argument to content-derived blob keys.

**rev 2** — corrected the 64 MiB default against the worker's 100 MiB write cap;
named the oversize outcomes; corrected the non-existent `S3StorageProvider.getBlob`.
