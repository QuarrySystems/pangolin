---
title: "ADR-0020: Reading a dispatch's product is a public contract keyed on storage + dispatchId"
description: "A dispatch's product (sentinel + artifacts) is readable by any holder of storage + dispatchId, with no fire-side handle required. The sentinel is an unverifiable overwrite-put record; the artifacts it names are content-addressed and self-verifying."
status: accepted
date: 2026-07-27
deciders: pangolin-product-design
---

## Context

`fireWork` alone never writes a dispatch record. `writeDispatchRecord` is
called from inside the `reconcile` closure
(`packages/pangolin-client/src/dispatch.ts:389-456`, write at `:447`) — it
only runs when the caller has reconciled the dispatch's terminal state.
`describeDispatch` (`packages/pangolin-client/src/describe.ts:37-44`) reads
that record and throws `DispatchRecordExpiredError` when it is absent; per
`:5-9` "expired" and "never existed" are indistinguishable from the outside.

That leaves a structural gap: a fire-and-forget consumer — one that fires a
dispatch and walks away, or one that lost its in-process handle across a
process restart — has no `describe()` path back to the dispatch's product.
The only durable, out-of-band anchor available to such a consumer is
`storage` (the target's storage location) plus `dispatchId`, both of which
are knowable without holding anything from the `fire()` call itself.

The worker already writes two different kinds of thing at that anchor, and
they have different trust shapes:

- **The output sentinel** (`packages/pangolin-worker/src/output-sentinel.ts`,
  in `writeSentinel`) is a URI-addressed overwrite put — "not
  content-addressed" (`:188`). `DispatchRecordUriParts`
  (`packages/pangolin-core/src/uri.ts:27-36`) has no `contentHash` field, by
  design: the sentinel's location is fixed ahead of time (dispatchId is
  known before the dispatch runs), so it cannot also be addressed by the
  hash of content that doesn't exist yet. Nothing stops a third party with
  write access to the same storage prefix from overwriting it.
- **Artifacts** the dispatch produces are referenced via
  `buildPangolinUri({ namespace, type: 'artifact', name: dispatchId,
  contentHash })` (`output-sentinel.ts`, in `capturePatch` at `:53` and
  `captureOutputs` at `:129`) — both the hash and the dispatchId are
  recoverable from the URI itself, so a reader can fetch the bytes and
  verify them against the URI without trusting the storage backend or the
  party that wrote them.

The worker has an internal `fetchVerified` helper that checks a fetched
blob's bytes against an expected `contentHash` before returning it. The
obvious next step is to expose that helper on the public, published fetcher
so consumers get the same verification for free. That step was considered
and rejected — see Decision below.

Because the worker image is versioned independently
(`.github/workflows/pangolin-worker-image.yml` publishes `{{version}}`,
`{{major}}.{{minor}}`, and digest tags, and `workerImage` is a required
caller-supplied field at `pangolin-client/src/dispatch.ts:61`), a reader
built against a newer `@quarry-systems/pangolin-product` may have to read
bytes written by an older worker image, and vice versa. The read contract
has to survive that skew, not just the matched-version case.

## Decision

Reading a dispatch's product is a **public contract keyed on `storage` +
`dispatchId`** — no handle from the `fire()` call, and no dispatch record,
is required. This ships as `@quarry-systems/pangolin-product` v0.4.0,
depending only on `pangolin-core`, following the `pangolin-verify`
precedent of keeping core dependency-light.

The contract makes the trust asymmetry between the two artifact kinds
explicit rather than papering over it:

- **The sentinel is untrusted as data.** It is a URI-addressed overwrite
  put with no hash to verify against — there is nothing in the sentinel's
  own address to check its bytes against, so a reader can observe that
  *something* was written at that address but cannot prove the bytes are
  what the worker actually wrote versus a subsequent overwrite by anything
  else with write access to the prefix.
- **Artifact refs (`patchRef`, `outputs[].ref`) are trusted.** They are
  content-addressed and self-verifying: the hash lives in the URI itself,
  so any reader who fetches the named bytes can independently confirm they
  match, regardless of who wrote them or what wrote over them since.

