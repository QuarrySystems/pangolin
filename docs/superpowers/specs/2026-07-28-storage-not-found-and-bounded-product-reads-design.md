# Typed storage not-found + bounded product reads

**Status:** design proposed 2026-07-28 · **Author:** agent:claude-opus-5 (with Brett) · **Confidence:** high

Two changes to the storage contract, cut together as **0.4.0**. First: a missing
object becomes a typed `StorageNotFoundError` instead of a message the caller
has to sniff — which today silently breaks the `absent` path on S3. Second: the
two reads on the product path gain a size bound enforced *before* the bytes are
fetched, closing the volume half of the boundary `pangolin-product` already
defends.

**Evidence discipline for this spec.** Every factual claim about current behavior
carries a `file:line` citation. Claims about what *will* exist are marked as
decisions, not descriptions. §9 (documentation) may only describe surface that
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

### 1.2 Why 0.4.0 and not 0.3.2

The unreleased work alone would be a patch. **§3 is not additive:** it changes
what `StorageProvider.get` is required to do on a missing object and deletes the
compensating logic from both callers. That is a breaking change to the provider
contract, so the release is `0.4.0` and every package moves there in lockstep.
This also lets `pangolin-product` stay where it is rather than being walked
backwards.

### 1.3 No external consumers

Pangolin has no third-party `StorageProvider` implementors and no published
consumer other than ai-os, which is developed in step. Back-compatibility for
unknown implementors is therefore not a constraint on this design, and §3 spends
that freedom deliberately: it deletes the fallback rather than layering the
typed check on top of it.

---

## 2. Defect A — the `absent` path does not work on S3

`readOutputSentinel` promises that a missing sentinel is a normal outcome, not an
error. Its header comment states the reasoning:

> Missing objects become `absent` rather than throwing, because a finished
> dispatch with no sentinel is a normal outcome — `writeSentinel` is best-effort
> and the entrypoint emits `dispatch.finished` regardless.
> — `packages/pangolin-product/src/sentinel-read.ts:2-5`

On S3 it does not hold. The chain:

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

So on S3 a finished dispatch with no sentinel **throws** where the contract says
it returns `{ status: 'absent' }`. On the local provider it happens to work,
because `LocalStorageProvider`'s dispatch-record path throws a message that
contains the words "not found"
(`packages/pangolin-storage-local/src/index.ts:329`). The behaviour differs by
provider, and the provider that works does so by accident of phrasing.

The same defect sits on `readDispatchRecord`
(`packages/pangolin-client/src/retention.ts:82-88`), which returns `null` for a
missing record via an identical sniff at `retention.ts:90-97`.

### 2.1 The correct check already exists, one file away

`packages/pangolin-storage-s3/src/index.ts:112-121` defines a type-aware
`isNotFound`: `err instanceof NoSuchKey`, or `name` of `NoSuchKey`/`NotFound`, or
`$metadata.httpStatusCode === 404`. It pointedly does **not** sniff the message.
It is called from exactly one site — the index read at `index.ts:506` — and not
from `getBlob` or `getDispatchRecord`.

That is the whole shape of the bug. The provider knows precisely when an object
is missing; it discards that knowledge before the caller sees it, and two callers
try to reconstruct it from an error message. There are three copies of
`isNotFound` in the repo (`storage-s3/src/index.ts:112`,
`pangolin-product/src/sentinel-read.ts:34`, `pangolin-client/src/retention.ts:90`)
and only the one that never runs on the product path is correct.

### 2.2 The hazard the remaining copies carry

`sentinel-read.ts:28-33` documents its own blast radius: `/not found/i` is a
substring match, so an unrelated failure — DNS, misconfiguration, a throttle —
whose text happens to contain that phrase is reclassified as `absent`. For a
consumer that maps `absent` to "this dispatch produced nothing," a transient
infrastructure error is recorded as a durable business fact.

---

## 3. Design A — `StorageNotFoundError`

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

Assignment in the constructor, matching `IntegrityMismatchError`
(`errors.ts:69`) and `ArtifactRefRejectedError`
(`pangolin-product/src/artifact-ref.ts`).

