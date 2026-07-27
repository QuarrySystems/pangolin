# Dispatch product read — a public, storage-keyed contract

**Status:** design proposed 2026-07-27 · **Author:** agent:claude-opus-5 (with Brett) · **Confidence:** medium-high

Publish the read side of the dispatch product: the worker-written output sentinel,
and the content-addressed artifacts it names. Consolidates four hand-rolled
in-repo readers into one contract and gives out-of-process consumers a supported
path that does not require the fire-side handle.

**Evidence discipline for this spec.** Every factual claim about current behavior
carries a `file:line` citation. Claims about what *will* exist are marked as
decisions, not descriptions. §8 (documentation) may only describe surface that
lands in the same change — see the rule at the head of that section.

---

## 1. Context

### 1.1 The pull

ai-os (separate repo) integrates with Pangolin by **direct dispatch**: it calls
`fireWork` in its own process, holds run state in its own append-only log, and
correlates the callback home. Its child-3 work item is the read path — the
handler that turns a finished dispatch into a durable, verified product its
approval flow can act on days later.

Child 3 found no typed product-read API on `pangolin-client@0.3.1`. That is
correct: `DispatchResult` (`packages/pangolin-core/src/dispatch.ts:102-129`)
carries `dispatchId`, `exitCode`, `stdout`, `stderr`, `durationMs`, `resolved`,
`failure?`, and `needsInput?` — and no product field. `OutputSentinel` is
declared in `packages/pangolin-worker/src/output-sentinel.ts:60-92` and is not
exported from any consumer-facing barrel.

### 1.2 Why this ask clears a bar three sibling asks did not

The same consumer roadmap review produced ADR-0019
(`docs-site/src/content/docs/explanation/decisions/0019-target-is-an-isolation-boundary.md`),
which declined three consumer asks with "keep as-is, zero code changes" and
routed the work consumer-side.

This one is different for a reason that has nothing to do with ai-os: **four
in-repo call sites already hand-roll this read.**

| Call site | Evidence |
|---|---|
| `packages/pangolin-orchestrator/src/executors/dispatch.ts:206-251` | private `readSentinel()` — 46 lines incl. defensive reconstruction |
| `packages/pangolin-cli/src/cmd-orch.ts:185-188` | builds the URI, `get`, `JSON.parse`, reads `.usage` |
| `examples/data-mapreduce/src/index.ts:430-438` | comment documents the layout, then hand-builds the URI |
| `examples/dogfood-gated/src/index.ts:165-171` | same shape, reads `.usage` |

The demand is internal first. ai-os would be the fifth copy and the only one
that cannot copy-paste from the others.

### 1.3 The structural gap: `describe` is unavailable to fire-and-forget

`writeDispatchRecord` is called at `packages/pangolin-client/src/dispatch.ts:447`,
which sits **inside the `reconcile` closure** defined at `:389-456`. It therefore
runs only when a caller holds the `InFlightDispatch` handle and awaits exit.

`dispatchWork` (`:495-506`) does that. `fireWork` alone does not. A fire-and-forget
consumer never produces `dispatches/<id>/record.json`, so
`describeDispatch` (`packages/pangolin-client/src/describe.ts:37-44`) throws
`DispatchRecordExpiredError` permanently — and per that file's own header
comment (`:5-9`) the caller cannot distinguish "expired" from "never existed".

The sentinel has no such dependency. The worker writes it from inside the
container (`packages/pangolin-worker/src/output-sentinel.ts:236-237`),
independent of any in-process handle.

**So Pangolin has two product-read paths and only the handle-bound one is
public.** Every out-of-process consumer falls off the supported surface. That is
the gap this spec closes, and it is general — not ai-os-shaped.

### 1.4 Two legs, two trust models

The distinction is load-bearing for §4 and §6.

