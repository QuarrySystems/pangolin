# The block-pipeline runner + the data pack — the third axis, forced by the second pack

**Status:** design approved 2026-06-05 · **Author:** agent:claude-opus-4-8 (with Brett) · **Confidence:** medium

The worker's hardcoded execution steps become a runner of typed, declared block-pipelines
(the third axis of PATTERN × EXECUTOR × BLOCK-PIPELINE over the seal), and the `data` pack —
agora's second pack, the validation the pack-architecture decision has demanded since
2026-06-03 — ships on top of it as registered script-block pipelines. Two waves: (1) the
runner as a BEHAVIOR-IDENTICAL refactor (the existing suite green unchanged is the
acceptance criterion), (2) registration surface + the data pack + a fully real, fully
offline end-to-end demo (no LLM, no Docker, no credits).

## 1. Context and locked decisions

This spec implements what the following vault pages settled. They are **not** re-litigated:

- `concept-execution-block` — a block is a typed step run in the worker sandbox; audit by
  conformance; built-in parameterized blocks (~90%) vs custom plugin blocks; **verify is the
  script block with a pass/fail lens**; the worker's hardcoded steps become the first
  built-ins.
- `concept-block-pipeline` — a task's body is an ordered block list with ONE fixed,
  auto-appended terminal: `seal` (never authored, never reorderable); everything else
  optional and freely orderable; the pipeline spec rides the dispatch like
  `subagentDef.verify` does.
- `concept-pack` — a pack is a named (`<pack>.<name>`) bundle of blocks + pipelines (+
  patterns); no first-class Pack object; packs are the extensibility surface.
- `decision-2026-06-03-pack-architecture-invariants-ship-only` (+ amendments) — the LOCKED
  typed-product handoff; invariants #1 (shape image wins), #3 (outputSchema is the
  contract), #4 (effect-in-evidence); `SubagentShape` SPLITS across the three axes; **the
  second pack is the forcing function** — this build is that forcing, done deliberately.