`StorageProvider.get` (`packages/pangolin-core/src/storage.ts:18`) gains a
contract note: an object that does not exist **must** throw
`StorageNotFoundError`. `resolveLatest`, `list`, and `resolveByHash` already
return `null` for absence and are unchanged.

### 3.2 Providers

- `LocalStorageProvider.getBlob` — `index.ts:286` currently rethrows `ENOENT` as
  a generic `Error`; it throws `StorageNotFoundError` instead.
- `LocalStorageProvider.getDispatchRecord` — same at `index.ts:329`.
- `S3StorageProvider.getBlob` — `index.ts:225-243` has no not-found catch; it
  gains one using the existing `isNotFound` at `index.ts:112`.
- `S3StorageProvider.getDispatchRecord` — `index.ts:443-449`, same. **This is
  the call that fixes §2.**

### 3.3 Callers

- `pangolin-product/src/sentinel-read.ts` — `instanceof StorageNotFoundError`;
  local `isNotFound` (`:34-39`) deleted along with its blast-radius comment.
- `pangolin-client/src/retention.ts` — same; local `isNotFound` (`:90-97`)
  deleted.

Net: three copies of the heuristic become zero, and the one remaining
not-found decision lives in the provider that can actually make it.

### 3.4 Blast radius

A `StorageProvider` implementation that does not throw the typed error now
surfaces a missing object as an unhandled infrastructure throw rather than
`absent`/`null`. Per §1.3 there are no such implementations outside this repo.
The `StorageProvider` contract change is called out in the changelog as
breaking.

---

## 4. Defect B — both product reads are unbounded

`fetchDispatchArtifact` reads bytes named by the output sentinel, which is
written by the dispatch's own run. `packages/pangolin-product/src/artifact-ref.ts`
states the threat directly in its header: a product ref is an unhashed
overwrite-put, so following one unguarded lets an attacker aim the caller's
credential at another dispatch's or namespace's bytes.

`assertArtifactRef` closes *where the bytes come from*. Nothing closes *how many
bytes arrive*. `artifact-fetch.ts`'s own JSDoc concedes this:

> `StorageProvider.get` takes no size bound and the interface exposes no size
> metadata, so an oversized object cannot be pre-checked here. Bound it in your
> own provider (e.g. HeadObject/Content-Length before GetObject).

It names the correct mechanism and assigns it to the caller. A run that writes a
multi-gigabyte artifact takes down every consumer that reads its product.

### 4.1 Why a post-fetch length check cannot work

Both bundled providers fully buffer **and** hash before `get()` returns:
`packages/pangolin-storage-s3/src/index.ts:237-241` streams to a `Uint8Array`
then calls `computeContentHash`; `packages/pangolin-storage-local/src/index.ts:278-292`
does `readFile` then the same. A `bytes.length` check inside
`fetchDispatchArtifact` would run after two complete passes over the object. It
would stop an oversized buffer travelling downstream; it would not stop the
memory exhaustion. Rejected.

### 4.2 Why streaming `get()` is not the answer here

Streaming is feasible — `computeContentHash`
(`packages/pangolin-core/src/content-hash.ts:82-90`) is built on
`createHash('sha256')` with incremental `.update()`, so a chunked hash is a
modest addition rather than an architectural conflict. It is rejected on
proportion, not difficulty. There are twelve `storage.get(...)` call sites across
four packages (`pangolin-client` ×4, `pangolin-worker` ×4,
`pangolin-orchestrator` ×2, `pangolin-product` ×2). Eleven of them want whole
bytes immediately — `JSON.parse` on a manifest at
`pangolin-orchestrator/src/audit/bundle.ts:43`, bundle decoding across
`pangolin-worker/src/bundle-fetcher.ts:112,140,162,190`. Converting `get()` to a
stream makes those eleven re-buffer by hand to reach the state they start from
today. Exactly one site benefits: `artifact-fetch.ts:18`. Deferred; revisit only
if a second genuine streaming consumer appears.

### 4.3 The sentinel read needs the same bound

`sentinel-read.ts:18` is equally unbounded, and `output.json` is written by the
run, so it is attacker-influenced too. A hostile run that writes a multi-gigabyte
sentinel kills the consumer before any artifact ref is parsed.