**The sentinel is a record.** `dispatches/<id>/output.json` is written with a
**URI-addressed overwrite put, not content-addressed** — stated verbatim at
`output-sentinel.ts:234-236`. `DispatchRecordUriParts`
(`packages/pangolin-core/src/uri.ts:27-36`) carries no `contentHash` field, by
design: *"dispatch records are NOT content-addressed — the URI itself is the
canonical address"* (`:22-25`). **There is nothing to verify the sentinel
against.** It is mutable in place and worker-written. Defensive parsing is the
only available protection, which is why the orchestrator's copy reconstructs
every field rather than forwarding the parsed object
(`executors/dispatch.ts:225-227, 236-238`).

**The artifacts are self-verifying blobs.** `patchRef` and each `outputs[].ref`
are built by `buildPangolinUri({ namespace, type: 'artifact', name: dispatchId, contentHash })`
(`output-sentinel.ts:111` and `:187`). The hash is *in the URI*
(`PangolinUriParts.contentHash`, `uri.ts:16-17`) and so is the dispatchId, in the
`name` position. Both are recoverable by `parsePangolinUri` (`uri.ts:72`).

Consequence that drives D4: **the trustworthy bytes are named by an untrusted
manifest.** Verifying bytes against the hash in their own ref proves only "these
bytes match this ref" — not that the ref belongs to this dispatch.

### 1.5 Read-side prior art that does exist

`packages/pangolin-worker/src/bundle-fetcher.ts:107-116` defines a private
`fetchVerified(uri, contentHash, storage)` — `storage.get`, `computeContentHash`,
compare, throw `IntegrityMismatchError`. It is used for capability bundles
(`:151`) and, at `:178-181`, for **upstream products**: *"Inputs: opaque bytes
(upstream products — patches, artifacts, etc.)"*.

Two properties matter. It takes the expected hash **as a parameter** rather than
parsing it from the URI, and its callers' refs arrive in a `WorkerInput` bundle
that the orchestrator resolved and sealed — so the URI is trusted by
construction. Neither property holds for a consumer reading an unhashed sentinel.

---

## 2. Goals and non-goals

**Goals**

- One supported way to read a dispatch's product manifest, keyed on storage +
  `dispatchId`, with no fire-side handle and no client object.
- One supported way to fetch a product artifact that cannot be called without
  binding the ref to a dispatch.
- Collapse the four in-repo sentinel readers onto the published one.
- Leave Pangolin's security posture unchanged, and leave the worker's code path
  untouched (§6).

**Non-goals**

- Copying product bytes into consumer storage (consumer durability policy).
- Retention/expiry handling or policy (backend-enforced;
  `packages/pangolin-client/src/retention.ts:7-12`).
- Any `ExecutionResult`-shaped projection (orchestrator-specific).
- A batch/fetch-all convenience (D5).
- Changing `StorageProvider` (§9.1).

---

## 3. Decisions

### D1 — Publish the sentinel read

Rationale in §1.2 and §1.3: four internal duplicates plus a structural gap for
out-of-process consumers.

### D2 — Types to core; I/O to a new leaf package `pangolin-product`

**Split by kind, not by cohesion.**

- **Wire shape → `pangolin-core`.** `OutputSentinel`, `OutputEntry`,
  `BlockOutcome`, `MAX_OUTPUT_ENTRIES`. These are contract: the worker writes the
  shape, readers read it, and core is the contract sink every package already
  depends on. No departure — this is what core is for.
- **Read semantics → the new package.** `SentinelReadResult` is the reader's own
  result type, not part of the wire shape, so it lives beside the reader rather
  than adding a type to core that no core function uses. Core holds *what is on
  the wire*; the new package holds *how you read it*.
- **I/O functions → a new `packages/pangolin-product`.** `readOutputSentinel`,
  `fetchDispatchArtifact`, `ArtifactRefRejectedError`. Depends only on
  `pangolin-core`.

