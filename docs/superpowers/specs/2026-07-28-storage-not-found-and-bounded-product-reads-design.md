# Typed storage not-found + bounded product reads

**Status:** design proposed 2026-07-28 · **Author:** agent:claude-opus-5 (with Brett) · **Confidence:** high
**Revision:** rev 3 — incorporates two audit rounds. See §11 for what changed and why.

Two changes to the storage contract, cut together as **0.4.0**. First: a missing
object becomes a typed `StorageNotFoundError` instead of a message the caller
has to sniff — which today silently breaks the `absent` path on S3, and makes
three security-relevant catch blocks in the dispatch path fail open. Second: the
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

The unreleased work alone would be a patch. §3 is not additive: it changes what
`StorageProvider.get` must do on a missing object and deletes the compensating
logic from four callers, one of which changes dispatch-failure semantics (§3.3).
That is a breaking change to the provider contract, so the release is `0.4.0` and
every package moves there in lockstep. This also lets `pangolin-product` stay
where it is rather than being walked backwards.

### 1.3 No external consumers

Pangolin has no third-party `StorageProvider` implementors and no published
consumer other than ai-os, which is developed in step. Back-compatibility for
unknown implementors is not a constraint on this design, and §3 spends that
freedom deliberately: it deletes the fallback rather than layering the typed
check on top of it.

That freedom does **not** extend to enforcement. §5.1 records why `head` is
optional rather than required: the type system cannot enforce a `StorageProvider`
obligation across this repo's test doubles, and a spec must not assert a
guarantee the toolchain does not provide.

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

**Inside Pangolin the defect is currently invisible.** Both in-repo callers of
`readOutputSentinel` swallow the throw —
`packages/pangolin-orchestrator/src/executors/dispatch.ts:215` and
`packages/pangolin-cli/src/cmd-orch.ts:240`. The user-visible victim is ai-os,
whose read adapter does not swallow. This is why the §6 regression test sits on
`readOutputSentinel` itself, not on either caller — and why neither caller's
swallow is removed (§3.4).

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

### 2.2 The hazard the remaining copies carry

`sentinel-read.ts:30-33` documents its own blast radius: `/not found/i` is a
substring match, so an unrelated failure — DNS, misconfiguration, a throttle —
whose text happens to contain that phrase is reclassified as `absent`. For a
consumer that maps `absent` to "this dispatch produced nothing," a transient
infrastructure error is recorded as a durable business fact.

### 2.3 Three catch blocks in the dispatch path fail open on the same gap

The heuristic is the visible symptom. The more serious instances are bare
catches in `packages/pangolin-client/src/dispatch.ts`, each of which exists
because `StorageProvider` gave the caller no way to tell "absent" from "broken":

| Site | Current behaviour | Consequence of a transient error |
|---|---|---|
| `dispatch.ts:520-527` `markerPresent` | `try { get } catch { return false }` | The dedupe guard (`dispatch.ts:131-142`) opens. Its own comment (`:124-130`) states the stakes: a re-fire "would otherwise re-stage the per-dispatch secrets / callback HMAC key under the same name, replacing the first container's key mid-run." |
| `dispatch.ts:681-684` `readSubagentCapabilities` | `catch { return [] }` | The dispatch fires with **zero capabilities** instead of the subagent's bound set — a silent capability downgrade on the security-relevant path. |
| `dispatch.ts:743-751` env-bundle read | `catch { continue }` | The container launches **without its secrets**. |

All three are fail-*open*. §2.2's framing applies to each with a
credential-rotation or capability-downgrade blast radius. `markerPresent`'s
comment names `readSubagentCapabilities` as the convention it mirrors
(`dispatch.ts:517-518`), so these are one defect with three instances rather
than three separate bugs.

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
(`errors.ts:69`).

`StorageProvider.get` (`packages/pangolin-core/src/storage.ts:18`) gains a
contract note: an object that does not exist **must** throw
`StorageNotFoundError`. Same for `head` (§5.1). `resolveLatest`, `list`, and
`resolveByHash` already return `null` for absence and are unchanged.

