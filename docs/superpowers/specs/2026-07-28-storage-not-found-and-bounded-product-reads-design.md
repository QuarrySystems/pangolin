# Typed storage not-found

**Status:** design proposed 2026-07-28 · **Author:** agent:claude-opus-5 (with Brett) · **Confidence:** high
**Revision:** rev 5 — four audit rounds. See §9.

A missing storage object becomes a typed `StorageNotFoundError` instead of a
message the caller has to sniff. Today that sniff silently breaks the `absent`
path on S3: a finished dispatch with no output sentinel **throws** where the
published contract says it returns `{ status: 'absent' }`.

Bounded product reads — the `head()` size-ceiling work that shared this spec
through rev 3 — are deferred to their own spec (§6.2), as are two of the five
not-found call sites (§6.1).

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
object and deletes the compensating logic from three callers. That is a breaking
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

**This site is safe to narrow, and the safety is structural.** `markerPresent`
is called at `dispatch.ts:133`; the durable dedupe marker is not written until
`:136`. Nothing durable precedes the guard — `:112-116` is argument validation,
`:118` mints a local `dispatchId`, `:121-122` compute trace and timeout, `:132`
builds a URI string. No storage write, no `store.stage`, no callback-HMAC mint.
A rejection therefore rejects `fireWork` with nothing to clean up, and at the
orchestrator layer it lands on the safe side of a boundary that file already
names (`packages/pangolin-orchestrator/src/executors/dispatch.ts:88-90`):

> Container starts HERE. Anything that throws BEFORE this is a clean pre-start
> failure. Anything AFTER must NOT throw, or tick fails the item without
> recording the dispatchHash and the running container is orphaned.

Two sibling catches later in `dispatch.ts` do **not** have this property and are
deferred — §6.1.

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

**The optional `message` is deliberate.** `LocalStorageProvider` today throws two
*distinct* messages — "blob not found for URI" (`storage-local/src/index.ts:286`)
and "dispatch record not found for URI" (`:329`) — and a test asserts on the
specificity: `packages/pangolin-storage-local/test/smoke.test.ts:58-63`, named
*"get() surfaces a descriptive error for missing blob (not raw ENOENT)"*, matches
`/blob not found/i`. Collapsing both into one generic string would lose
diagnostics and turn that test red for no benefit. Providers pass their existing
message; the type carries the signal.

`StorageProvider.get` (`packages/pangolin-core/src/storage.ts:18`) gains a
contract note: an object that does not exist **must** throw
`StorageNotFoundError`. `resolveLatest`, `list`, and `resolveByHash` already
return `null` for absence and are unchanged.

**Detection uses a `name` comparison, exposed as one helper.** `errors.ts:1-5`
documents the convention:

> Each error class sets `name` to its class name so callers can use
> `err.name === 'IntegrityMismatchError'` for structural matching, even across
> realms / serialized payloads.

Core exports `isStorageNotFound(err: unknown): boolean` — null-safe, non-object
safe, **not** a type predicate (a name comparison cannot soundly narrow to the
class). All three call sites in §3.3 use the helper rather than inlining the
comparison, so there is one definition of "is this a not-found."

Note the nearest precedent is belt-and-braces rather than name-only: ai-os checks
`err instanceof DispatchAlreadyExistsError || err?.name === '…'`
(`packages/adapter-pangolin-dispatch/src/executor.ts:73-75`, with the rationale
at `:68-72`). `isStorageNotFound` does the same — `instanceof` first, `name`
fallback — so a single-copy tree gets exact matching and a mixed tree still
works.

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
- `S3StorageProvider.getDispatchRecord` — `index.ts:443-449`, same. **This is
  the call that fixes §2.**

`AwsS3MailboxClient` already hand-rolls a third not-found shape
(`packages/pangolin-storage-s3/src/aws-s3-mailbox-client.ts:18`,
`if (e instanceof NoSuchKey) return null`). It is a different interface and out
of scope, but the implementation must reuse `isNotFound` rather than add a
*fourth* variant.