**Why not put the I/O in core.** Nothing in core takes a `StorageProvider` today
— `storage.ts` declares the interface and no core module consumes it. Core's only
non-pure imports are `createHash` (`audit-merkle.ts:1`, `content-hash.ts:13`) and
`spawn` (`bounded-command.ts:11`). Putting the reader there would make it the
first injected-provider I/O in core, eroding a property that is currently
absolute. Invariants that hold *mostly* stop being enforceable, and nothing
mechanically guards this one.

**The repo already decided this.** `packages/pangolin-verify/package.json:5`
states the rule in its own description: *"Standalone audit-bundle verifier — the
artifact an auditor runs. Owns the RFC 3161 / ASN.1 (pkijs) dependency so
pangolin-core stays dependency-light."* `pangolin-verify` is the same shape as
what we need — a consumer-side, read-only package depending only on core
(`package-map.md:29`) — and it exists in a leaf package **specifically to keep
core clean**. Following that precedent is cheaper than arguing against it.

**`pangolin-client` was also rejected**: it depends on
`@aws-sdk/client-secrets-manager` (`packages/pangolin-client/package.json`,
dependencies block). The charter's read-side adapter is specified to hold no
blob-store write credential and to be grep-provable per-credential; routing a
read-only path through the fire-side package inverts that.

**Cost, stated.** A sixteenth published package, and the four in-repo call sites
gain one workspace dependency each. Neither introduces a cycle — the new package
depends only on core, and nothing in core depends on it. Follow the repo's
`new-package` skill for scaffolding, and treat the workspace-dependency install
warning as a gate failure if one appears.

### D3 — Tri-state result, not nullable

```typescript
export type SentinelReadResult =
  | { status: 'ok'; sentinel: OutputSentinel }
  | { status: 'absent' }
  | { status: 'malformed'; detail: string };
```

`null` cannot carry the distinction consumers need. `writeSentinel` is wrapped in
try/catch by its caller (`packages/pangolin-worker/pipeline-runner.ts:454-472`),
which logs `escape.failed` and still returns `completed`; the entrypoint then
emits `dispatch.finished` regardless (`entrypoint.ts:576`). **A finished dispatch
with no sentinel is a normal outcome**, distinct from the failure path
(`entrypoint.ts:566`), and a consumer must be able to surface each rather than
silently producing nothing.

`absent` also covers retention purge, which is indistinguishable from
never-written at this layer — the same limitation `describe.ts:5-9` documents.
The reader does not attempt to distinguish them and says so in its docstring.

### D4 — One artifact fetch, always dispatch-bound; do **not** merge the worker's helper

```typescript
export function fetchDispatchArtifact(
  storage: StorageProvider,
  ref: string,
  opts: { dispatchId: string },
): Promise<Uint8Array>;
```

Invariants, all mandatory — there is no unguarded mode:

1. `parseStorageUri(ref).kind` must be `'blob'`. A `'dispatch-record'` URI is
   rejected. Without this, an attacker-written `patchRef` of
   `pangolin://<ns>/dispatches/<other-id>/record.json` would read another
   dispatch's captured stdout/stderr using the caller's credential.
2. `parsePangolinUri(ref).contentHash` must be present. Unpinned refs are rejected.
3. `parsePangolinUri(ref).name === opts.dispatchId`. This is the binding that
   makes the untrusted manifest safe to follow; the worker writes the dispatchId
   into that position (`output-sentinel.ts:111,187`).
4. The hash is taken **from the URI only** — never accepted from the caller — and
   compared against `computeContentHash(bytes)` over raw bytes.

**Rejected: a dual-mode `expect: {contentHash} | {dispatchId}` fetcher that the
worker could also use.** The `{contentHash}` branch is safe only when the hash
arrived over a trusted channel. The worker's did (manifest-sealed); a consumer's
would not — they would pull both `patchRef` and its hash from the same untrusted
sentinel, so an attacker supplies a real hash for another dispatch's artifact and
verification passes cleanly. "The hash came from somewhere trustworthy" is
provenance, not something a signature can enforce, so any API carrying both modes
ships a mode that is silently unsafe for the consumer who most needs it.