**This is the fix `sentinel-read.ts:26-29` asks for, not the one it forbids.**
That comment objects to hoisting *provider quirk-detection* into core — "would
put provider quirk-detection in the contract sink" — and then names the real
defect itself: "`StorageProvider` has no typed not-found signal, so every caller
sniffs." §3 puts a typed *class* in core and leaves *detection* in the provider
(`isNotFound`, `packages/pangolin-storage-s3/src/index.ts:112-121`). The
distinction is load-bearing and is recorded here so a later reader does not
mistake this change for the one that comment rejects.

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

Each narrows to `if (e instanceof StorageNotFoundError) <today's behaviour>;
throw e;` — a genuinely absent object keeps current semantics, and only
transient errors change.

| Site | Absent → | Transient → (new) |
|---|---|---|
| `pangolin-product/src/sentinel-read.ts` | `{ status: 'absent' }` | throws; local `isNotFound` (`:34-39`) and its comment deleted |
| `pangolin-client/src/retention.ts:82-88` | `null` | throws; local `isNotFound` (`:90-97`) deleted |
| `pangolin-client/src/dispatch.ts:520-527` | `false` | throws |
| `pangolin-client/src/dispatch.ts:681-684` | `[]` | throws |
| `pangolin-client/src/dispatch.ts:743-751` | skip the bundle | throws |

**Stated trade-off.** The last three make dispatch *less available* under storage
flakiness: a blip that previously produced a degraded-but-running dispatch now
produces a failed one. This is deliberate. Firing with zero capabilities, or
launching a container without its secrets, is a worse outcome than failing the
dispatch, and silent degradation is precisely the failure class the worker
failure-policy work exists to prevent. It is a real trade, not a free win, and
the changelog says so.

### 3.4 Callers deliberately left alone

**`pangolin-orchestrator/src/executors/dispatch.ts:215`'s
`.catch(() => ({ status: 'absent' }))` stays.** An earlier revision proposed
removing it as "papering over §2." It is not — it is a documented contract at
`executors/dispatch.ts:199-206`: "NEVER throws — `absent`, `malformed`, and a
rejected promise (unrelated storage errors) all yield an empty object." Removing
it strands the run:

1. `reconcile()` deletes the in-flight entry (`dispatch.ts:165`) and calls
   `entry.inflight.cleanup()` (`:171`) **before** `readSentinel` at `:174`.
2. A throw at `:174` escapes `reconcile()`. `engine/tick.ts:90` does not wrap
   that call, so the rest of the tick — later items, the audit-seal block — is
   abandoned.
3. On the next tick `reconcile` returns `null` (`dispatch.ts:164`) because the
   entry is gone. The item stays `running` until a configured `maxRuntimeMs`
   overrun (`tick.ts:74-88`) frees it, if one is configured at all.

So the alternative to "relabelled as produced-nothing" is "completed dispatch
silently lost and the run stalls." The `.catch` is correct; §2's fix simply makes
it fire far less often.

`pangolin-cli/src/cmd-orch.ts:240`'s bare `catch {}` also stays — its comment
("best-effort — never fail the watch") is a deliberate posture for a watch
command. §5.1 addresses the separate problem that its storage lacks `head`.

### 3.5 Blast radius

A `StorageProvider` implementation that does not throw the typed error now
surfaces a missing object as an unhandled infrastructure throw rather than
`absent`/`null`. Per §1.3 there are no such implementations outside this repo.
The contract change is called out in the changelog as breaking.

---

## 4. Defect B — both product reads are unbounded

`fetchDispatchArtifact` reads bytes named by the output sentinel, which is
written by the dispatch's own run. `packages/pangolin-product/src/artifact-ref.ts`
states the threat in its header: a product ref is an unhashed overwrite-put, so
following one unguarded lets an attacker aim the caller's credential at another
dispatch's or namespace's bytes.

`assertArtifactRef` closes *where the bytes come from*. Nothing closes *how many
bytes arrive*. `artifact-fetch.ts`'s own JSDoc concedes this:

> `StorageProvider.get` takes no size bound and the interface exposes no size
> metadata, so an oversized object cannot be pre-checked here. Bound it in your
> own provider (e.g. HeadObject/Content-Length before GetObject).

It names the correct mechanism and assigns it to the caller.

### 4.1 Why a post-fetch length check cannot be the primary control

