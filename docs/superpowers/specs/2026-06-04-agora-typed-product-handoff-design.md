# Typed-product node→node handoff (the `inputs/`/`outputs/` seam)

**Status:** design approved 2026-06-04 · **Author:** agent:claude-opus-4-8 (with Brett) · **Confidence:** medium

The mechanism by which a dependent task receives an upstream task's output by
content-addressed **reference**, so dependent dev (and, later, data) DAGs actually
run — downstream tasks build on upstream products. This is the load-bearing first
build of the composable execution model.

## 1. Context and locked decisions

This spec implements the handoff that the following vault pages settled. They are
**not** re-litigated here:

- `concept-typed-product-handoff` — handoff = typed, content-addressed ref (dev=patch-ref,
  data=dataset-ref, doc=doc-ref); the pattern's `onTaskDone` routes an upstream output ref
  into a downstream pending item's typed input; the worker stages it via an `inputs/` overlay.
- `idea-agora-bidirectional-artifact-seam` — the half-spec: `inputs/` in + `outputs/` out,
  both content-addressed + in the audit manifest; one spec covers both directions because
  they share storage + overlay/capture machinery + the audit-manifest hook.
- `decision-2026-06-03-pack-architecture-invariants-ship-only` — typed-product handoff LOCKED
  over workspace-mediated; outputs seam = invariant #3; effect-in-evidence = invariant #4.
- `decision-2026-06-04-execution-patterns-are-queue-level` — the pattern routes outputs→inputs;
  "the one genuinely new cross-layer mechanism is the typed-product handoff."
- `synthesis-composable-execution-model` — the 3-axis model (pattern × executor × block-pipeline
  over a fixed seal).
- `concept-audit-seal` — every task still seals; refs go in the manifest, verifiable independently.

### Settled constraints (carried in, not re-opened)

- Handoff is by content-addressed typed **ref**, not a shared workspace (serves dev AND data).
- The pattern's `onTaskDone` routes an upstream output ref into a downstream PENDING item's
  typed input; the worker stages it via an `inputs/` overlay (reuse `overlay-engine`).
- Edge-type compatibility is the only cross-cutting rule; mismatches → adapter blocks.
- Every task ends in `seal`; input-ref + output-ref MUST land in the audit manifest.
- v1 = **static** dependent DAG (whole DAG submitted up front). No `extendRun`/dynamic spawn.

### Two decisions made during this brainstorm

- **Scope: go large — build the FULL bidirectional seam in v1** (`inputs/` injection *and* the
  `outputs/` content-addressed capture), not the input-side-only minimum. Rationale: lay down
  the real composable-model substrate to set the stage for the next blocks/patterns work, per
  the bidirectional-artifact idea's own recommendation to spec both directions together. The
  dev pack will only exercise the input side (its output is already a patch), but the output
  seam ships so the first non-dev pack finds it ready.