**Therefore `bundle-fetcher.ts`'s private `fetchVerified` stays exactly as it
is.** Its refs are namespace-scoped (capabilities, envs) and cannot carry a
dispatch binding; forcing the two together bends one contract to fit the other.
The two share roughly four lines of mechanics and no security contract. The
worker's code path gets **zero diff** — which is the property that keeps the seal
path out of review scope entirely.

### D5 — No batch fetch helper

`fetchDispatchArtifact` takes one ref. Shipping a "fetch all outputs" convenience
would invite a fan-out over an attacker-controlled `outputs[]` array;
`MAX_OUTPUT_ENTRIES` (256, `output-sentinel.ts:27`) bounds it at write time, and
not offering the amplifier keeps that bound meaningful at read time. Consumers
that want concurrency write their own loop and choose their own limit.

### D6 — The type move is type-only; sentinel bytes must not change

`OutputSentinel`, `OutputEntry`, `BlockOutcome` move to core;
`pangolin-worker/src/output-sentinel.ts` re-exports them so existing imports keep
working. `MAX_OUTPUT_ENTRIES` moves too. The orchestrator's duplicate
`MAX_SENTINEL_OUTPUTS` (`executors/dispatch.ts:238`) is not re-homed — it
disappears with the private `readSentinel` it bounded, since the published reader
performs that clamp internally (§4.2).

**`writeSentinel` must emit byte-identical output.** The additive-only discipline
is stated four times in `output-sentinel.ts` (`:73-79`, `:80-84`, `:86-89`, and
the `verify` block at `:65-72`) as *"absence leaves the sentinel hash
unchanged"*, and it is load-bearing for sealed-bundle reproducibility. The move
must not touch field order, optionality, or the `JSON.stringify` call at `:227`.

Guards: `packages/pangolin-worker/test/output-sentinel.test.ts` and
`packages/pangolin-worker/test/pipeline-golden.test.ts`. Additionally, re-run the
committed `examples/dogfood-gated/bundle.json` verification before merge — that
artifact has been corrupted by a repo-wide edit before.

### D7 — Lockstep pairing is the supported model; backward-read is the residual

The release train already publishes matched versions: npm packages at one version
and a worker image tagged `{{version}}`, `{{major}}.{{minor}}`, and digest
(`.github/workflows/pangolin-worker-image.yml:60-64`), with the workflow summary
directing production dispatches at the digest-pinned ref (`:86-93`). `workerImage`
is a required caller-supplied field (`packages/pangolin-client/src/dispatch.ts:61`),
and `audit.ts:59` documents it as digest-pinned. A consumer can therefore pin
reader and writer together.

Lockstep removes **forward** skew (old reader, new bytes). It does not remove
**backward** skew: the sentinel is data at rest, reads happen after deploys, and
the charter's approval flow reads days later. A 0.5.0 reader will parse 0.4.0
bytes.

Two reader rules, each with a test in §7:

1. **Require nothing optional.** Every field except `schemaVersion` may
   legitimately be absent — including `patchRef` (no changes:
   `output-sentinel.ts:109`) and `outputs` (oversized files are skipped at
   `:182`; `undefined` when empty at `:194`). Presence assertions belong at the
   call site, never in the parser.
2. **Ignore unknown fields; never reject on them.**

`schemaVersion: 1` remains the escape hatch for a genuinely breaking change.

---

## 4. API surface

### 4.1 `pangolin-core` — types and constants only

New module `packages/pangolin-core/src/product.ts`, re-exported from
`packages/pangolin-core/src/index.ts` (which uses `export *` per file, `:7-31`).
No imports beyond core's own modules; no `StorageProvider` consumption.