Both bundled providers fully buffer **and** hash before `get()` returns:
`packages/pangolin-storage-s3/src/index.ts:237-241` streams to a `Uint8Array`
then calls `computeContentHash`; `packages/pangolin-storage-local/src/index.ts:278-292`
does `readFile` then the same. A `bytes.length` check inside
`fetchDispatchArtifact` would run after two complete passes over the object.

There is no length check in `fetchDispatchArtifact` today
(`packages/pangolin-product/src/artifact-fetch.ts:16-21`). §5.7's post-read
assertion is therefore a **new addition**, not a description of existing
behaviour, and it is a backstop rather than the control.

### 4.2 Why streaming `get()` is not the answer here

Streaming is feasible — `computeContentHash`
(`packages/pangolin-core/src/content-hash.ts:82-90`) is built on
`createHash('sha256')` with incremental `.update()`. It is rejected on
proportion, not difficulty. There are twelve `storage.get(...)` call sites across
four packages (`pangolin-client` ×4 — `dispatch.ts:522,681,745`,
`retention.ts:82`; `pangolin-worker` ×4 — `bundle-fetcher.ts:112,140,162,190`;
`pangolin-orchestrator` ×2 — `audit/bundle.ts:43`, `executors/dispatch.ts:245`;
`pangolin-product` ×2). Eleven want whole bytes immediately. Converting `get()`
to a stream makes those eleven re-buffer by hand to reach the state they start
from today. Exactly one site benefits: `artifact-fetch.ts:18`. Deferred; revisit
only if a second genuine streaming consumer appears.

### 4.3 The sentinel read needs the same bound

`sentinel-read.ts:18` is equally unbounded, and `output.json` is written by the
run (`packages/pangolin-worker/src/output-sentinel.ts:189`), so it is
attacker-influenced. A hostile run that writes a multi-gigabyte sentinel kills
the consumer before any artifact ref is parsed.

The entry caps in `sentinel-parse.ts` do not help, for two reasons.
`buildBlocks` (`sentinel-parse.ts:74,136`) caps blocks at `MAX_OUTPUT_ENTRIES`
(256, `pangolin-core/src/product.ts:9`) and caps each block's own outputs at 256
again (`sentinel-parse.ts:96`) — 65,536 entries in the worst case — and `summary`
is copied with no length cap at all (`sentinel-parse.ts:125`), unlike `report`
which *is* capped at `sentinel-parse.ts:36`. More fundamentally, every one of
those caps runs *after* `JSON.parse` (`sentinel-parse.ts:113`). They bound the
resulting object, never the input. Only a byte ceiling protects the read.

---

## 5. Design B — `head?()` and byte ceilings

### 5.1 `head` is optional, and the missing-capability case is named

`StorageProvider` gains:

```ts
/**
 * Object size in bytes, without transferring the body. Throws
 * `StorageNotFoundError` if the object does not exist, exactly as `get` does.
 * Routes by URI kind identically to `get`.
 *
 * OPTIONAL: providers that cannot answer omit it, and the bounded product
 * reads throw `StorageHeadUnsupportedError` rather than reading unbounded.
 */
head?(uri: string): Promise<{ size: number }>;
```

**Optional, with one runtime capability check** that throws
`StorageHeadUnsupportedError(providerName, uri)` when `typeof storage.head !==
'function'`. Never skip the check and read unbounded — that silently restores the
defect §4 exists to close.

A previous revision made `head` **required**, on the reasoning that the resulting
compile errors would be few and mechanical. That reasoning was wrong on a point
of TypeScript: the repo's minimal-storage doubles use
`as unknown as StorageProvider` (`pangolin-worker/test/deliver.test.ts:22,46,69,98,130,174`,
`pipeline-runner.test.ts:267`, `pangolin-product/test/sentinel-read.test.ts:86`),
and a double assertion through `unknown` bypasses structural checking entirely.
Requiring `head` would not have produced an error at any of them. The sites that
*would* break — 10 `implements StorageProvider` and 49 `: StorageProvider`
annotations across the test suites — mostly sit in packages that **do not
typecheck their tests at all**: only 6 of 16 packages carry `tsconfig.test.json`
and `typecheck:test`, the other ten being issue #103, which §8 puts out of scope.