### 3.3 Callers whose behaviour changes

Each narrows to "if `isStorageNotFound(err)`, today's behaviour; otherwise
rethrow." A genuinely absent object keeps current semantics; only transient
errors change.

| Site | Absent → | Transient → (new) |
|---|---|---|
| `pangolin-product/src/sentinel-read.ts:20` | `{ status: 'absent' }` | throws; local `isNotFound` (`:34-39`) and its blast-radius comment deleted |
| `pangolin-client/src/retention.ts:85` | `null` | throws; local `isNotFound` (`:90-97`) deleted |
| `pangolin-client/src/dispatch.ts:520-527` | `false` | throws (§2.3 — pre-marker, strands nothing) |

Three copies of the heuristic become zero.

**`readDispatchRecord` has two downstream consumers that inherit the change**, and
one of them has a contract that the change breaks:

- `describeDispatch` (`packages/pangolin-client/src/describe.ts:41-42`) turns a
  `null` record into `DispatchRecordExpiredError`. A transient error now
  propagates raw instead — arguably more correct, since "expired" was a lie about
  a throttle, but it is a visible API change and the changelog says so.
- `cancelDispatch` (`packages/pangolin-client/src/cancel.ts:32`) is documented at
  `cancel.ts:17-21` as: "Returns `undefined` unconditionally; failures of any
  participant (storage, credentials, provider) collapse to a silent no-op per
  §7.6's idempotency contract." A rethrow violates that. **Decision:** preserve
  the documented contract — `cancelDispatch` wraps its `readDispatchRecord` call
  so any error still collapses to a no-op. It is the one place where swallowing
  is the specified behaviour rather than an accident, and this spec is not the
  place to renegotiate §7.6.

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

### 3.5 Doubles and stubs that encode the deleted behaviour

Deleting the sniff invalidates every double that signals absence by message or
`ENOENT`. **The plan must run an explicit sweep across all four workspace roots**
(`packages/*`, `examples/*`, `deploy/*`, `docs-site` per `pnpm-workspace.yaml`) —
three prior revisions of this spec each shipped an "enumerated, complete" table
that was not, so the sweep is a required step and the list below is its known
starting point, not a claim of completeness.

**Assertions of the deleted behaviour — these invert, they do not get updated:**

| Site | Action |
|---|---|
| `packages/pangolin-product/test/sentinel-read.test.ts:40` — *"returns absent when the provider throws an error whose message matches `/not found/i`"* | Becomes §4's regression test: such a message is **not** absent. |
| `packages/pangolin-client/test/cancel.test.ts:122` — *"is a no-op when the dispatch record is missing (not-found message)"* | Per §3.3 `cancelDispatch` still no-ops, so this survives — but it must be re-grounded on the wrap, not the sniff, or it passes for a deleted reason. |

**Doubles that must throw `StorageNotFoundError`:**

- `packages/pangolin-product/test/sentinel-read.test.ts:28` (ENOENT-coded)
- `packages/pangolin-client/test/retention.test.ts:8,24,174`
- `packages/pangolin-client/test/dispatch-dedupe.test.ts:73`
- `packages/pangolin-client/test/cancel.test.ts:19-42,44-62`
- `packages/pangolin-client/test/describe.test.ts:12-33,62-77` — tests at `:61,85,93`
  reach `DispatchRecordExpiredError` only via the sniff
- `examples/appendable-stream/src/index.ts:237-241` — a **src** stub whose entire
  contract is the deleted message. Behaviourally inert today (its consumer
  `assembleBundle` absorbs any throw at
  `packages/pangolin-orchestrator/src/audit/bundle.ts:41-47`), but it must move.

**Doubles that would silently stop testing what their name claims** — these
produce no red suite, which makes them the more dangerous class:

- `packages/pangolin-orchestrator/test/dispatch-sentinel-read.test.ts:84` throws
  `memory storage: not found: ${uri}`, and its header comment at `:28-30` says so
  explicitly ("matching pangolin-product's isNotFound sniff") — a comment that
  becomes a false statement about deleted code. Its test at `:235`, *"reconcile
  yields no patchRef/verify/outputRefs when the sentinel is absent"*, currently
  exercises the genuine `absent` branch; after the change it would exercise the
  `.catch` at `executors/dispatch.ts:215` instead, becoming a duplicate of `:268`
  while still claiming absent coverage.
- `packages/pangolin-orchestrator/test/executors/dispatch.test.ts:72`, same
  pattern, test at `:725`.

Both doubles move to `StorageNotFoundError` so the orchestrator keeps real
`absent` coverage.

### 3.6 Blast radius

Any `StorageProvider` that does not throw the typed error now surfaces a missing
object as an unhandled infrastructure throw rather than `absent`/`null`. Per §1.3
there are none outside this repo — but there are duck-typed `{ get }` storages
**inside** it, in src, cast to `StorageProvider`: `OrchContext.storage` at
`packages/pangolin-cli/src/cmd-orch.ts:38`, cast at `:235`. That one is
behaviourally safe only because of the `catch {}` at `:240`, which is worth
stating rather than leaving to be rediscovered. The contract change is called out
in the changelog as breaking.

---

## 4. Testing

- **A provider throwing a generic `Error` whose message contains "not found" is
  not treated as absent.** This is `sentinel-read.test.ts:40` inverted, and it is
  the point of the change.
- **Regression for §2:** a missing sentinel on an S3-backed provider returns
  `{ status: 'absent' }`. Asserted on `readOutputSentinel` directly, not through
  any swallowing caller. This fails today.
- `LocalStorageProvider` `ENOENT` → `StorageNotFoundError` on both the blob and
  dispatch-record paths, **with the existing messages preserved** so
  `storage-local/test/smoke.test.ts:58-63` passes unchanged (§3.1).
- `S3StorageProvider` `NoSuchKey` → `StorageNotFoundError` on both paths. **Unit
  tests, with the fixture constructed as a real `NoSuchKey` instance** so
  `err instanceof NoSuchKey` (`index.ts:113`) is genuinely exercised rather than
  the `name` fallback. The LocalStack-gated
  `packages/pangolin-storage-s3/test/integration.test.ts` is not extended.
- `readDispatchRecord` returns `null` for a missing record and **rethrows** a
  generic error; `describeDispatch` propagates that rethrow rather than
  converting it to `DispatchRecordExpiredError`; `cancelDispatch` still resolves
  `undefined` for **both** (§3.3).
- `markerPresent` returns `false` for `StorageNotFoundError` and **rethrows** a
  generic error, **and a rethrow leaves no dedupe marker written**
  (`dispatch.ts:136` never reached). The existing double already makes this
  observable: `packages/pangolin-client/test/dispatch-dedupe.test.ts:19` records
  `storage.put:${uri}` into a shared `callOrder` array at `:53`, and `:264`
  already asserts marker absence by that mechanism.
- **§3.4 characterisation:** `readSentinel` still returns `{}` when the underlying
  read rejects, so `reconcile` completes and the item does not strand. This pins
  the `.catch` that must not be removed.

No test is specified for "`isStorageNotFound` matches across duplicate
`pangolin-core` copies." Within one vitest process there is a single module copy,
so the only expressible test is `const e = new Error(); e.name = '…'` — which
proves a name comparison compares names. That is the vacuity this spec rejects
elsewhere; the cross-copy behaviour is a property of the design, not something
this suite can assert.

---

## 5. Consumer impact (ai-os) — two hard preconditions

The fix does **not** reach ai-os automatically. Both of these are required, and
neither is currently true.