The entry caps in `sentinel-parse.ts` do not help, for two reasons.
`buildBlocks` (`sentinel-parse.ts:74,136`) caps blocks at `MAX_OUTPUT_ENTRIES`
(256, `pangolin-core/src/product.ts:9`) and caps each block's own outputs at 256
again (`sentinel-parse.ts:96`) — 65,536 entries in the worst case — and `summary`
is copied with no length cap at all (`sentinel-parse.ts:125`). More
fundamentally, every one of those caps runs *after* `JSON.parse`. They bound the
resulting object, never the input. Only a byte ceiling protects the read.

---

## 5. Design B — `head?()` and defaulted byte ceilings

### 5.1 Core

`StorageProvider` gains an optional capability method, mirroring `listNames?`
(`packages/pangolin-core/src/storage.ts:51`) and its "providers that cannot,
omit it" posture:

```ts
/**
 * Object size without transferring the body. OPTIONAL: providers that cannot
 * answer omit it, and reads that carry a byte bound fail closed against them.
 */
head?(uri: string): Promise<{ size: number }>;
```

Ceilings live beside `MAX_OUTPUT_ENTRIES` in
`packages/pangolin-core/src/product.ts`, exported so a consumer can reason
relative to the default rather than guess it:

```ts
export const DEFAULT_MAX_SENTINEL_BYTES = 1_048_576;   // 1 MiB
export const DEFAULT_MAX_ARTIFACT_BYTES = 67_108_864;  // 64 MiB
```

`ArtifactTooLargeError` joins `CapabilityTooLargeError` (`errors.ts:25`) and
`PartialStateTooLargeError` (`errors.ts:47`), carrying `{ size, limit, uri }`.

### 5.2 Providers

`LocalStorageProvider.head` uses `stat`; `S3StorageProvider.head` uses
`HeadObjectCommand` → `ContentLength`, reusing the existing `isNotFound`
(`storage-s3/src/index.ts:112`) so a missing object throws
`StorageNotFoundError` from `head` as it does from `get`.

### 5.3 Read surface

Both reads take the same optional shape:

```ts
readOutputSentinel(deps, dispatchId, opts?: { maxBytes?: number | null })
fetchDispatchArtifact(storage, ref, expect, opts?: { maxBytes?: number | null })
```

Three tiers, and no path to an unbounded read that was not asked for in writing:

| `maxBytes` | Behaviour |
|---|---|
| omitted | the `DEFAULT_MAX_*` constant applies |
| a number | that bound applies |
| `null` | explicitly unbounded; documented as unsafe |

`null` exists because §5.4 fails closed: without an opt-out, a consumer whose
provider lacks `head()` could not read anything at all.

### 5.4 Fail closed

If a byte bound is in force and the provider does not implement `head`, the read
throws rather than fetching unbounded. This follows the house precedent at
`packages/pangolin-storage-s3/src/aws-s3-lock-client.ts:31-35`, which refuses to
guess on a truncated listing — "fail loud rather than silently pick a wrong
'earliest'."

### 5.5 Ordering is load-bearing

In `fetchDispatchArtifact` the sequence is **assert ref → head → get → verify
hash**.

`assertArtifactRef` must stay first. It is documented as throwing before any I/O
(`artifact-fetch.ts:17`), and `head()` *is* I/O against a caller-supplied URI.
Calling `head` on an unvalidated ref would point the caller's credential at an
arbitrary object — the precise attack `artifact-ref.ts` exists to prevent. A
size pre-check must never be allowed to become an oracle for refs the ref guard
would have rejected.

A cheap post-fetch length assertion stays as a second line: `head` is advisory
and a provider that under-reports must not be able to lift the ceiling. This is
not the primary control (§4.1) — it is a backstop on a lying `head`.

### 5.6 Note: artifacts are currently hashed twice

Both providers verify the content hash inside `get()`
(`storage-s3/src/index.ts:238-241`, `storage-local/src/index.ts:290-292`), and
`fetchDispatchArtifact` verifies again at `artifact-fetch.ts:19-20`. This is not
a defect: `StorageProvider` does not *require* implementors to verify, so the
package's guarantee must be its own rather than borrowed. It is recorded here
because a `head()` pre-check now avoids both passes on the rejection path, and
because a future reader will otherwise mistake the second hash for redundancy
and remove it.