So "required" would have been compiler-enforced in exactly two files —
`LocalStorageProvider` (`pangolin-storage-local/src/index.ts:56`) and
`S3StorageProvider` (`pangolin-storage-s3/src/index.ts:170`), both of which §5.2
implements anyway — and a runtime `TypeError` everywhere else. Asserting a
guarantee the toolchain does not provide is the same species of error as A
itself, where the provider knew something the type system did not carry.

The minimal-`{get}` storage shape is a settled repo idiom, not a one-off:
`OrchContext.storage?: { get(ref): Promise<Uint8Array> }`
(`pangolin-cli/src/cmd-orch.ts:38`), plus `interface StorageLike { get(...) }` at
`pangolin-orchestrator/src/audit/bundle.ts:13` and
`pangolin-orchestrator/src/operations-api.ts:19`. The latter two never call a
product read and are unaffected.

**`cmd-orch.ts` is fixed regardless.** It is the one src caller of a bounded read
whose storage lacks `head` (`cmd-orch.ts:234-237`, inside a bare `catch {}` at
`:240`), so under any design where a missing `head` throws, `pangolin orch watch`
silently stops reporting usage evidence. `OrchContext.storage` widens to
`{ get(...); head(...) }` and the CLI wiring supplies both. This is a published
config surface (`pangolin.config.*`), so the changelog lists it as breaking.

### 5.2 Provider implementations

`head` **must route by URI kind exactly as `get` does.** The sentinel and the
artifact are different URI shapes, and a `head` that handles only one silently
breaks the other read.

- `S3StorageProvider.head` — mirrors the branch at `index.ts:226-233`:
  `dispatch-record` → `dispatchRecordKey`; blob → the pinned-hash `blobKey`,
  **including the unpinned-URI throw at `index.ts:231`**. Uses
  `HeadObjectCommand` → `ContentLength`, and the existing `isNotFound`
  (`index.ts:112`) so a missing object throws `StorageNotFoundError`.
- `LocalStorageProvider.head` — `stat` on `blobPath` or `dispatchRecordPath` as
  appropriate, routed through `parseSafe` (`index.ts:346`) so the path-traversal
  guard applies to `head` as it does to `get`, and **including the identical
  unpinned-URI guard at `index.ts:272-274`** (`blobPath` cannot be built without
  a `contentHash`). `ENOENT` → `StorageNotFoundError`.

### 5.3 Ceilings live in core, beside the write-side cap they must agree with

The write side already caps captured files:
`packages/pangolin-worker/src/output-sentinel.ts:34` defines
`MAX_OUTPUT_FILE_BYTES = 100 * 1024 * 1024`, enforced at `output-sentinel.ts:124`
(`if (fileStat.size > MAX_OUTPUT_FILE_BYTES) continue`). A read default below
that would reject artifacts a compliant worker legitimately captured.

`MAX_OUTPUT_FILE_BYTES` **moves to `packages/pangolin-core/src/product.ts`**
beside `MAX_OUTPUT_ENTRIES` (`:9`), whose prose already names it
(`product.ts:58`). It has exactly three references —
`output-sentinel.ts:34` (its definition), `output-sentinel.ts:124`, and
`pangolin-worker/test/output-sentinel.test.ts:19` — and is **not** in the worker
barrel, so the two importers are updated directly. No back-compat re-export is
added: with no external consumers (§1.3) and no barrel export, it would be dead
surface. (`pangolin-worker` already depends on `pangolin-core`; no cycle, no
boundary crossed.)

```ts
// packages/pangolin-core/src/product.ts
export const MAX_OUTPUT_ENTRIES = 256;                    // existing
export const MAX_OUTPUT_FILE_BYTES = 100 * 1024 * 1024;   // moved from the worker
export const DEFAULT_MAX_ARTIFACT_BYTES = MAX_OUTPUT_FILE_BYTES;
export const MAX_SENTINEL_BYTES = 1_048_576;              // 1 MiB, fixed
```

`DEFAULT_MAX_ARTIFACT_BYTES` is *derived from* the write cap rather than
restating its value, so the two cannot diverge.