**1. Both dependency lines move to `^0.4.0`.**
`packages/adapter-pangolin-dispatch/package.json:12` pins `pangolin-client` and
`:13` pins `pangolin-core`, both at `^0.3.0`; on 0.x a caret pins the minor. Left
alone, ai-os stays on `pangolin-client@0.3.1`, whose `markerPresent` still
swallows every throw — so §2.3's fix, the one site this spec argues is safe to
narrow, **is never delivered to the only consumer that uses it.** ai-os sets
`dedupeOnDispatchId: true` (`packages/adapter-pangolin-dispatch/src/executor.ts:56`)
and is that consumer. This is correctness, not hygiene, and it means the child-3
plan's "resolving `pangolin-core` 0.3 and 0.4 side-by-side" acceptance criterion
(plan `:492`) must be dropped.

**2. Whatever `StorageProvider` ai-os injects must throw `StorageNotFoundError`.**
The §2 fix lives in the *providers* (§3.2), not in `pangolin-product`;
`readOutputSentinel` only stops sniffing. An ai-os tree that pins
`pangolin-product@^0.4.0` alongside a `0.3.x` provider gets the deleted sniff and
no typed throw — **strictly worse than today**. ai-os declares no
`@quarry-systems/pangolin-storage-*` dependency at present, and
`createPangolinClient` (`packages/adapter-pangolin-dispatch/src/client.ts:12`) is
exported but never called, so the provider is genuinely unchosen. Either a
bundled `pangolin-storage-*@^0.4.0` or an ai-os implementation honouring the
contract satisfies this; the choice belongs to ai-os's plan, not to this spec.

Also unchanged from earlier revisions: **the BLOCKED gate does not pass until
this release publishes.** Its wording is "verify the *published*
`pangolin-product@^0.4.0` actually exports `readOutputSentinel` +
`fetchDispatchArtifact`" (plan `:437-439`). The source barrel
(`packages/pangolin-product/src/index.ts:7-12`) exports all four symbols, but no
`0.4.0` exists on npm — `git tag` tops out at `v0.3.1`, and §8 is the step that
creates it.

**No product-read size bound ships in 0.4.0** (§6.2). ai-os's read adapter will
fetch artifacts unbounded, exactly as it would have before this spec existed;
ai-os controls its own provider and can bound reads there in the interim.

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
  throw leaves the marker behind with no container started. On retry
  `markerPresent` returns `true` → `DispatchAlreadyExistsError`, which ai-os
  treats as benign and reports as success
  (`packages/adapter-pangolin-dispatch/src/executor.ts:73-77`). One storage blip
  would mean the dispatch never ran, cannot be retried, and is durably recorded
  as `action.completed`.
- The env-bundle throw also lands **after** per-dispatch secrets are staged
  (`dispatch.ts:178`) and the callback HMAC is minted (`:193`), and the
  compensating `cleanup()` (`:463-467`) is reachable only through the returned
  `InFlightDispatch` — which `fireWork`'s callers never receive on the throw path
  (`dispatchWork` calls it at `:500`, outside the `try/finally` at `:501-506`).
  Stranded credentials, from a credential-hygiene change.

Fixing these means moving or rolling back the dedupe marker and making staging
cleanup reachable on the throw path — the dispatch lifecycle, not the storage
contract. **Leaving them alone regresses nothing:** they are fail-open today and
stay exactly as they are.

### 6.2 Bounded product reads

The `head()` size-ceiling design shared this spec through rev 3 and is deferred
whole. It is not ready:

- The proposed fixed 1 MiB sentinel ceiling does not survive the real worst case.
  Block count has no write-side cap (`packages/pangolin-core/src/pipeline.ts:94`
  rejects only an *empty* `blocks` array;
  `packages/pangolin-worker/src/pipeline-runner.ts:464` passes every outcome to
  `writeSentinel`), and each `BlockOutcome` carries a `verify.report` up to a
  caller-overridable `DEFAULT_REPORT_LIMIT = 8_000`
  (`packages/pangolin-worker/src/verify.ts:28,31`) plus up to 256 outputs.
- An optional `head` feeds a systematic `StorageHeadUnsupportedError` into the
  §3.4 swallows, turning "produced nothing" from transient into permanent for any
  provider without `head`.
- The read inventory must be rebuilt across `examples/` (five further
  `storage.get` sites beyond the twelve in `packages/*/src`) and `deploy/`.