---

## 6. Testing

**A.**
- A provider throwing a generic `Error` whose message contains "not found" is
  **not** treated as absent. This fails today and is the point of the change.
- `LocalStorageProvider` `ENOENT` → `StorageNotFoundError`, on both the blob and
  dispatch-record paths.
- `S3StorageProvider` `NoSuchKey` → `StorageNotFoundError`, on both paths.
- **Regression for §2:** a missing sentinel on an S3-backed provider returns
  `{ status: 'absent' }`. This is the bug; it must have a test that fails before
  the fix.
- `readDispatchRecord` returns `null` for a missing record on S3.

**B.**
- Oversized object → rejected **and the `get` spy was never called**. Asserting
  the rejection alone would pass against the useless post-fetch design; asserting
  `get` was not called is what proves memory protection.
- Bound in force + provider without `head` → throws (fail closed).
- `maxBytes: null` + provider without `head` → reads.
- A `head` that under-reports → caught by the post-fetch assertion.
- **A ref that fails `assertArtifactRef` → `head` was never called.** This pins
  §5.5; without it a later refactor can reorder the checks and reopen the
  credential-aiming path.
- Sentinel over `DEFAULT_MAX_SENTINEL_BYTES` → rejected before `get`.

---

## 7. Consumer impact (ai-os)

ai-os's child-3 plan already pins `pangolin-product@^0.4.0` and
`pangolin-core@^0.4.0`, so those pins become correct as written and need no edit.
Two consequential notes:

- The plan's BLOCKED gate — "verify the published `pangolin-product` actually
  exports `readOutputSentinel` + `fetchDispatchArtifact`" — is stale.
  `packages/pangolin-product/src/index.ts` exports all four symbols. The gate
  passes.
- `packages/adapter-pangolin-dispatch/package.json:12-13` pins
  `pangolin-client`/`-core` at `^0.3.0`. On 0.x a caret pins the minor, so
  `^0.3.0` does **not** match `0.4.0` and pnpm resolves two copies of
  `pangolin-core`. That is mostly harmless except that `instanceof` fails across
  duplicate copies of a class — and both §3 and §5 hand consumers
  `instanceof`-based error handling. **Bump the dispatch adapter to `^0.4.0` in
  the same ai-os change.** Nothing in `pangolin-client`'s surface moves in this
  release, so it is a version bump plus a lockfile.

---

## 8. Out of scope

- **Issue #103** (typecheck test files in the remaining 10 packages, 213 errors).
  Hygiene; nothing downstream waits on it; its own release.
- **Release automation** (RELEASING.md "Future"). Unchanged: 0.4.0 is cut by
  hand.
- **Streaming `get()`.** §4.2.
- **A typed not-found on `list`/`resolveLatest`/`resolveByHash`.** They already
  return `null` for absence.

---

## 9. Documentation

Landing in the same change:

- `CHANGELOG.md` — `[Unreleased]` becomes `## [0.4.0] - 2026-07-28`, absorbing
  the six already-merged PRs plus A and B. A is listed under a **Breaking**
  heading naming the `StorageProvider.get` contract change; §2 is listed under
  **Fixed** as a provider-dependent `absent` path, since that is what a reader
  upgrading actually needs to know.
- `packages/pangolin-core/src/storage.ts` — contract notes on `get` (must throw
  `StorageNotFoundError`) and the new `head?`.
- `docs-site` reference page for `pangolin-product`, covering the `opts.maxBytes`
  tiers and the fail-closed rule.
- An ADR is **not** warranted. ADR-0020 already established the product read as a
  public storage-keyed contract; this hardens that contract rather than deciding
  anything new about its shape.

---

## 10. Release mechanics

Per `RELEASING.md`: bump all sixteen packages to `0.4.0` in lockstep
(`pangolin-product` is already there), move the changelog section, `pnpm -r run
build`, `pnpm -r publish --dry-run --no-git-checks` to confirm the tarballs carry
only `dist`/`README.md`/`LICENSE`, `pnpm -r publish --access public`, annotated
`v0.4.0` tag, then `gh release create`.