**Known asymmetry, documented not fixed:** `patch-capture.ts` has no write-side
byte cap, so a patch larger than `DEFAULT_MAX_ARTIFACT_BYTES` is captured on
write and rejected on read. Bounding patch capture is worker-behaviour work
outside this release; it is recorded here so the gap is deliberate rather than
discovered.

### 5.4 Read surface — the sentinel ceiling is fixed, the artifact bound is not

```ts
readOutputSentinel(deps, dispatchId)                                  // no opts
fetchDispatchArtifact(storage, ref, expect, opts?: { maxBytes?: number })
```

The asymmetry is deliberate and resolves an ambiguity an audit raised. If the
sentinel ceiling were caller-configurable, then `{ reason: 'too-large' }` would
mean "over *your* limit" — two consumers reading the same dispatch would reach
different conclusions, and §5.5's justification for recording it as a durable
business fact would collapse. `MAX_SENTINEL_BYTES` is therefore a **wire-format
bound**, not a caller policy: `output.json` is metadata — paths, refs, a summary,
per-block outcomes — and 1 MiB sits roughly two orders of magnitude above a
realistic worst case at `MAX_OUTPUT_ENTRIES` (256 entries × a ~200-byte path+ref
pair ≈ 51 KB, plus block evidence).

The artifact bound stays caller-configurable because it is genuinely a caller
policy, and because it throws an error carrying both `size` and `limit` (§5.5) —
self-describing, so no consumer has to guess whose limit was hit.

`maxBytes` must be a finite integer `>= 0`; `0` is a real bound of zero, not a
falsy synonym for "omitted". Non-finite, negative, or non-integer values throw
`RangeError` at the call, **after** `assertArtifactRef` and before any I/O, so
the §5.6 ordering guarantee is not weakened by argument validation.

### 5.5 Outcomes differ because the two functions' contracts differ

- **`readOutputSentinel` returns** `{ status: 'malformed', reason: 'too-large' }`.
  `SentinelMalformedReason` (`sentinel-parse.ts:19`) extends from
  `'not-json' | 'not-an-object' | 'bad-schema-version'` to include `'too-large'`.
  This function's design premise is that abnormal input is a return value, not an
  exception — an oversized sentinel is abnormal *input*, the same class as
  malformed JSON. ai-os maps `malformed → 'unreadable'`, a durable business
  outcome, which is correct given §5.4's fixed ceiling: a hostile run wrote a
  sentinel outside the wire format, and that is a fact about the dispatch.

  Like `'absent'`, `'too-large'` is **never constructed by
  `parseOutputSentinel`** — it is synthesized by the I/O wrapper before parsing.
  This is noted in the union's comment, mirroring what `sentinel-parse.ts:23-25`
  already does for `'absent'`.

  No in-repo consumer discriminates on `.reason`
  (`executors/dispatch.ts:216` and `cmd-orch.ts:238` branch on `status` alone),
  so the new variant breaks no exhaustive switch.
- **`fetchDispatchArtifact` throws** `ArtifactTooLargeError(size, limit, ref)`,
  matching how it already signals `IntegrityMismatchError` and
  `ArtifactRefRejectedError`. ai-os's adapter already catches per-ref errors into
  `unverified[]`, so this slots in without a new branch.

Both `ArtifactTooLargeError` and `StorageHeadUnsupportedError` are defined in
**`pangolin-core/src/errors.ts`**. An earlier revision argued for package-local
placement on the grounds that only one package throws them; the repo's actual
convention contradicts that — `CapabilityTooLargeError` (`errors.ts:25`) is
thrown only from `pangolin-client/src/capabilities-register.ts:81`, and
`PartialStateTooLargeError` (`errors.ts:47`) is likewise single-package. Core is
the error sink here; this spec follows the precedent rather than inventing a rule
its two nearest neighbours violate.

### 5.6 Ordering is load-bearing

In `fetchDispatchArtifact` the sequence is **assert ref → validate opts → head →
get → verify hash**.

`assertArtifactRef` must stay first. It is documented as throwing before any I/O
(`artifact-fetch.ts:17`), and `head()` *is* I/O against a caller-supplied URI.
Calling `head` on an unvalidated ref would point the caller's credential at an
arbitrary object — the precise attack `artifact-ref.ts` exists to prevent. A size
pre-check must never become an oracle for refs the ref guard would have rejected.