```typescript
export interface OutputEntry {
  path: string;   // posix-relative inside outputs/
  ref: string;    // pangolin://<ns>/artifact/<dispatchId>/sha256:...
}

export interface BlockOutcome {
  kind: string;
  ordinal: number;
  status: 'ok' | 'failed';
  exitCode?: number;
  durationMs: number;
  verify?: VerifyOutcome;
  patchRef?: string;
  outputs?: OutputEntry[];
}

export interface OutputSentinel {
  schemaVersion: 1;
  patchRef?: string;
  summary?: string;          // reserved — no worker path populates it today
  verify?: VerifyOutcome;
  outputs?: OutputEntry[];
  usage?: RuntimeUsage;
  blocks?: BlockOutcome[];
}

export const MAX_OUTPUT_ENTRIES = 256;
```

### 4.2 `pangolin-product` — the new leaf package

`packages/pangolin-product`, `"dependencies": { "@quarry-systems/pangolin-core": "workspace:*" }`
and nothing else.

```typescript
export type SentinelReadResult =
  | { status: 'ok'; sentinel: OutputSentinel }
  | { status: 'absent' }
  | { status: 'malformed'; detail: string };

export function readOutputSentinel(
  deps: { storage: StorageProvider; namespace: string },
  dispatchId: string,
): Promise<SentinelReadResult>;

export class ArtifactRefRejectedError extends Error {
  readonly reason: 'not-a-blob' | 'unpinned' | 'wrong-dispatch';
  readonly ref: string;
}

export function fetchDispatchArtifact(
  storage: StorageProvider,
  ref: string,
  opts: { dispatchId: string },
): Promise<Uint8Array>;
```

Notes on shape:

- `deps` is structural, so a `PangolinClient` satisfies it directly (it exposes
  readonly `storage` and `namespace` — `pangolin-client-api.md:44-46`). In-repo
  call sites pass `client` unchanged; a consumer passes a bare storage provider.
- `readOutputSentinel` does not throw for missing objects. The not-found
  detection currently private at
  `packages/pangolin-client/src/retention.ts:90-97` is duplicated here rather
  than moved: hoisting it to core would drag ENOENT/message sniffing — provider
  behavior, not contract — into the contract sink, and it is eight lines.
  `retention.ts` is left untouched.
- `fetchDispatchArtifact` **throws** on integrity failure —
  `ArtifactRefRejectedError` for the three ref rejections, and the existing
  `IntegrityMismatchError` (core `errors.ts`, thrown today by
  `verifyContentHash`, `content-hash.ts:97-102`) for a hash mismatch. Throwing
  matches the established convention for integrity failures.

Validation performed by `readOutputSentinel` is the orchestrator's existing
defensive reconstruction (`executors/dispatch.ts:225-250`), lifted: type-guard
each field, clamp `verify.report` to 16 KiB, bound `outputs` at
`MAX_OUTPUT_ENTRIES`, and build a fresh object rather than forwarding the parsed
one.

---

## 5. Migration

All four in-repo readers move onto the published reader in the same change. This
is what makes the surface a consolidation rather than a new feature.

| Call site | Change | Behavior |
|---|---|---|
| `pangolin-orchestrator/src/executors/dispatch.ts:206-251` | delete private `readSentinel`; call `readOutputSentinel`, keep the `outputs[] → Record<path, ref>` projection for `ExecutionResult` | must stay never-throws: map `absent`/`malformed` → `{}` |
| `pangolin-cli/src/cmd-orch.ts:185-188` | replace `get` + `JSON.parse`; keep deriving the dispatchId from `parsePangolinUri(s.manifestRef).name` | best-effort; keep the surrounding `catch` that never fails the watch (`:189`) |
| `examples/data-mapreduce/src/index.ts:430-438` | replace hand-built URI | unchanged output |
| `examples/dogfood-gated/src/index.ts:165-171` | replace hand-built URI | unchanged output; re-verify `bundle.json` after |

`pangolin-worker`: re-export the moved types; consume core's
`MAX_OUTPUT_ENTRIES`. **No behavioral change, no diff to `bundle-fetcher.ts`.**
It does **not** gain a dependency on `pangolin-product` — the worker writes, it
does not read.