- `synthesis-composable-execution-model` — handoff BUILT (PRs #39/#40/#41), pattern layer
  BUILT (PRs #43/#45); this build closes the block-pipeline axis.
- `concept-typed-product-handoff` / `concept-execution-pattern` — as-built seams this build
  rides (needs/resolve-at-fire/outputs+inputs, map-reduce + extendRun); never rebuilt here.

### Settled constraints (carried in, not re-opened)

- Blocks expose typed, content-addressed I→O; non-conforming compositions are rejected
  (audit by conformance). The runner ALWAYS appends `seal`; users never write it.
- Heterogeneous pipelines coexist in one queue; edge-type TAGS are the only cross-cutting
  compatibility rule (`patch-ref` shipped; `dataset-ref` lands here).
- Engine core, `Executor` contract, pattern layer, handoff machinery: UNCHANGED. The
  refactor is worker-side; orchestrator-side only `executors/dispatch.ts` gains additive
  threading.
- Wave 1 is additive + behavior-identical; `SubagentShape` keeps working; the full
  shape→block split completes only when demand pulls it.
- The data pack is scripts only — zero API credits end-to-end; demos are fake-free.
- BUDGET: no API credits — design + offline-testable build only.

### Decisions made during this brainstorm

- **Full registration surface ships now, scoped to tier 1** (user decision): `agora
  pipeline register|validate|list` + lib `registerPipeline` — justified because the data
  pack is itself a registration consumer (two real consumers, not speculation). **Custom
  code blocks (tier 2 — `agora block register`, module loading into the worker) are
  RESERVED, not built**: the id namespace and content-addressing posture are fixed by this
  design (a custom block would register like a pipeline and seal its module hash the same
  way), but the loader/sandboxing/conformance machinery waits for a third-party consumer.
- **Data pack v1 = CSV split→transform→aggregate** riding the map-reduce pattern (user
  decision among equivalent flavors).
- **Approach A** for placement (see §3): contracts in `agora-core` as DATA, interpreter
  runner in `agora-worker`. Two guardrails adopted as invariants: (a) `PipelineSpec`
  carries `schemaVersion: 1` + optional-additive evolution from day 1 (core is published;
  specs are persisted content-addressed bundles that must stay readable forever); (b)
  `BlockContext` (storage/env/logger/redaction — runtime concerns) NEVER migrates into
  core. Core = what a pipeline IS; worker = how it RUNS.

### Reconciliations with the concept pages (as-built notes to record post-build)

1. **Type-flow validation narrows in v1.** The concept's guardrail ("each block's input
   satisfiable from prior ctx") is mostly trivial while all built-ins operate on the shared
   workspace ctx. `validatePipelineSpec` v1 enforces STRUCTURE (known kinds, reserved
   `seal` rejected, parameter validity, `<pack>.<name>` id, ≥1 block). Real per-block I/O
   tag flow activates with tier-2 custom blocks — the first blocks with non-workspace I/O.
2. **"Every task ends sealed" reads as "cannot end SUCCESSFULLY unsealed."** Today a
   non-zero runtime exit writes NO sentinel (failure evidence = lifecycle events + the
   orchestrator audit chain), and Wave 1 is behavior-identical, so failed pipelines abort
   without sealing. Enriching the failure path with partial block evidence is a named
   deferral, not an accident.

## 2. Audited ground truth (code, 2026-06-05)

**The worker entrypoint** (`agora-worker/src/entrypoint.ts`, `runWorker`) decomposes
cleanly into chassis vs payload:

| Steps | What | Disposition |
|---|---|---|
| 1–8 | env parse, storage, adapter load, bundle fetch+verify, HMAC, lifecycle, overlay (capabilities + `inputs/`), secret resolution, env firewall+merge | **chassis** — runner infrastructure, untouched |
| 9 | `agora-setup.sh` (gating, time-bounded) | chassis (pre-pipeline workspace prep) |
| 10/12 | channel subscribe/teardown | chassis |
| 11 | `adapter.invoke` (+ `runtime.adapter.ran` log) | **`agent` block** |
| 13 | needs_input sentinel resolution | chassis branch, fed by the agent block |
| 14 (success) | `capturePatch` → `runVerify`? → `captureOutputs` → `writeSentinel` | **the pipeline**: `capture(patch)` → `script(lens:verify)`? → `capture(outputs)` → auto-`seal` |
| 14 (failure) | no sentinel; `dispatch.failed`/`provider-failed`, exit code carried | reproduced exactly (reconciliation 2) |

**Concept built-ins ↔ existing primitives** (the mapping is nearly 1:1):
`agent` ↔ `adapter.invoke`; `script` ↔ `runBoundedCommand` (already powers setup-script
AND verify); `verify` ↔ `runVerify` = literally script-with-a-pass/fail-lens already;
`capture` ↔ `capturePatch`/`captureOutputs`; `seal` ↔ `writeSentinel` (+ orchestrator
manifest seal); `stage` ↔ overlay + `inputs/` materialization (stays chassis in v1 — it
must run before `captureBaseline`, i.e. before any block).

**Key facts the design rides:**

- `OutputSentinel { schemaVersion: 1, patchRef?, summary?, verify?, outputs? }` is
  versioned + additive-safe ("absence leaves the hash unchanged" — `output-sentinel.ts`).
  `readSentinel` (`executors/dispatch.ts`) reconstructs defensively.
- `subagentDef` is already a registered, content-addressed, integrity-verified bundle
  carrying `{ systemPrompt?, promptTemplate?, model?, verify?: VerifyConfig }` — the
  additive-optional-field precedent (`verify`) this spec's `pipeline` channel follows.
- `AGORA_BUNDLE_REFS_JSON` is the single staging channel (subagent / capabilities / envs /
  inputs); `bundle-fetcher`'s shared `fetchVerified(uri, contentHash)` absorbs new kinds.
- `runBoundedCommand` provides time-bounded, output-capped shell execution;
  `filterRuntimeEnv` + `mergeEnv` have already produced the firewalled `mergedEnv` before
  any payload step; `logger.redactString` covers every resolved secret.
- `RunWorkerDeps` is a full injection seam (storage, adapter, workspace, secret store,
  lifecycle observer) — `runWorker` runs IN-PROCESS in tests today. This is what makes the
  Wave 2 end-to-end demo possible with no container.
- `SubagentShape` carries `outputEdgeType?`/`inputEdgeTypes?` consumed by `validateRun`
  tag-matching (permissive: both ends must declare). `packs/dev.ts` + `PackRegistry` are
  the pack precedent; orchestrator-side data shapes slot in identically.
- `DispatchManifest` is versioned + canonical-JSON + additive-hash-safe (the `inputRefs`
  precedent); `AuditBundle` carries manifests; `verifyBundle` needs zero changes for this
  spec (sealing a ref whose value IS a content hash seals the content).
- Dependency topology: worker depends on core only; client and orchestrator depend on
  core. Core is the ONLY home all three contract consumers share (forces Approach A).

## 3. Placement — Approach A (chosen) and the rejected alternatives

**A (chosen): contracts as DATA in `agora-core`; interpreter runner in `agora-worker`.**
Core already hosts execution-adjacent contracts (`RuntimeAdapter`, `VerifyConfig`,
lifecycle, dispatch types) — `PipelineSpec`-as-JSON sits squarely in that character. The
trade-off (published-contract gravity: semver pressure + persisted specs readable forever)
is accepted and managed by the house pattern: `schemaVersion` + optional-additive fields +
canonical drop-undefined hashing, from day 1. Escape hatch: extracting an `agora-blocks`
package later is mechanical (consumers import the core barrel) — creating it now for two
files is the over-build.

**B (rejected): worker-local contracts, orchestrator re-declares for validation.** Two
sources of truth for a three-consumer contract — the drift the repo's validation
discipline exists to prevent.

**C (rejected): first-class `Block<I,O>` code objects from day one.** Builds plugin-shaped
machinery with zero custom-block consumers, against the tier-1-only scoping decision. The
interpreter keeps the same external contract; tier 2 arrives later as a registry extension,
not a reshape.

## 4. The contract (`agora-core/src/pipeline.ts`)

```typescript
export interface AgentBlockSpec   { kind: 'agent' }                  // params from subagentDef
export interface ScriptBlockSpec  {
  kind: 'script';
  command: string;                  // shell string, runBoundedCommand semantics
  timeoutSeconds?: number;          // default 600 (the verify default)
  lens?: 'gate' | 'verify';         // default 'gate'
}
export interface CaptureBlockSpec { kind: 'capture'; what: 'patch' | 'outputs' }
export type BlockSpec = AgentBlockSpec | ScriptBlockSpec | CaptureBlockSpec;

export interface PipelineSpec {
  schemaVersion: 1;
  id: string;                       // '<pack>.<name>', e.g. 'data.transform'
  blocks: BlockSpec[];              // 'seal' NEVER appears — reserved, runner-appended
  outputEdgeType?: string;          // tag vocabulary shared with SubagentShape
  inputEdgeTypes?: Record<string, string>;
}

/** PURE structural validator; empty array = valid. One validator, three callers
 *  (registerPipeline, `agora pipeline validate`, worker post-fetch). */
export function validatePipelineSpec(spec: PipelineSpec): string[]
```

Checks: `schemaVersion === 1`; id matches the pack-scoped form — **hoisted as a shared
`isPackScopedId()` in core** so the regex exists ONCE (`subagent-shape.ts`'s private
`ID_RE` is replaced by the core helper — orchestrator already depends on core; a targeted
in-scope DRY fix, not unrelated refactoring);
≥1 block; every `kind` known; the string `'seal'` rejected as a reserved kind with a
pointed error ("seal is auto-appended; remove it"); script `command` non-empty;
`timeoutSeconds` positive when present; `lens`/`what` within their unions; tags non-empty
strings when present. **No zod, no new dependencies** — tags are strings, checks are
comparisons (the same tags-not-structural-schemas call the handoff made, for the same
reason). `BlockContext` is deliberately NOT here (guardrail b).

## 5. The runner (`agora-worker/src/pipeline-runner.ts`)

```typescript
export interface BlockContext {       // worker-side ONLY — never exported from core
  workspaceDir: string; env: Record<string, string>;
  storage: StorageProvider; namespace: string; dispatchId: string;
  adapter: RuntimeAdapter;            // for the agent block
  subagent: { systemPrompt?; promptTemplate?; model? };
  inputJson?: string;
  baseline: WorkspaceBaseline;        // for capture(patch)
  redact(s: string): string;          // logger.redactString
  log(event: object): void;
}

export interface BlockOutcome {
  kind: string; ordinal: number; status: 'ok' | 'failed';
  exitCode?: number; durationMs: number;
  verify?: VerifyOutcome;                       // script lens:'verify'
  patchRef?: string; outputs?: OutputEntry[];   // capture blocks
}

export type PipelineResult =
  | { kind: 'completed'; outcomes: BlockOutcome[]; sentinel?: OutputSentinel } // sealed (best-effort)
  | { kind: 'failed'; outcomes: BlockOutcome[]; exitCode: number }             // gate failure → no seal
  | { kind: 'needs-input'; sentinelPath: string; outcomes: BlockOutcome[] };   // agent surfaced needs_input

export async function runPipeline(spec: PipelineSpec, ctx: BlockContext): Promise<PipelineResult>
```

- **Registry of built-in `BlockImpl`s keyed by `kind`** — each a thin wrapper over the
  existing primitive. `BlockImpl` realizes the concept page's `Block<I,O>` for tier 1; a
  future tier-2 loader is just another registry source.
- **The default pipeline is BUILT per-dispatch and equals today's behavior exactly:**

  ```typescript
  buildDefaultPipeline(subagent) = {
    schemaVersion: 1, id: 'dev.default', blocks: [
      { kind: 'agent' },
      { kind: 'capture', what: 'patch' },
      ...(subagent.verify ? [{ kind: 'script', command: subagent.verify.command,
            // reproduce the entrypoint's guard EXACTLY: falsy/non-positive timeout → 600
            timeoutSeconds: (typeof t === 'number' && t > 0) ? t : 600, lens: 'verify' }] : []),
      { kind: 'capture', what: 'outputs' },
    ],
  }
  ```

  The entrypoint's success path becomes `runPipeline(declared ?? buildDefaultPipeline(subagent), ctx)`.
  Behavior-identity is a data equality plus golden tests, not a code-path argument.
- **Auto-seal lives INSIDE `runPipeline`** (one unambiguous owner): on the completed path
  the runner itself calls `writeSentinel` with the aggregated `{ patchRef, verify, outputs }`
  from capture/verify outcomes — `seal` is structural, not a registry entry, so it cannot
  be omitted or reordered by any caller. Seal failures keep today's best-effort contract:
  logged via `ctx.log` (`escape.failed`), the result stays `completed`, the exit code and
  `dispatch.finished` are unchanged.
- **Behavior-identical pins** (each a golden test):
  1. needs_input: agent block surfaces `needsInputSentinelPath` → runner returns
     `needs-input` → entrypoint's existing step-13 branch runs unchanged (no further
     blocks, no sentinel, exit 0 on valid sentinel).
  2. Failure writes no sentinel: a `gate` failure (script non-zero/timeout/start-error, or
     agent non-zero exit) aborts → `dispatch.failed` / `provider-failed`, exit code
     carried. Identical to today.
  3. Sentinel byte-compatibility: `OutputSentinel` gains additive
     `blocks?: BlockOutcome[]` — written **only when a pipeline was explicitly declared**.
     The implicit default writes the legacy sentinel byte-for-byte; the first verify-lens
     outcome populates `sentinel.verify` either way (existing-reader contract).
  4. Adapter THROW (vs non-zero exit) stays `worker-failed` — the agent block re-throws;
     the chassis catch is unchanged.

## 6. The script block (semantics)

- Runs `runBoundedCommand` with `cwd = workspaceDir`, `env = ctx.env` (the firewalled +
  merged env the chassis built — same posture as agent/setup-script; nothing new).
- Output: captured bounded (verify's `8_000`-char default), `ctx.redact(...)`-ed before it
  lands in any outcome/log/sentinel.
- `lens: 'gate'` (default): non-zero exit / timeout / failure-to-start → block `failed` →
  pipeline aborts → `provider-failed` with the exit code carried (the task's substance
  failed — distinct from setup-script's `worker-failed`, which is chassis).
- `lens: 'verify'`: never fails the pipeline; **delegates to `runVerify` literally** (it
  IS those semantics — timeout/start-error → `passed: false`, bounded redacted report;
  one primitive, never a reimplementation); report-only, the Gap A contract.

## 7. Registration + dispatch wiring + evidence

- **Lib**: `agora-client/src/pipeline-register.ts` mirrors `subagent-register.ts`
  field-for-field — `validatePipelineSpec` (reject on errors) → `computeContentHash` over
  the spec object → `buildAgoraUri({ type: 'pipeline', ... })` (the URI `type` field is
  open; only `'dispatches'` is reserved — zero core URI changes) → write
  `canonicalJsonString` bytes → pinned ref. The mirror inherits two properties for free:
  **idempotent re-registration** (same content hash → reuse `registeredAt`, no duplicate
  put) and **`resolveLatest` name resolution** (dispatches may reference a bare pipeline
  name, resolved client-side to the latest pinned ref, the capability-ref pattern).
- **CLI**: `agora pipeline register <file>` / `agora pipeline validate <file>` /
  `agora pipeline list` — siblings of the subagent verbs in the existing CLI layout.
- **Dispatch**: a new bundle kind rides the existing `AGORA_BUNDLE_REFS_JSON` channel
  (`bundleRefs.pipeline: { uri, contentHash }`); `bundle-fetcher` verifies it via the
  **subagentDef path** — fetch → parse → `verifyContentHash` over the PARSED object (the
  canonical-JSON hash domain `registerPipeline` writes in; NOT the raw-bytes `fetchVerified`
  path, which is for opaque capability/input blobs); the worker then **re-validates with
  the same `validatePipelineSpec`** before running — a parse or validation failure routes
  through the established `integrity-failed` path (a bundle problem, exactly like a
  malformed capability bundle). Orchestrator-side the ref travels via a
  reserved `inputs.pipeline` key (joining `inputs.{subagent, env, workerInput, inputRefs,
  gate, mapReduce}`) that `DispatchExecutor` threads into `bundleRefs` — engine,
  `validateRun`, pattern layer, `Executor` contract untouched.
- **Evidence**: `DispatchManifest` gains additive `pipelineRef?` (the `inputRefs`
  precedent — hash-safe by the canonical drop-undefined contract). The ref IS the spec's
  content hash, so sealing the ref seals every block, command, and lens — "this exact
  pipeline ran" is provable with **zero new verification code**. Per-block runtime
  evidence = the sentinel's `blocks?: BlockOutcome[]` (declared pipelines only, §5).
  Invariant #4 (effect-in-evidence) is satisfied for the new surface by construction.
- **Boundary (repeat of the pattern-layer lesson):** `contracts/privilege.ts` and its
  exhaustive-membership test are NOT touched — pipeline verbs are client/CLI surface, not
  orchestrator operation surfaces.

## 8. The data pack

**Orchestrator side — `packs/data.ts`** (sibling of `packs/dev.ts`): three
`SubagentShape`s — `data.split`, `data.transform`, `data.aggregate` — with
`outputEdgeType: 'dataset-ref'` and matching `inputEdgeTypes`, exercising `validateRun`
tag-matching across a second domain for the first time. (Shapes remain the
orchestrator-side surface in v1; the shape→block split completes when demand pulls it —
the pack decision's posture, unchanged.)

**Worker side — three registered pipelines** (ids matching the shapes), each one script
block over portable `node -e` scripts (cross-platform, no toolchain assumptions):

```
data.split:      [script: read inputs/dataset → write outputs/part-<i>.csv]   (N data-dependent)
data.transform:  [script: read inputs/part    → group-and-sum → outputs/result.json]
data.aggregate:  [script: read EVERY file under inputs/ → merge → outputs/total.json]
```

**Read-path convention (pinned by the handoff mechanics):** inputs materialize at
`inputs/<needsKey>`, NOT at their original filenames — so the scripts read by needs KEY.
The split item's seed CSV binds as `needs: { dataset: ... }` → `inputs/dataset`; map
templates use `needsKey: 'part'` → `inputs/part`; the reduce's spawn-time-concretized keys
are `<keyPrefix>-<splitter-output-path>` (mechanical, unlovely — e.g.
`part-part-0.csv`), so the aggregate script simply reads every regular file under
`inputs/` rather than computing key names.

**The map→reduce wiring is the shipped machinery, unchanged**: the splitter item completes
with N `outputRefs`; the map-reduce pattern spawns N transform items (each `needs` one
part via `{kind:'output', path}`) and one aggregate with spawn-time-concretized `needs`
over all results; resolve-at-fire + the `inputs/` overlay materialize the bytes; manifests
seal `inputRefs` (+ now `pipelineRef`); provenance closure covers the whole grown graph.

**Adapter blocks — answered, not forced**: with one coarse `dataset-ref` tag on every
edge, no mismatch exists and no adapter is needed. Finding recorded: adapters activate
when a pack declares finer-grained tags (e.g. `csv-ref` vs `json-ref`); construction stays
deferred with that named trigger — the handoff spec's exact posture.

**The novel piece — `InProcessWorkerExecutor`** (orchestrator test fixture, ~80 lines):
an `Executor` whose `fire` runs the worker's `runWorker()` **in-process** through the
existing `RunWorkerDeps` seam (local storage, local secret store, stub `RuntimeAdapter` —
data pipelines have no agent block; no container, no Docker, no network) and whose
`reconcile` reads the real sentinel into `{ status, resultRef?, outputRefs?, verify? }`.
Lives at `packages/agora-orchestrator/test/fixtures/inproc-worker-executor.ts` (workspace
devDependency on `agora-worker`). This makes the end-to-end test REAL at every layer:
real orchestrator run → real map-reduce spawns through the audited `extendRun` → real
worker executions → real script blocks → real content-addressed datasets → real sealed
manifests → real provenance closure. Offline, zero credits.

**Demo**: `examples/data-mapreduce` (handoff-dag workspace template — private,
`workspace:*` deps, tsx, start/typecheck/build, BUSL-1.1, no test script): submits ONE
`split` item with `inputs.mapReduce` templates referencing the data pipelines; prints the
grown graph, per-block evidence, and the green `verifyBundle`. The "second pack forcing
function" made runnable.

## 9. Scope — waves, tests, deferred

**Wave 1 — runner (behavior-identical)**

- `agora-core/src/pipeline.ts` (`BlockSpec`/`PipelineSpec`/`validatePipelineSpec`) +
  barrel export.
- `agora-worker/src/pipeline-runner.ts` (registry, three built-in impls,
  `buildDefaultPipeline`, `runPipeline`); entrypoint success-path swap.
- `OutputSentinel.blocks?` (additive; declared pipelines only).
- Tests: full existing suite green UNCHANGED; golden-sentinel byte-compat (default
  pipeline ↔ legacy path, same bytes); runner units (gate abort, verify lens, needs_input
  surfacing, declared-pipeline `blocks[]` evidence, reserved-seal rejection); validator
  units.

**Wave 2 — registration + data pack**

- `agora-client` `registerPipeline` + CLI `agora pipeline register|validate|list`.
- Bundle kind: `bundleRefs.pipeline` → `fetchVerified` → worker re-validate → runner;
  `DispatchExecutor` threading from `inputs.pipeline`; manifest `pipelineRef?`.
- `packs/data.ts` (3 shapes, `dataset-ref` tags) + 3 pipeline specs + portable node
  scripts (fixture assets).
- `InProcessWorkerExecutor` fixture; the end-to-end int test (orchestrator × map-reduce ×
  worker × script blocks × provenance closure — fake-free); `examples/data-mapreduce`.

**Deferred (named triggers)**

- Tier-2 custom code blocks (`agora block register`, module loading/sandboxing/conformance)
  — trigger: a third-party pack needing behavior built-ins can't express. Namespace +
  content-addressing posture reserved by this design.
- Per-block I/O tags / real type-flow validation — trigger: tier 2 (first non-workspace
  block I/O).
- Failure-path sentinel (partial block evidence on aborted pipelines) — trigger: operator
  demand for richer failure forensics; today's lifecycle+audit failure evidence is the
  contract.
- Finer-grained dataset tags + adapter-block construction — trigger: a pack declaring
  tags that actually mismatch.
- `stage` as a declared block (overlay/inputs materialization is chassis in v1 — it must
  precede `captureBaseline`).
- Shape→block split completion (shapes remain the orchestrator surface).

## 10. Conformance to repo patterns

| Concern | Pattern followed | Where |
|---|---|---|
| Versioned, additive, hash-safe evidence | `OutputSentinel.verify` / manifest `inputRefs` precedents | `sentinel.blocks?`, manifest `pipelineRef?` (§5/§7) |
| One validator, N callers | `validateRun` (submit + CLI + extendRun) | `validatePipelineSpec` (register + CLI + worker) (§4) |
| Single staging channel | `AGORA_BUNDLE_REFS_JSON` + shared `fetchVerified` | `bundleRefs.pipeline` (§7) |
| Registration | `subagent-register.ts` field-for-field | `pipeline-register.ts` (§7) |
| Reserved inputs keys | `inputs.{subagent, env, workerInput, inputRefs, gate, mapReduce}` | `inputs.pipeline` (§7) |
| Pack | `packs/dev.ts` + `PackRegistry` + shape tags | `packs/data.ts` (§8) |
| Injection seam for offline reality | `RunWorkerDeps` | `InProcessWorkerExecutor` (§8) |
| Shared test fixtures | `test/fixtures/pattern-harness.ts` (reused for orchestrator-side assertions) | Wave 2 int test (§9) |
| Boundary discipline | privilege.ts exhaustive test untouched; zero `src/engine/` diffs | standing acceptance criteria (§9) |

**SoC:** spec/validation (core, pure) ≠ execution (worker runner) ≠ registration (client)
≠ threading (dispatch executor) ≠ pack content (packs/ + scripts) ≠ evidence (sentinel +
manifest, additive). Each addition lands in exactly one box.

## 11. Risks / open notes

- **Published-contract gravity is permanent**: once `PipelineSpec@1` ships and specs are
  persisted, the additive-only discipline is forever. Accepted knowingly (§3); the house
  pattern has held twice (sentinel, manifest).
- **Byte-compat golden tests are load-bearing**: if the default-pipeline refactor drifts
  even one sentinel byte, dev-pack consumers see hash changes. The golden tests pin
  legacy-vs-runner equality on identical inputs; treat any golden failure as a
  ship-blocker, never a test to update casually.
- **`InProcessWorkerExecutor` is a fixture, not a product surface** — it must not leak
  into examples as a recommended production executor (it bypasses container isolation by
  design). The example README states this.
- **Windows/posix**: scripts are `node -e` for portability, but `runBoundedCommand` uses
  the platform shell; CI (Linux) is the source of truth — the posix-gated-test lesson from
  the verification-topology memory applies. Run CI before claiming green.
- **Whole bet is live-unvalidated** until the meta-dogfood (live workers) runs — same
  residual as the pattern layer; the data pack reduces but does not eliminate it.