A `StorageNotFoundError` from `head` is treated identically to one from `get`: in
`fetchDispatchArtifact` it propagates (a ref naming a missing object is a real
error), and in `readOutputSentinel` it classifies as `absent` from **either**
call.

`readOutputSentinel` has no ref assertion — it builds its own URI from
`namespace` + `dispatchId` — so its sequence is **head → get → parse**.

### 5.7 The `head`→`get` race, and what the post-read check is actually for

A post-read length assertion is added to **both** reads. It is not the primary
control (§4.1) — on a buffering provider the bytes are already resident when it
runs. It exists for two narrower reasons:

1. A provider whose `head` under-reports must not be able to lift the ceiling.
2. The sentinel URI is a **dispatch record**, an overwrite-put
   (`putDispatchRecord`, `packages/pangolin-storage-s3/src/index.ts:423-441`,
   "overwrites are intentional"), so a run that can rewrite it can grow the
   object between `head` and `get`.

**The artifact read is not exposed to that race**, and the reason is the *write*
path, not the hash check. A blob's storage key is derived from its own content:
`S3StorageProvider.putBlob` computes `contentHash = computeContentHash(contents)`
and keys on it (`index.ts:394-399`), writing with `IfNoneMatch: '*'`
(`index.ts:410`); `LocalStorageProvider.putBlob` does the same
(`index.ts:247-254`). Different bytes therefore cannot occupy the same key —
there is nothing to swap. The hash check at `artifact-fetch.ts:19-20` runs *after*
the body is buffered and protects integrity, never memory, so it could not have
supplied this guarantee.

**Residual risk, accepted and unasserted:** for the sentinel, a run that wins the
`head`→`get` race can still cause one oversized buffer to be read before the
post-read check rejects it. Closing that fully requires a bounded or streaming
`get` (§4.2). No test asserts this; it is recorded as accepted risk rather than
covered.

### 5.8 One helper, not two copies

The shared portion — resolve the limit, capability-check `head`, probe, compare,
and the post-read assertion — lands in a single internal helper in
`pangolin-product` (`src/size-guard.ts`, not exported from the barrel), used by
both reads. Each caller supplies its own outcome per §5.5. A spec whose thesis is
"three copies of `isNotFound` and only the one that never runs is correct" does
not ship two copies of its own new guard.

---

## 6. Testing

**A.**
- A provider throwing a generic `Error` whose message contains "not found" is
  **not** treated as absent. This fails today and is the point of the change.
- `LocalStorageProvider` `ENOENT` → `StorageNotFoundError`, on both the blob and
  dispatch-record paths.
- `S3StorageProvider` `NoSuchKey` → `StorageNotFoundError`, on both paths. **Unit
  tests, with the fixture constructed as a real `NoSuchKey` instance** so
  `err instanceof NoSuchKey` (`index.ts:113`) is genuinely exercised rather than
  the `name` fallback; a hand-rolled `{ name: 'NoSuchKey' }` would assert the
  mock, not the SDK. The LocalStack-gated
  `packages/pangolin-storage-s3/test/integration.test.ts` is not extended.
- **Regression for §2:** a missing sentinel on an S3-backed provider returns
  `{ status: 'absent' }`. Asserted on `readOutputSentinel` directly, not through
  either swallowing caller.
- `readDispatchRecord` returns `null` for a missing record on S3.
- Each of the three §3.3 dispatch sites: `StorageNotFoundError` preserves today's
  behaviour (`false` / `[]` / skip), and a generic error **rethrows**. The
  dedupe guard must not open on a throttle; the dispatch must not fire with an
  empty capability set on a 500.
- **§3.4 characterisation:** `readSentinel` still returns `{}` when the
  underlying read rejects, so `reconcile` completes and the item does not strand.
  This pins the `.catch` that must not be removed.

**B.**
- Oversized artifact → `ArtifactTooLargeError` **and the `get` spy was never
  called**. Asserting the rejection alone would pass against a post-fetch-only
  design; asserting `get` was not called is what proves memory protection.