The worker's private `fetchVerified` was **not** merged into the published
fetcher. Doing so would mean shipping a dual-mode fetcher — one branch that
takes an expected `{ contentHash }` and verifies, and one that doesn't — and
the verifying branch is only safe to use when the caller's `contentHash`
came from a trusted channel. Inside the worker, that channel is the
worker's own in-process knowledge of what it just wrote. A consumer reading
the sentinel has no such channel: the sentinel itself carries no hash, so
"verify against the hash from the sentinel" is not an option, and any hash
the consumer supplies from elsewhere is exactly as trustworthy as the
consumer's own provenance for it — not something the fetcher can certify.
Publishing that branch would invite callers to believe they got a verified
read when what they actually got was "verified against whatever I passed
in," which is a false sense of integrity dressed up as a library
guarantee. The published fetcher therefore only offers the
content-addressed path for refs that are already self-verifying by
construction (artifacts), and returns the sentinel as an unverified
record.

The supported model for the version-skew problem above is **lockstep
pairing**: the npm package version and the worker image's digest-pinned tag
are expected to move together, and integrators who bump one are expected to
bump the other. This does not eliminate skew — the worker image is
independently republished (`.github/workflows/pangolin-worker-image.yml`)
and a reader can legitimately encounter bytes from a worker image older
than the reader's own package version. The surviving obligation from this
decision is **backward-read**: a new reader must be able to parse a
sentinel and artifact refs written by an old worker. Forward-read (an old
reader parsing bytes from a newer worker) is explicitly out of scope for
this ADR.

Finally, and deliberately: **the dispatch record stays reconcile-bound.**
`writeDispatchRecord` remains inside the `reconcile` closure, and
`describe()` remains the read path for dispatches whose terminal state the
caller reconciled. The Context above describes that as the gap this
contract exists to fill; this clause commits to it rather than leaving it
an implementation artifact.

The alternative — having `fireWork` write a minimal record at fire time so
`describe()` works for everyone — looks like a strict improvement and is
not. It would change what the *absence* of a record means. Fire-and-forget
consumers are being told here to key their read on `storage` +
`dispatchId` and to treat "no sentinel" as a normal outcome of a finished
dispatch; a record materialising where none previously existed is a
behaviour change for anyone who built on that, and it arrives silently
because nothing fails — the reader simply starts seeing something new.

So the two paths stay distinct and are not a redundancy to be collapsed:
`describe()` answers "what did the run I was holding onto do", and the
product read answers "what did dispatch X produce", which is the question
you can still ask after losing the handle. A change to the record's
lifecycle should supersede this decision explicitly, and should say what
it does to consumers who by then read `absent` as meaningful.

## Consequences

What becomes easier:

- A consumer that fired a dispatch and lost its handle — crashed,
  restarted, or was never in the same process as the fire call — can still
  recover the dispatch's product by combining `storage` and `dispatchId`,
  both of which are cheap to persist independently of the SDK's own
  bookkeeping.
- The trust boundary between "I observed a write happened" (sentinel) and
  "I can prove these bytes are what was produced" (artifact refs) is
  explicit in the published API surface, not something a consumer has to
  reverse-engineer from `output-sentinel.ts`.
- Because artifact refs are content-addressed, consumers can safely cache,
  mirror, or hand artifact refs to third parties without re-establishing
  trust in the storage backend each time.

What becomes harder:

- Consumers get no verified read of the sentinel itself. Anything derived
  from sentinel contents (status, timestamps, whatever the worker chose to
  put there) is only as trustworthy as the storage backend's access
  controls — the library cannot upgrade that for them.
- Lockstep pairing between the npm package and the worker image is a
  process obligation, not something the type system enforces. Drift
  between the two is possible and, when it happens, must be caught by the
  backward-read guarantee holding, not by the fetcher refusing to run.
- A dual-mode "maybe verified" fetcher would have been more convenient for
  callers who happen to have a trustworthy hash lying around, but was
  rejected because the fetcher itself has no way to distinguish a
  trustworthy caller-supplied hash from an untrustworthy one.

Trade-offs:

- We accept that the sentinel read is honest-but-unverified in exchange for
  not shipping an API shape that implies verification it cannot actually
  provide. The alternative — exposing `fetchVerified` broadly — would have
  looked safer while being exactly as vulnerable to a malicious or
  corrupted sentinel as the unverified path, just harder to notice.
- We accept backward-read as the only compatibility obligation (not
  forward-read) because the lockstep-pairing model means forward-read
  scenarios are a misconfiguration, not a supported deployment shape, for
  now. If cross-version forward reads become a real requirement, revisit
  this ADR rather than silently expanding the contract.