Each of the four migrating call sites gains `@quarry-systems/pangolin-product` as
a workspace dependency. No cycle results: the new package depends only on core,
and no core module depends on it. Verify the clean-install build order rather
than assuming it — a workspace dependency cycle surfaces as an install warning
and breaks `pnpm -r build` ordering on clean CI, so treat any such warning as a
gate failure.

The orchestrator's existing test suite is the proof of a behavior-preserving
lift. If it needs edits, the lift was wrong.

---

## 6. Security posture

### 6.1 Unchanged

- **No new reach.** `buildDispatchRecordUri` is already public (`uri.ts:212`, via
  core's `export * from './uri.js'` at `index.ts:8`). Any holder of a
  `StorageProvider` can already construct `dispatches/<id>/output.json` and
  `get` it. The reader parses bytes the caller already had the credential to
  fetch; authorization remains entirely the storage provider's.
- **No credential path.** The reader mints nothing and takes an injected
  provider.
- **Env firewall, per-dispatch redaction, secret staging: untouched.** All are
  dispatch-time and worker-side; this is post-hoc and read-only.
- **Seal path untouched.** D6 forbids any change to written bytes; D4 leaves
  `bundle-fetcher.ts` alone.
- **No new dependencies, and core stays pure.** Core gains types only and keeps
  `"dependencies": {}` and its no-injected-I/O property (D2). `pangolin-product`
  depends solely on `pangolin-core`, so `scripts/check-dep-allowlist.mjs` — which
  forbids a `pangolin-*` package depending on any other Quarry Systems library —
  stays green. Confirm the new package is picked up by
  `scripts/check-declared-deps.mjs` as well.
- **Not an authorization surface.** Reads were never gated. Direct-dispatch
  consumers bypass the orchestrator-only authorizer already; this changes nothing
  there. The spec states it so the reader is not mistaken for a gate — the same
  trap ADR-0019 documented for `target`.

### 6.2 What the byte leg genuinely changes

Publishing a fetch changes the **caller**, not the code. `fetchVerified` is
private today and only ever called with manifest-sealed refs. A published fetcher
is callable with an attacker-influenced URI, because the sentinel naming it is
unhashed and overwrite-puttable (§1.4).

D4's four invariants close the two disclosure paths — cross-dispatch artifact
reads and dispatch-record reads. Net effect is a security **improvement** over
the status quo, in which a consumer hand-rolls a fetch with none of the four.

### 6.3 Threat table

| Threat | Mitigation | Where |
|---|---|---|
| Sentinel names another dispatch's artifact | `parsePangolinUri(ref).name === dispatchId` | D4.3 |
| Sentinel names a dispatch-record path | reject `kind: 'dispatch-record'` | D4.1 |
| Attacker supplies a matching hash for foreign bytes | hash taken from the URI only | D4.4 |
| Tampered artifact bytes | re-hash over raw bytes | D4.4 |
| Hash computed over parsed JSON instead of bytes | fetcher owns the hashing; callers never do it | D4.4 |
| Malicious sentinel field values | defensive reconstruction + clamps | §4 |
| Fan-out over attacker-controlled `outputs[]` | no batch helper | D5 |
| Oversized artifact fetch | **not mitigated** | §9.1 |

---

## 7. Testing

**Reader** — `ok`; `absent` (object missing); `malformed` (non-JSON bytes, and
valid JSON that is not an object); oversized `verify.report` clamped to 16 KiB;
`outputs` bounded at `MAX_OUTPUT_ENTRIES`; a hostile sentinel whose fields have
wrong types yields `malformed` or drops the fields rather than propagating them.

**Backward skew (D7)** — a bare `{"schemaVersion":1}` parses to `ok` with every
optional field `undefined`; a sentinel carrying unknown future fields parses to
`ok` and ignores them.

**Fetcher** — happy path; tampered bytes → `IntegrityMismatchError`; ref naming a
different dispatchId → `ArtifactRefRejectedError('wrong-dispatch')`; a
`dispatches/...` URI → `('not-a-blob')`; an unpinned artifact URI →
`('unpinned')`.

**Byte-identity (D6)** — `output-sentinel.test.ts` and `pipeline-golden.test.ts`
pass unmodified; `examples/dogfood-gated/bundle.json` re-verifies.

**Migration** — the orchestrator suite passes without edits.

---

## 8. Documentation

**Rule for this section.** No documentation change below may describe surface
that does not land in the same change. Two consequences already applied: the
optional `head?()` size probe discussed during design is **not** documented
because it is not being built (§9.1); and no doc may claim ADR validation,
because `scripts/validate-adrs.mjs` targets `docs/decisions/` — a directory that
**does not exist** in this repo (ADRs live at
`docs-site/src/content/docs/explanation/decisions/`) — and it is referenced by
neither `package.json` nor any workflow. That validator is dead. Repointing it is
noted in §9.3 as separate work, not assumed here.

### 8.1 Corrections to documentation that is wrong today

These are inaccurate independent of this change, and this change makes them
load-bearing.

**`docs-site/src/content/docs/reference/pangolin-client-api.md:198-203`** lists
`dispatch.fire` and `dispatch.describe` adjacently with nothing indicating that
`describe` cannot observe a `fire`-only dispatch. A reader reasonably concludes
`fire` → `describe` works. It does not (§1.3). Add the constraint and point
fire-and-forget consumers at `readOutputSentinel`.

**`docs-site/src/content/docs/reference/package-map.md:3`, `:8`, `:12`** say
Pangolin ships as **"fourteen packages"**. `packages/` contains **fifteen**, and
the v0.3.1 release published fifteen. The count is already wrong by one and this
change makes it sixteen. Fix all three occurrences (the frontmatter
`description:`, the prose, and the `## The fourteen packages` heading).

**`docs-site/src/content/docs/reference/package-map.md:9` and `:45`** call
`pangolin-core` the "types-only contract sink" and label it *"types only"* in the
mermaid graph, which `:16` in the same table already contradicts by describing
the hash chain, Merkle root, canonicalization, and `verify`/`verifyBundle` as
living in core. D2 keeps core free of injected I/O, so this change does **not**
worsen it — but the inaccuracy is pre-existing and adjacent, and the honest
wording is "contract sink plus the pure audit/verify core." Fix it here or file
it; do not let this change be read as endorsing the current wording.

### 8.2 Additions required by this change

| Page | Change |
|---|---|
| `reference/dispatch-lifecycle.md:132-165` | documents `OutputSentinel` and `usage` accurately as worker-written and uploaded to the dispatch-record URI. Add the public read, and state the §1.4 asymmetry: the sentinel is URI-addressed/overwrite-put and therefore unverifiable, while the artifacts it names are content-addressed and self-verifying |
| `reference/package-map.md` | per §8.1, plus a new table row for `pangolin-product` and a new node + edge in the mermaid dependency graph (`:45`ff) pointing at core |
| `reference/pangolin-client-api.md` | per §8.1 |
| `explanation/architecture-overview.md:110-113` | reads "On reconcile the executor records it as the item's `result_ref`", framing reconcile as the path to the product. Accurate for the orchestrator; add that the sentinel is readable without reconcile |
| `explanation/decisions/0020-*.md` | **new ADR** — the product read is a public, storage-keyed contract; the sentinel/artifact trust asymmetry; why the worker's fetcher stays private; lockstep pairing with backward-read as the residual. Must carry `status`/`date`/`deciders` frontmatter and `## Context` / `## Decision` / `## Consequences`, matching the existing series (e.g. `0014-stdout-cap.md`) — by convention, not by validator |
| `explanation/decisions/index.md` | add the 0020 row |

### 8.3 Verified as needing no change

`how-to/worker-file-layout.md`, `how-to/author-a-declared-pipeline.md`,
`how-to/handle-needs-input.md`, and ADRs 0008/0009/0011 reference the sentinel
only from the worker/write side or refer to the distinct `needs_input.json`
sentinel (`dispatch-lifecycle.md:45`), which this change does not touch.

---

## 9. Residuals and out of scope

### 9.1 Unbounded artifact reads — stated, not mitigated

`StorageProvider.get(uri)` takes no size bound
(`packages/pangolin-core/src/storage.ts:18`), and no read method on the interface
returns a size: `resolveLatest` (`:19-21`), `list` (`:22`), `resolveByHash`
(`:35-40`), and `listNames?` (`:51-54`) all return
`{uri|name, contentHash, registeredAt}`. There is no `head`, no range read, and
no stream. A consumer fetching an attacker-named ref therefore has no pre-check.

Deliberately not mitigated here:

- A cap parameter on `get` would be **unenforceable where it matters**. The
  consumer supplies the provider implementation; one that ignores the parameter
  leaves a caller believing they are bounded when they are not. An
  advisory-by-default security control is worse than a documented gap.
- A post-hoc length check in the fetcher guards against *propagating* an
  oversized buffer, not receiving one — the allocation already happened.
- An optional `head?()` following the `listNames?` precedent (`storage.ts:41-54`)
  is a legitimate design, but widens a core interface for a self-inflicted DoS —
  the caller's own credential, into the caller's own process — while the
  disclosure risks are already closed by D4. Recorded as a considered
  alternative, not built.

Enforceable placement is the consumer's provider (`HeadObject`/Content-Length
before `GetObject`). Per ADR-0014's own principle that visible truncation beats
silent truncation, the gap is stated in the `fetchDispatchArtifact` docstring
rather than papered over.