- Oversized sentinel → `{ status: 'malformed', reason: 'too-large' }`, `get`
  never called.
- **A ref that fails `assertArtifactRef` → `head` was never called.** This pins
  §5.6; without it a later refactor can reorder the checks and reopen the
  credential-aiming path.
- A storage object with no `head` → `StorageHeadUnsupportedError` from both
  reads. No path reads unbounded.
- A `head` that under-reports → caught by the post-read assertion, and
  distinguishable from the `head`-path rejection by error identity (artifact) or
  by `get` having been called (sentinel).
- `maxBytes: 0` rejects everything; `-1`, `NaN`, `1.5` throw `RangeError`, and a
  bad ref combined with a bad `maxBytes` throws `ArtifactRefRejectedError` (ref
  assertion wins — §5.6).
- `head` routes correctly for **both** URI kinds on both providers (§5.2);
  `LocalStorageProvider.head` rejects a traversal URI that `parseSafe` catches
  and an unpinned blob URI.

---

## 7. Consumer impact (ai-os)

ai-os's child-3 plan pins `pangolin-product@^0.4.0` and `pangolin-core@^0.4.0`,
so those pins are correct as written. Four consequential notes:

- **The BLOCKED gate does not "pass" yet — it passes once this release
  publishes.** The gate's wording is "verify the *published*
  `pangolin-product@^0.4.0` actually exports `readOutputSentinel` +
  `fetchDispatchArtifact`" (plan `:437-439`). The source barrel
  (`packages/pangolin-product/src/index.ts:7-12`) does export all four symbols,
  but no `0.4.0` exists on npm — `git tag` tops out at `v0.3.1`, and §10 is the
  step that creates it. ai-os must not start that task before the publish.
- **ai-os's injected `StorageProvider` and its test fake must implement `head`**
  (§5.1) — otherwise every product read throws `StorageHeadUnsupportedError`. The
  plan injects `deps.storage` (`:461`) and its test uses `fakeStorage` (`:478`);
  both are authored against the final contract, since the task is
  `status: pending` (`:431`).
- **Both dependency lines must move, not one.**
  `packages/adapter-pangolin-dispatch/package.json:12` pins `pangolin-client` and
  `:13` pins `pangolin-core`, both at `^0.3.0`. Bumping only core is insufficient:
  published `pangolin-client@0.3.1` declares its own core dep (`workspace:*`,
  rewritten at publish to `0.3.1`), so a second `pangolin-core` copy survives
  transitively and the `instanceof` failure this note exists to prevent is
  untouched. Move both to `^0.4.0`, and drop the plan's "resolving
  `pangolin-core` 0.3 and 0.4 side-by-side" acceptance criterion (`:492`), which
  this contradicts.
- ai-os's `malformed → 'unreadable'` mapping now also carries `'too-large'`
  (§5.5). No new branch is needed, but the mapping's meaning widens.

---

## 8. Out of scope

- **Issue #103** (typecheck test files in the remaining 10 packages, 213 errors).
  Hygiene; nothing downstream waits on it; its own release. Note §5.1 depends on
  the *current* state here — if #103 lands first, required-`head` becomes a
  materially cheaper option and is worth revisiting.
- **Bounding `readDispatchRecord`** (`pangolin-client/src/retention.ts:82-88`).
  §4's threat model does not reach it: `record.json` is written by
  `writeDispatchRecord` in **pangolin-client** (`retention.ts:45`, called from
  `dispatch.ts:448`) — the consumer's own process — whereas the run writes only
  `output.json` (`pangolin-worker/src/output-sentinel.ts:189`) and
  `undelivered/*.json` (`deliver.ts:41`) under that prefix. It is not
  attacker-influenced, and bounding it would push the §5.8 guard across a package
  boundary (`pangolin-client` does not depend on `pangolin-product`). Revisit if
  the worker's write scope to the dispatch-record prefix ever widens.
- **Release automation** (RELEASING.md "Future"). 0.4.0 is cut by hand.
- **Streaming `get()`.** §4.2, and the residual race in §5.7.
- **A write-side byte cap on patch capture.** §5.3.
- **A typed not-found on `list`/`resolveLatest`/`resolveByHash`.** They already
  return `null` for absence.