### 6.3 Also deferred

- **Bounding `readDispatchRecord`.** `pangolin-client` does not depend on
  `pangolin-product`, so the size guard would cross a package boundary. This is a
  cost decision, **not** a safety one: the worker's credential *can* write
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
  the six merged PRs plus this change. A **Breaking** heading names the
  `StorageProvider.get` not-found contract and `describeDispatch`'s changed
  behaviour on a transient error (§3.3). §2 is listed under **Fixed** as a
  provider-dependent `absent` path.
- `packages/pangolin-core/src/storage.ts` — the `get` contract note.
- `docs-site/src/content/docs/how-to/write-a-provider.md:126-166` — reproduces
  the `StorageProvider` interface literally; it gains the `get` not-found MUST.
  This is the page a future implementor reads. (It is **not** in the guarded file
  list of `docs-site/test/product-read-docs.test.ts:91-108`, so this edit is
  unconstrained.)
- `docs-site/src/content/docs/reference/dispatch-lifecycle.md:200-207` — states
  "A missing sentinel comes back as `{ status: 'absent' }` rather than throwing."
  That stays true and gains the provider-contract reason it now rests on.
- `packages/pangolin-client/src/cancel.ts:17-21` — the no-op contract comment
  stays accurate under §3.3's wrap; no edit needed, but the plan verifies it
  rather than assuming.
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

**rev 5 (2026-07-28)** — fourth audit round. The core design (§2, §2.3, §3.1–3.4,
§6) came back verified; every finding landed in the two sections rev 4 added to
justify its scope cut.

| Change | Driver |
|---|---|
| §5 reversed: bumping ai-os's pins is **correctness**, not hygiene | Without it ai-os stays on `pangolin-client@0.3.1` and §2.3's fix never reaches the only consumer that sets `dedupeOnDispatchId`. |
| §5 gains the provider precondition | The fix lives in the providers; ai-os declares no `pangolin-storage-*` dep and `createPangolinClient` is never called, so a 0.3.x provider + `pangolin-product@0.4` would be *worse* than today. |
| §5's "the read adapter matches on `err.name`" deleted | `adapter-pangolin-read` does not exist; the bullet described non-existent code as fact, violating this spec's own evidence rule. |
| §3.3 gains `describe.ts:41` and `cancel.ts:32`; `cancelDispatch` gets a wrap | Two `readDispatchRecord` consumers were unnamed, and `cancel.ts:17-21` documents an unconditional no-op that a rethrow would violate. |
| §3.5 drops the "enumerated, not swept" claim and mandates a sweep | Three revisions each shipped a table claimed complete that was not. Adds `cancel.test.ts`, `describe.test.ts`, `storage-local/test/smoke.test.ts`, and two orchestrator doubles that would have silently stopped testing `absent` while staying green. |
| `StorageNotFoundError` takes an optional message | A single generic string would flatten the local provider's two distinct messages and turn `smoke.test.ts:58-63` red. |
| `isStorageNotFound` is `instanceof`-then-`name`, not name-only | The cited ai-os precedent is belt-and-braces; rev 4 asserted name-only while citing an instance of both. |
| §4's cross-copy test dropped as vacuous | Unassertable in one vitest process by this spec's own standard. |
| §3.6 notes the in-repo duck-typed `{ get }` storages | Blast radius was scoped to "outside this repo"; `cmd-orch.ts:38` is inside it. |

**rev 4** — cut scope to typed-not-found only; deferred `dispatch.ts:681`/`:745`
(post-marker throws make a blip un-retryable *and* reported as success) and all
bounded-read work.

**rev 3** — reverted required-`head` (double assertions bypass structural
checking) and the orchestrator `.catch` removal (strands the run); corrected the
artifact-immunity argument to content-derived blob keys.

**rev 2** — corrected the 64 MiB default against the worker's 100 MiB write cap;
named the oversize outcomes; added `markerPresent`; corrected the non-existent
`S3StorageProvider.getBlob`.