- **Injection mechanism: resolve-at-fire (inputs stay immutable).** The concept page's "a small
  store op that injects the ref into a not-yet-ready item's `inputs`" is read as *intent*, not a
  schema mandate. The code shows `WorkItem.inputs` is an immutable JSON snapshot under a
  single-writer store with idempotent `saveRun`; mutating pending items would add a write path
  and a retry/idempotency hazard. Resolve-at-fire honors the intent (the ref lands in the
  downstream's *effective* input and in the sealed manifest) without touching those invariants.
- **The seal must be rock-solid (GTM priority).** `verify()` must *prove the handoff chain*, not
  merely record the refs. This is satisfied by the provenance-closure check in §6.

## 1a. Overlap reconciliation with recently merged PRs (#37, #38)

Audited against `origin/main` (tip `dcdfc09`, #34). This branch is up to date with main; the
two relevant merges both pre-touched this spec's surface.

**#37 — worker self-verify ("Gap A").** Touched nearly every file this spec edits
(`contracts/{executor,types,runstate-store}.ts`, `engine/tick.ts`, `executors/dispatch.ts`,
`runstate/sqlite.ts`, `worker/{entrypoint,output-sentinel}.ts`, new `worker/src/verify.ts` +
`agora-core/src/verify.ts`). It is **a template, not a collision** — the output-side flow this
spec needs is line-for-line the `verify?` plumbing #37 already shipped:

> `reconcile` reads the sentinel → `ExecutionResult.verify` → `tick` (`tick.ts:55`) calls
> `store.setVerify` → `ItemState.verify`. The sentinel field is optional + additive ("absence
> leaves the hash unchanged" — `output-sentinel.ts:28-34`), and `readSentinel`
> (`dispatch.ts:122-148`) defensively reconstructs a bounded copy rather than forwarding raw
> bytes.

The `outputRefs` channel mirrors this exactly. Three consequences flow into this spec:

1. **`FireContext` is guarded** — "Generic, executor-agnostic … NO AI/dispatch concepts (V1-D4) —
   just run identity + submission metadata" (`executor.ts:20-26`). So resolved refs must **not**
   go on `FireContext`. They ride the existing `item.inputs` carrier under a reserved
   `inputs.inputRefs` key (consistent with the existing reserved `inputs.{subagent,env,workerInput}`
   keys the `DispatchExecutor` already reads — `dispatch.ts:42-52`). See §4/§5.
2. **`outputs/` must not pollute the patch** — `capturePatch` is deliberately run *before* post-edit
   steps so build artifacts never leak into the diff (`output-sentinel.ts:48-53`); `patch-capture`
   excludes only `.agora`. The output seam adds `:(exclude)outputs` and sequences capture as
   `capturePatch → self-verify → captureOutputs → writeSentinel`. See §5.
3. **The demo changes** — self-verify (Gap A) already proves the edit inline, so a separate
   `dev.verify` downstream node is redundant *and* conflates three distinct "verify" concepts. The
   demo becomes `code-edit → code-edit` (dependent edit), which is what the GOAL literally asks. See §8.

**Three distinct "verify" concepts (disambiguation, since the names collide):**
- **worker self-verify** (`agora-core/src/verify.ts` `VerifyOutcome`, `worker/src/verify.ts`, #37) —
  runs the project's test command over the edit; report-only signal; does NOT gate the dispatch.
- **audit verify** (`audit/verify.ts` `verify()` + `verifyBundle()`, #38) — recomputes chain /
  merkle / anchor / signature; the tamper-evidence check.
- **this spec's handoff check** — *extends the audit verify* (#38) with provenance closure (§7);
  it has nothing to do with worker self-verify.

**#38 — verify-print (`agora verify`).** Shipped `verify()` (collect-all, per-check `CheckResult`),
`verifyBundle()`, `renderVerification`, and `VerificationReport.checks = {chain, root, signature,
anchor}`. This spec's §7 is purely additive on top: a fifth `handoff` check + render row.

## 2. Audited ground truth (code, 2026-06-04)

The design rides seams that already exist. Key facts:

**Orchestrator**
- `WorkItem = { id, executor, inputs: Record<string,unknown>, depends_on: string[], resourceLocks, subagentShape? }`
  (`packages/agora-orchestrator/src/contracts/types.ts`). `inputs` is persisted as an **immutable**
  `inputs TEXT` JSON column (`runstate/sqlite.ts`); no store op mutates a pending item.
- `tick.ts` lifecycle: `computeNewlyReady` (all deps `done`) → reconcile running (`done` + `resultRef`
  → `setResultRef`, **then the resultRef is never read again**) → validate `shape.inputSchema` +
  `acquireLocks` + `fire` → cascade skipped. The natural injection seam is **after reconcile-done,
  before downstream fire**. `effectTier` is computed then `void`-ed (`tick.ts:96`).
- `Executor.fire(item, ctx) → { dispatchHash, manifestRef? }`; `reconcile(hash) → { status, output?,
  resultRef?, verify? } | null` (`contracts/executor.ts`). For dev, `resultRef` IS the patchRef, read
  (with `verify`) from the worker `output.json` sentinel via `readSentinel` (`executors/dispatch.ts:122-148`).
  **Post-#37: `ExecutionResult.verify`, `ItemState.verify`, and `RunStateStore.setVerify` already exist** —
  the `outputRefs` channel this spec adds is an exact mirror of that plumbing.
- `operations-api.submit(run, actor)` does **zero** validation; schema validation is lazy at fire-time.
- `PackRegistry`/`SubagentShape { id, effectTier, inputSchema, outputSchema, capability }`
  (`contracts/subagent-shape.ts`, `packs/dev.ts`: `dev.code-edit`, `dev.verify`). `outputSchema`
  declared, not yet enforced.

**Worker**
- `overlay-engine.overlayCapabilities({ workspaceDir, bundles: { name, files: Record<path,Uint8Array> }[], adapter })`
  is **content-source-agnostic, path-based** — directly reusable by feeding `inputs/...` paths.
- `bundle-fetcher` fetches only `{ subagentDef, capabilities, envs }`; **no input-blob/artifact fetch.**
  `DispatchWork` has **no `inputRefs`/`outputRefs`**; `AGORA_INPUT_JSON` is inline JSON. `resources`
  means `{cpu,memory}` (naming landmine).
- `needs-input.ts` is the **HITL** "agent needs a human answer" sentinel — unrelated to artifact inputs.
- Output today = `computeWorkspacePatch` (plain `git diff`, no `--binary`, excludes only `.agora`) →
  content-addressed `patchRef`. **Post-#37** the sentinel is
  `OutputSentinel { schemaVersion:1, patchRef?, summary?, verify? }`, and `escapeWorkspace` is split into
  `capturePatch` + `writeSentinel` (so a post-edit step runs between) — `output-sentinel.ts`. The
  additive `verify?` field is the precedent this spec's `outputs?` follows. **No `outputs/` dir capture yet.**
- `entrypoint.ts` Step 6 overlays only `bundles.capabilities`.

**Audit/seal**
- `DispatchManifest { schemaVersion:1, runId, itemId, parent, executor, executorManifest, secretRefs,
  actor, submittedAt?, firedAt, manifestHash, signature? }`; `manifestHash = computeContentHash(base)`.
  The canonicalizer **sorts keys and drops `undefined`** (`agora-core/content-hash.ts`), so adding
  optional fields is **hash-safe by construction**. `canon.ts` `canonEntry` already has a `resultRef` slot.
- `verify()` checks chain hash + merkle root + anchor + signature; it does **not** fetch manifests
  or check cross-task ref linkage (`audit/verify.ts`, `verify-bundle.ts`). `AuditBundle` already
  carries `manifests: DispatchManifest[]`.
- Content-addressing substrate is mature: `computeContentHash → buildAgoraUri → storage.put/get`,
  dedup-by-hash, `verifyContentHash` on read. `capabilities-register.ts` is the pattern to mirror.

## 3. Wiring declaration — `needs` on the WorkItem

```typescript
interface WorkItem {
  id: string;
  executor: string;
  inputs: Record<string, unknown>;        // immutable submitted snapshot (unchanged)
  needs?: Record<string, InputBinding>;    // NEW: input key -> upstream product
  depends_on: string[];
  resourceLocks: string[];
  subagentShape?: string;
}

type InputBinding = {
  from: string;            // upstream item id
  select: OutputSelector;  // WHICH product of the upstream (nodes now emit >1)
};

type OutputSelector =
  | { kind: 'patch' }                 // the dev resultRef (=patchRef) — degenerate dev case
  | { kind: 'output'; path: string }; // a file the upstream wrote to outputs/
```

- The ergonomic `needs: { x: from('A') }` is lib/CLI sugar over this explicit wire form.
- **`needs` auto-contributes to `depends_on`**: at submit-normalization, `needs[*].from` is unioned
  into `depends_on`. The engine's readiness logic (`dep-resolver.computeNewlyReady`) is **untouched**,
  and it is impossible to wire a need without its dependency. `needs` is the only edge representation;
  there is no separate edge list on `Run`.
- `InputBinding`/`OutputSelector` are declared in `contracts/types.ts` next to `WorkItem` (same module
  the type extends), per the repo's contract-colocation convention.
- Persisted following the **exact #37 column pattern** in `runstate/sqlite.ts`: append `['needs','TEXT']`
  to the idempotent `MIGRATIONS` array (never hand-edit `CREATE TABLE`), add `needs` to `ItemRow`, write
  it in the `saveRun` INSERT (it is *submitted* data, like `depends_on`), and `JSON.parse` it in
  `rowToItem`. No new persistence style is introduced.

## 4. Resolve-at-fire — the engine mechanism (no store mutation)

**SoC: resolution is a PURE helper, not inlined into `tick`.** The repo keeps `tick` a thin orchestrator
that delegates each decision to a pure, IO-free function in `engine/*` (`computeNewlyReady` in
`dep-resolver.ts`, `selectRunnable` in `lock-manager.ts`, `effectTierPolicy` in `effect-policy.ts` — each
takes already-fetched `ItemState[]` and returns a decision; `tick` applies it to the store). The handoff
resolver follows that pattern exactly: a new `engine/needs-resolver.ts` exporting

```
// PURE — no store/IO; mirrors dep-resolver/lock-manager. tick passes the items it already fetched.
export function resolveInputRefs(
  item: ItemState,
  byId: Map<string, ItemState>,
): { inputRefs: Record<string,string> } | { error: string }

export function selectProductRef(upstream: ItemState, sel: OutputSelector): string | undefined
```

`tick.ts`, in the fire path **immediately before `inputSchema` validation** (`tick.ts:82-98`), calls it
and applies the result — keeping the same orchestrate-here / decide-there split as the existing helpers:

```
const r = resolveInputRefs(it, byId);                 // pure; reads no store
if ('error' in r) { store.setStatus(it.id, 'failed', r.error); store.releaseLocks(it.id); continue; }
const resolved = { ...it, inputs: { ...it.inputs, inputRefs: r.inputRefs } }; // reserved carrier key
if (it.subagentShape) shape.inputSchema.safeParse(resolved.inputs)  // existing validation, now over resolved
if (!store.acquireLocks(it.id, it.resourceLocks)) continue;
await ex.fire(resolved, { runId: it.runId, actor: it.actor, submittedAt: it.submittedAt }); // ctx UNCHANGED
```

- **The store is never mutated for a pending item.** Submitted `inputs` remain the immutable snapshot;
  resolution is a read + merge into the dispatch payload. Single-writer + `saveRun` idempotency untouched.
- **Idempotent under retry by construction**: an upstream is `done` (and a `done` item never re-runs)
  before the downstream becomes ready, so re-resolution after a downstream requeue reads identical refs.
- **Refs are sha256 content hashes**, so "resolved to ref X" *is* "resolved to content X."
- `selectProductRef`:
  - `{ kind: 'patch' }` → `upstream.resultRef` (existing).
  - `{ kind: 'output', path }` → `upstream.outputRefs[path]` (new store field, below).
  - Missing product → `resolveInputRefs` returns `{ error: 'unresolved needs <key>' }`; `tick` fails the
    item (defensive — the submit-time validator in §6 should already have caught structural mis-wiring).

**Contract changes (none to `FireContext` or the `Executor` signature)**
- Resolved refs travel under reserved `item.inputs.inputRefs` (key → content-addressed URI). The
  `Executor.fire(item, ctx)` signature and `FireContext` are **unchanged** — honoring the V1-D4 guard.
- `DispatchExecutor.fire` reads `item.inputs.inputRefs` and threads it into `DispatchWork.inputRefs` (§5)
  *and* into the manifest (§7). The ref values are also surfaced into the worker's input JSON
  (`item.inputs.workerInput`) so the prompt can name them.

**One store addition (write-on-completion, exact mirror of #37's `setVerify` — field-for-field)**
- `RunStateStore.setOutputRefs(itemId, map)` (beside `setVerify`), `ItemState.outputRefs?` (beside
  `verify`), `ItemRow.output_refs`, `['output_refs','TEXT']` appended to `MIGRATIONS`, `NULL` in the
  `saveRun` INSERT (set on completion, not submitted), setter does `JSON.stringify`, `rowToItem` does
  `JSON.parse`. This is the #37 `verify` column pattern verbatim — no new persistence style.

## 5. Worker — `inputs/` overlay in, `outputs/` capture out

### Input side (DRY: no new stager — input refs are already-pinned products)

The key simplification the audit surfaced: an input ref is an **upstream product that already lives in
storage** at its pinned `agora://…/<hash>` URI (a `resultRef`/`outputRef`). There is therefore **no
registration, no `serializeCapabilityBundle`, no credential scan, no new content-addressing path** for
inputs — those exist for *user-supplied* capability files; handoff inputs are internal, already-sealed,
already-scanned artifacts. Staging is pure pass-through of existing refs.

- `DispatchWork` gains `inputRefs?: Record<string,string>` (key → already-pinned URI). **Not** `resources`
  (that is `{cpu,memory}`).
- **Single staging channel (reuse, not a new env var).** The client assembles refs once into the existing
  `bundleRefs` object and ships them in `AGORA_BUNDLE_REFS_JSON` (the established channel for
  subagent/capabilities/env — `dispatch.ts`), adding `bundleRefs.inputs: Array<{ key, uri, contentHash }>`.
  `InFlightDispatch.resolved` (assembled in one place) gains `inputRefs` for the manifest (§7).
- **`bundle-fetcher` (DRY).** It currently fetches subagent/capabilities/envs as three near-duplicate
  fetch+verify blocks; the inputs fetch is a fourth. To avoid extending that duplication, factor a small
  shared `fetchVerified(uri, contentHash) → bytes` helper and route the new inputs fetch through it
  (optionally fold the existing three — same file, low-risk, in-scope). Returns
  `FetchedBundles.inputs: Array<{ key, bytes }>`.
- **Overlay (reuse, single pass).** `overlay-engine.overlayCapabilities` is already generic ({name,files},
  path-based merge) — the audit confirms it is content-source-agnostic. Build one `inputs` bundle
  `{ name:'inputs', files: { 'inputs/<key>': bytes } }` and pass it **in the same overlay call** alongside
  the capability bundles (their path namespaces don't overlap, so order is irrelevant) — one
  materialization pass, no second code path. (Optional honesty rename `overlayCapabilities → overlayBundles`
  since it already serves >1 bundle kind; deferrable to avoid call-site churn.)
- The ref URIs are also surfaced in the worker input JSON (`AGORA_INPUT_JSON`) so the prompt can name them.
- **Consumption ≠ materialization.** The seam *materializes the bytes at `inputs/<key>`*. Whether dev then
  `git apply`s `inputs/patch.diff` is a **pack/setup concern** (`agora-setup.sh`), not the generic seam —
  the "don't over-fit to git" discipline; the seam serves dev and data identically.

### Output side (the "go large" addition) — mirrors #37's `verify?` plumbing

- **Capture sequence** (slots into #37's `capturePatch` + `writeSentinel` split):
  `capturePatch → self-verify (Gap A) → captureOutputs → writeSentinel`. `captureOutputs` is a new
  `output-sentinel.ts` sibling of `capturePatch` that reuses the **same core primitives** (`computeContentHash`
  → `buildAgoraUri({ type:'artifact', … })` → `storage.put`) — no new content-addressing path; it just
  walks `workspace/outputs/` and collects `{ path, ref }`.
- **Patch must exclude `outputs/`.** `patch-capture.computeWorkspacePatch` currently excludes only
  `.agora` (`:(exclude).agora`); add `:(exclude)outputs` so deliberate deliverables never pollute the
  code diff (the same reason #37 captures the patch before post-edit steps).
- Extend `OutputSentinel` **additively** (on top of #37's `verify?`):
  `{ schemaVersion: 1, patchRef?, summary?, verify?, outputs?: Array<{ path, ref }> }`. `patchRef` stays
  the dev trunk; `outputs[]` is the **distinct** non-patch channel. Additive ⇒ hash-safe, per the same
  contract #37's `verify?` relies on.
- `DispatchExecutor.readSentinel` (already reads `patchRef`/`verify`) also reads `sentinel.outputs`
  **defensively** (bounded reconstruction, not raw-forwarding — matching the existing `verify` handling)
  → `ExecutionResult.outputRefs`; `tick.ts` (alongside the `setResultRef`/`setVerify` lines) calls
  `store.setOutputRefs`.
- `ExecutionResult` gains `outputRefs?: Record<string,string>` (beside the existing `resultRef`/`verify`).

## 6. Edge-type validation — at submit, fail-fast

`operations-api.submit` validates nothing today; validation is scattered (`validateShape` at
`PackRegistry` construction, `inputSchema.safeParse` per-item in `tick`). Rather than add a third ad-hoc
site, introduce **one pure validator, two callers** (DRY):

- **`engine/run-validator.ts`** (new, parallel to `dep-resolver.ts`) exporting a pure
  `validateRun(run, packs?) → string[]` (error list, empty = valid). Exported from the orchestrator barrel
  (`index.ts`) so the CLI reuses it — the established orchestrator↔CLI sharing path.
- **Two callers:** `operations-api.submit` calls it and **rejects** on errors (the chokepoint — "before
  anything runs"); a new CLI **`agora orch validate <plan.json>`** (sibling of the existing
  `agora orch submit` in `cmd-orch.ts`) calls the same function for pre-flight. Note: the repo CLI
  namespace is `agora orch`, not the concept page's `agora pipeline`.
- **What `validateRun` checks (layer a — submit-time, whole-DAG, fail-fast):** edge-type-**tag**
  compatibility (each typed product carries an `edgeType` tag — `patch-ref`; later `dataset-ref`,
  `doc-ref` — an edge `A.select → B.needs[key]` is valid iff the tags match); `needs[*].from` references an
  existing item; the selected product is declared on the upstream shape; `needs ⊆ depends_on`
  (post-normalization); plus existing run-shape checks (duplicate ids, unknown shape).
- **Layer b — fire-time `inputSchema.safeParse`** on the resolved value stays exactly as-is (different
  responsibility: structural check on the actual resolved bytes, not the wiring). Two layers, two clear
  owners — no overlap.

Tag mismatch → a precise error (`edge A→B: patch-ref→dataset-ref incompatible; needs an adapter block`);
**building** adapter blocks is deferred, naming the gap is v1. Deep zod *structural* subsetting is
intentionally **not** used: it is brittle and is not what lets heterogeneous pipelines coexist —
tag-matching is (literally "edge-type compatibility"). Dev v1 is the degenerate `patch-ref → patch-ref`
case; `edgeType` is a lightweight tag added to the shape's declared products (one tag, `patch-ref`, in v1).

Tags are sourced from a lightweight `edgeType` annotation on the shape's declared products (additive
to `SubagentShape`); with only the dev pack, the sole tag is `patch-ref`.

## 7. Audit — rock-solid seal via provenance closure

### Seal the refs (additive, hash-safe)

`DispatchManifest` gains optional `inputRefs?: Record<string,string>` (the **consumer** side, sealed at
fire). `outputRefs` (the **producer** side) cannot go in the manifest — it is built at fire, before the
run produces outputs — so it rides the refs-only export instead:
- `inputRefs` are known at fire (the manifest is built in `executors/dispatch.ts:76-85`); added to
  `buildManifest`'s input and to the hashed `base` before `computeContentHash(base)`. The canonicalizer
  sorts keys and drops `undefined`, so this **cannot perturb existing manifest hashes** — the same
  additive-safety contract #37's optional sentinel field relies on.
- `outputRefs` are produced at completion → recorded in `ItemState` (`setOutputRefs`) and carried in the
  refs-only `AuditItemOutcome` (which gains `outputRefs?`), beside the existing `resultRef`. The blobs are
  content-addressed, so the ref *is* the integrity proof.

### verify() proves the chain — provenance closure (the strong invariant)

> Every `inputRef` consumed by any item must equal a **sealed output product**
> (`resultRef`/`outputRef`) of another item in the same run, whose own manifest is chain-verified.

Because refs are sha256 content hashes, ref-equality *is* byte-equality — so `verify()` proves *every
byte a downstream saw was produced by a verified upstream in this sealed run*, **without re-fetching a
single blob and without trusting the operator.** This is qualitatively stronger than "we logged the refs."

Implementation (post-#38, additive): bare `verify()` (`audit/verify.ts`) only has `{ store, anchor }` —
no manifests — so the `handoff` check is computed in **`verifyBundle()`** (and any path holding the full
`AuditBundle`, which carries `manifests` + `items`). Bare entry-level `verify()` reports `handoff: 'n/a'`
(the honest value — `CheckResult.ok` already supports `'n/a'`). The check:
1. Build the producer set across `bundle.items`: each `resultRef` ∪ each `outputRefs` value.
2. For each `bundle.manifests[*].inputRefs` value, assert it ∈ the producer set **and** the producing
   item's chain entry verified.
3. Any unaccounted-for input ref → `handoff` fails (broken/tampered chain).

`VerificationReport.checks` gains a `handoff: CheckResult` field (additive to the existing
`{chain, root, signature, anchor}`); `renderVerification` (`audit/render.ts:108`) gains one more check
row after `anchor`. `intact` is extended to include `handoff !== false`.

## 8. Scope — v1 vs deferred

**In v1**
- `needs` wiring (+ auto-`depends_on` union) on `WorkItem`, persisted (`needs TEXT` column).
- Resolve-at-fire in `tick.ts` (no store mutation; reserved `inputs.inputRefs` carrier, `FireContext`
  untouched); `selectProductRef`.
- `RunStateStore.setOutputRefs` + `output_refs` column; `ItemState.outputRefs` (mirrors #37's `verify`).
- Worker: `DispatchWork.inputRefs`, `bundle-fetcher` input fetch + `verifyContentHash`, `inputs/<key>`
  overlay (reuse `overlay-engine`).
- Worker: `outputs/` capture (`captureOutputs`, patch excludes `outputs/`) → `OutputSentinel.outputs[]`
  → `readSentinel` → `ExecutionResult.outputRefs` → `setOutputRefs`.
- One pure `validateRun` (`engine/run-validator.ts`) called by both `operations-api.submit` and a new
  `agora orch validate` CLI; `edgeType` tag on shapes.
- Manifest `inputRefs` sealed (additive, hash-safe); `outputRefs` in `AuditItemOutcome`.
- `verifyBundle()` provenance-closure `handoff` check + `VerificationReport.checks.handoff` + render row.
- **Demonstrated by the dependent-edit dev DAG**: `dev.code-edit (A) → dev.code-edit (B)` where B binds
  A's `patch` via `needs`, the worker materializes it at `inputs/patch.diff`, B's setup applies it and
  edits further — i.e. *downstream builds on the upstream edit* (the GOAL). Each node's #37 self-verify
  is the inline green signal; the run ends with a passing provenance-closure `verify()`. (`code-edit →
  dev.verify` is **not** the demo — self-verify already covers inline verification.)

**Deferred**
- `dataset-ref` / `doc-ref` packs (the seam is generic; only dev exercises it in v1).
- Dynamic `spawn` / `extendRun` (v1 = static DAG).
- Adapter-block **construction** (v1 rejects mismatches with a precise error).
- **Generic-engine** consumption of inputs (the engine/worker only *materializes* `inputs/<key>`; it never
  interprets them). The dev demo's node-B `agora-setup.sh` does the dev-specific `git apply
  inputs/patch.diff` — a thin per-pack setup step shipped *with the demo*, deliberately kept out of the
  generic seam (the "don't over-fit to git" line). Generalized consumption helpers stay deferred.
- Seal-edge hardening (trusted time, signing-key custody, retention) — separate spec.

## 9. Risks / open notes

- **`edgeType` tag placement** on `SubagentShape` is additive but is a new product-typing surface; with
  one tag (`patch-ref`) it is trivially exercised. The shape of multi-product output typing (one tag per
  declared output) is forward-looking and unvalidated until a second pack.
- **`OutputSentinel` stays `schemaVersion: 1`** with an additive optional `outputs` field; readers must
  tolerate its absence (they already do via canonical drop-undefined). If a breaking sentinel change is
  ever needed, bump to `2` then.
- **Whole bet is dogfood-unvalidated** until a non-dev pack exercises the output seam — consistent with
  the medium confidence on the parent decisions.

## 10. Conformance to repo patterns & engineering principles

Audited against the live tree (esp. #37 as the canonical end-to-end pattern). Every addition rides an
existing pattern; nothing introduces a parallel style.

| Concern | Repo pattern followed | Where |
|---|---|---|
| New optional signal end-to-end | #37 `verify` template, field-for-field (core type → sentinel additive field → defensive `readSentinel` → `ExecutionResult`/`ItemState` → `setX` → one guarded `tick` line) | `outputRefs` (§5), `inputRefs` (§7) |
| SQLite column add | Idempotent `MIGRATIONS` array + `ItemRow` + INSERT + `rowToItem` round-trip (never hand-edit `CREATE TABLE`) | `needs`, `output_refs` (§3/§4) |
| Engine SoC | `tick` orchestrates; pure IO-free decision helper per concern in `engine/*` (`dep-resolver`, `lock-manager`, `effect-policy`) | new `engine/needs-resolver.ts` (§4) |
| Content-addressing | Reuse core primitives `computeContentHash`/`buildAgoraUri`/`storage.put`/`verifyContentHash` (as `capturePatch` does) | `captureOutputs` (§5) |
| Per-dispatch staging | Single `AGORA_BUNDLE_REFS_JSON` channel + one-place `InFlightDispatch.resolved` assembly | `bundleRefs.inputs` (§5) |
| Overlay | `overlayCapabilities` is already generic + path-based; one pass, no second code path | inputs overlay (§5) |
| Validation | One pure validator, two callers (submit + CLI), exported from the barrel | `validateRun` (§6) |

**DRY wins baked in:** (1) input refs are already-pinned upstream products → **no** new stager/serializer/
credential-scan (the capabilities-register machinery is for *user-supplied* files, not internal sealed
artifacts); (2) a shared `fetchVerified` helper absorbs the new inputs fetch instead of adding a 4th
near-duplicate block in `bundle-fetcher`; (3) `validateRun` replaces a third ad-hoc validation site with a
single shared function.

**Single-responsibility / SoC:** resolution (pure helper) ≠ orchestration (`tick`) ≠ execution
(`DispatchExecutor`) ≠ persistence (store) ≠ materialization (worker overlay) ≠ wiring-validation
(`validateRun`) ≠ structural-validation (`inputSchema.safeParse`) ≠ seal (`writeSentinel`/manifest). Each
addition lands in exactly one of these and touches no other's concern.

**Two optional, in-scope refactors** (flagged, not required): fold `bundle-fetcher`'s existing three fetch
blocks onto `fetchVerified`; rename `overlayCapabilities → overlayBundles` for honesty. Both are local and
deferrable; neither is unrelated refactoring.