---

## 9. Documentation

Landing in the same change:

- `CHANGELOG.md` — `[Unreleased]` becomes `## [0.4.0] - 2026-07-28`, absorbing
  the six already-merged PRs plus A and B. A **Breaking** heading names three
  things: the `StorageProvider.get` not-found contract, the dispatch-availability
  trade in §3.3, and the `OrchContext.storage` widening. §2 is listed under
  **Fixed** as a provider-dependent `absent` path.
- `packages/pangolin-core/src/storage.ts` — contract notes on `get` and `head?`.
- **`docs-site/src/content/docs/how-to/write-a-provider.md:126-166`** — reproduces
  the `StorageProvider` interface literally and documents the optional-method
  posture. It gains `head?` and the `get` not-found MUST. This is the page a
  future implementor reads.
- **`docs-site/src/content/docs/reference/dispatch-lifecycle.md:200-207`** — pins
  both read signatures and states "A missing sentinel comes back as
  `{ status: 'absent' }` rather than throwing." `fetchDispatchArtifact` gains
  `opts`, and the `absent` sentence gains its `'too-large'` sibling. Its
  cross-references at `reference/package-map.md:30`,
  `reference/pangolin-client-api.md:212`, and
  `explanation/architecture-overview.md:115` are checked against the new text.
- **`docs-site/test/product-read-docs.test.ts:91-105` must be inverted.** It
  currently asserts those four pages **must not** match `/head\(\)/` or
  `/size[- ]?(bound|cap|limit)ed? read/i` — a guard against documenting unbuilt
  surface. This change builds it, so the guard becomes an assertion that the
  surface *is* documented. Without this the release lands red.
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

---

## 11. Revision history

**rev 3 (2026-07-28)** — second audit round.

| Change | Driver |
|---|---|
| `head` reverts to **optional**, with a named `StorageHeadUnsupportedError` | rev 2's required-`head` rested on a false premise: `as unknown as StorageProvider` bypasses structural checking, so requiring it would have errored at none of the sites rev 2 listed. Real enforcement is two files; 10 of 16 packages don't typecheck tests at all. |
| Orchestrator `.catch` **stays** (§3.4) | rev 2 called it "papering over §2." It is a documented `NEVER throws` contract, and removing it strands the item permanently — `reconcile` destroys in-flight state before the read, and `tick.ts:90` is unguarded. |
| All three `dispatch.ts` catches narrow (§2.3, §3.3), replacing rev 2's untestable "is swept" | Two siblings to `markerPresent` are worse than it: `:681` fires with zero capabilities, `:745` launches without secrets. |
| Sentinel ceiling becomes **fixed**; only the artifact bound is caller-configurable (§5.4) | A configurable sentinel ceiling made `'too-large'` mean "over *your* limit," which contradicts §5.5's argument for recording it as a durable business fact. |
| Error classes go in **core**, not package-local (§5.5) | rev 2 invented a placement rule that `CapabilityTooLargeError` and `PartialStateTooLargeError` both violate. |
| §5.7's artifact-immunity reason corrected | rev 2 credited the hash check, which runs after buffering and protects integrity, not memory. The real guarantee is content-derived blob keys + `IfNoneMatch`. |
| §9 gains the doc-test inversion | `product-read-docs.test.ts:91-105` actively forbids documenting `head()`; rev 2 would have landed the suite red. |
| §5.3 drops the back-compat re-export | The constant has three references and no barrel export; a re-export would be dead surface. |
| §8 gains `readDispatchRecord` with a reason | rev 2 left the third dispatch-record read unmentioned. It is written by the client, not the run, so §4's threat model does not reach it. |
| §7 requires **both** pins to move | Bumping core alone leaves `pangolin-client@0.3.1` pulling a second core copy transitively. |
| §5.2 gains the local unpinned-URI guard; three citation drifts corrected | Audit house-style findings. |

**rev 2 (2026-07-28)** — first audit round: corrected the 64 MiB default against
the worker's existing 100 MiB write cap; named the oversize outcomes; added
`markerPresent`; corrected the non-existent `S3StorageProvider.getBlob`; added
the two stale doc pages; marked the post-read check as an addition rather than
existing behaviour.