### 9.2 Explicitly out of scope

Byte transport into consumer storage; retention/expiry policy; `ExecutionResult`
projection; any change to `StorageProvider`; any change to `writeSentinel`,
`bundle-fetcher.ts`, or the seal path.

### 9.3 Separate follow-up

`scripts/validate-adrs.mjs` points at a nonexistent `docs/decisions/` and is
unwired from CI. Repointing it at `docs-site/src/content/docs/explanation/decisions/`
and adding it to a workflow is real cleanup, but it is not this change and must
not be assumed by it.

---

## 10. Release

Additive: new exports, types moved with re-export, no signature changes to
existing functions. **Minor — 0.4.0** across the train, with
`@quarry-systems/pangolin-product` published for the first time at the same
version.

Release-mechanics checklist this adds (follow the repo's `new-package` skill;
none of it is assumed done):

- The new package must be included in the workspace publish set — the v0.3.1
  release published fifteen packages; this one publishes sixteen.
- `packages/pangolin-product/package.json` needs `publishConfig.access: public`,
  the BUSL-1.1 license, and the `repository.directory` field, matching its
  siblings.
- The worker image workflow is unaffected (it builds from
  `docker/pangolin-worker/Dockerfile` and the worker gains no dependency here).

`summary?` stays reserved and undocumented as a populated field; no worker path
writes it — the pipeline path calls `writeSentinel` without one
(`pipeline-runner.ts:455-465`). Documenting it as available would violate §8's
rule.

---

## 11. Open questions

1. Does any consumer need `blocks[]` in the first published shape, or is
   exporting the type sufficient until one asks? Currently exported as a type and
   parsed defensively, with no consumer.
2. Should ADR-0020 also record the `describe`-is-handle-bound constraint as a
   decision, or is the `pangolin-client-api.md` correction (§8.1) enough?
3. Is `pangolin-product` the right package name? It matches the domain term used
   throughout (`concept-typed-product-handoff`, "the product contract").
   `pangolin-product-read` is more literal about direction; `pangolin-read` is
   shorter but claims more surface than this package owns. Naming is cheap to fix
   before first publish and expensive after.
