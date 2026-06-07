# The pattern layer — per-queue execution patterns over the unchanged engine

**Status:** design approved 2026-06-05 · **Author:** agent:claude-opus-4-8 (with Brett) · **Confidence:** medium

Per-queue execution patterns (`plan` + `onTaskDone`) layered above the unchanged engine, so one
queue can run static-DAG, map→reduce, and pipeline shapes over the shipped typed-product handoff
(PRs #39/#40/#41). This is the largest unbuilt axis of the composable execution model
(PATTERN × EXECUTOR × BLOCK-PIPELINE over the seal).

## 1. Context and locked decisions

This spec implements what the following vault pages settled. They are **not** re-litigated here:

- `decision-2026-06-04-execution-patterns-are-queue-level` — patterns are per-queue strategy
  objects; curated set (static-DAG, map→reduce, pipeline); dynamic work is spawn, never in-graph
  cycles; gating is pattern policy in `onTaskDone`.
- `concept-execution-pattern` — the concept this builds: how tasks RELATE, distinct from what a
  task does (block-pipeline) or where it runs (executor); routes by typed boundary, blind to
  block internals.
- `synthesis-composable-execution-model` — the 3-axis model; its 2026-06-05 update records the
  handoff as BUILT. Patterns route THROUGH the handoff, never rebuild it.
- `concept-typed-product-handoff` — as-built: `needs` wiring, resolve-at-fire, provenance closure.
- `decision-2026-06-03-cron-scheduling-is-a-run-producer` — the producer-fed append-able-run
  posture; deterministic ids → free dedup (the idempotency posture spawn mirrors).
- `decision-2026-06-03-pack-architecture-invariants-ship-only` (amendment) — ALL graph growth
  flows through the AUDITED submission seam with an actor; worker-driven in-path fan-out is
  deliberately foreclosed as off-wedge.

### Settled constraints (carried in, not re-opened)

- Pattern = per-queue strategy object. The engine core (ready-queue / `depends_on` / locks /
  tick / seal), the `Executor` contract, and the handoff machinery are UNCHANGED underneath.
- Dynamic fan-out and circle-back/remediation are SPAWN (re-submission via the append-able run),
  never in-graph cycles — the engine stays acyclic.
- Spawned work flows through the audited submission path (actor-attributed, validateRun-gated,
  audit-logged) — provability by construction extends to dynamic graphs.
- Curated set ships first behind one common interface; user-defined patterns are demand-pulled.
- Every task still ends in seal; provenance closure must hold over spawned graphs.
- Budget: no API credits — offline-testable build only (fake executors), like Waves A–C.

### Decisions made during this brainstorm

- **extendRun is internal-only in v1.** The pattern layer is the sole caller. External
  (operator/producer) append to a live run stays demand-pulled — no transport/envelope changes.
- **Demo: both, small.** `examples/pattern-mapreduce` (N-unknown fan-out → reduce) AND
  `examples/pattern-dogfood` (a 3-node DAG-plan excerpt with one gate + circle-back). Each is
  small; both load-bearing claims (dynamic-spawn provability, the zero-credit dogfood loop) get
  a runnable artifact.
- **The engine is untouched — literally zero diff.** An earlier draft had `engine/tick.ts`
  additively returning the items that completed this tick. The replay analysis (§7) showed
  re-derivation from the store must be the only mechanism anyway (a crashed process has no
  "newly completed" event to replay), so the pattern phase derives everything from
  `store.getItems()` — which the orchestrator already reads for sealing.

### Two reconciliations with the 2026-06-04 vault pages (supersessions to record post-build)

1. **`onTaskDone → {route, ready, spawn}` collapses to `→ {spawn?}`.** The as-built handoff
   already superseded imperative routing: *route* is declarative — it is the `needs` wiring the
   pattern writes at plan/spawn time; `engine/needs-resolver.ts` threads the refs at fire
   (resolve-at-fire, recorded on `concept-typed-product-handoff`). *Ready* is derived by
   `computeNewlyReady` from `depends_on`; a pattern marking items ready would bypass engine
   dependency semantics. Spawn is the only imperative power a pattern holds. Same intent
   (pattern owns relating/gating/growth; engine unchanged), honest as-built shape.
2. **The pack-invariants guardrail is satisfied by an internal seam.** `extendRun` is
   orchestrator-side (the foreclosed capability is *worker-driven* in-path fan-out — patterns
   run in the orchestrator, never in workers), actor-attributed (`pattern:<queue>`),
   validateRun-gated over the merged graph, and audit-logged (`run.extended`). Its
   *authorization* derives from operator-declared queue config: binding a pattern to a queue is
   the act that authorizes that pattern's growth policy.

## 2. Audited ground truth (code, 2026-06-05)

**The collision, confirmed.** `orchestrator.ts:64` — `if (this.store.getItems(run.id).length > 0)
return run.id;` — `submitRun` is an idempotent no-op for any known runId. There is no append
path. Cron **relies** on this no-op for dedup (deterministic `${scheduleId}@${slotIso}` runIds),
so the append seam must be a **new method**, not a behavior change to `submitRun`.

**Seal timing forbids spawn-through-the-inbox.** `orchestrator.tick()` (orchestrator.ts:110-131)
seals a run's audit epoch the moment all its items are terminal. Spawn routed through the
transport inbox (the cron precedent) would land at tick N+1 — but the run seals at tick N. Spawn
must be applied synchronously inside the same `orchestrator.tick()` call, before the seal block.

**Provenance closure requires same-run append.** `audit/verify-bundle.ts:27-52`
(`checkHandoffClosure`) checks every consumed `inputRef` against products of completed items
**in the same run**. Spawned work consuming upstream products must append to the existing run —
a separate "remediation run" would fail closure by construction. The append-able run is what
keeps spawned graphs provable, not just posture.

**Other facts the design rides:**

- `QueueConfig = { concurrency }` (orchestrator.ts:16) — the natural binding site.
- `engine/tick.ts` lifecycle: `computeNewlyReady` → reconcile running → `resolveInputRefs` →
  fire → `computeSkipped` cascade. All completions happen inside tick (reconcile or fail-fast
  `setStatus` in the fire path); `recoverStranded` requeues, never completes.
- `computeNewlyReady` readies a pending item when **every** dep is `done`; for a zero-dep item
  `every` over `[]` is true — spawned roots ready on the next pass with no trigger involvement.
- `validateRun(run, packs?)` (engine/run-validator.ts) is pure: duplicate ids, reference
  existence, `needs ⊆ depends_on`, DFS cycle check, pack/edge-tag checks. `normalizeRun`
  auto-unions `needs[*].from` into `depends_on`. One validator, currently two callers
  (`submitRun`, `agora orch validate`).
- Item ids are namespaced `${runId}\x1f${id}` at ingestion (orchestrator.ts:10-14); executors
  see de-namespaced ids.
- `AuditEntryKind` is a closed union (contracts/audit.ts:23-25); `canonEntry` serializes fields
  positionally (`[kind, runId, itemId, status, actor, manifestRef, resultRef, at, seq]`) — a new
  kind value is additive and cannot perturb existing chains.
- `ItemState` carries `inputs` (immutable submitted snapshot), `outputRefs`, `verify`, `actor`,
  `attempts` — everything a pattern needs to decide is already persisted by the single-writer
  store.
- Reserved `inputs.*` keys are an established convention: `inputs.{subagent, env, workerInput,
  inputRefs}` (dispatch.ts, needs-resolver path).
- The worker self-verify signal (`VerifyOutcome`, Gap A / #37) is report-only: a done-but-red
  item does NOT cascade; only `failed`/`skipped`/`cancelled` deps skip dependents.

## 3. The two ingestion pathways (where `plan()` and `extendRun` sit)

```
  SUBMIT-TIME (once per run)                      TICK-TIME (every tick, per pattern-bound queue)
  ─────────────────────────                       ────────────────────────────────────────────────
  client / cron producer                           AgoraOrchestrator.tick(queue)
        │                                                │
        ▼                                                ▼
  inbox → pollInbox                              ┌─ 1. engine tick  (UNTOUCHED) ──────────────┐
        │                                        │   computeNewlyReady → reconcile running    │
        ▼                                        │   → resolveInputRefs → fire → computeSkipped│
  orchestrator.submitRun(run, actor)             └──────────────────┬─────────────────────────┘
        │                                                           │
        ▼                                                           ▼
  ┌ pattern.plan(run) ┐   NEW — queue's pattern   ┌─ 2. pattern phase  (NEW) ──────────────────┐
  │ expand/normalize  │   expands the submission  │  for each UNSEALED run in queue:           │
  └─────────┬─────────┘                           │    for each TERMINAL item:                 │
            ▼                                     │      onTaskDone(item, {runItems})          │
  normalizeRun → validateRun ◄────────────────────│            │ SpawnDirective?               │
            │         ▲     (same validator —     │            ▼                               │
            ▼         │      3 callers: submit,   │      extendRun(runId, items, actor)        │
  saveRun + markReady │      extend, CLI)         │        id-skip → validate merged →         │
            │         │                           │        save pending → audit 'run.extended' │
            ▼         └───────────────────────────└──────────────────┬─────────────────────────┘
  audit 'run.submitted'                                              │ spawned items now pending
                                                                     ▼
                                                  ┌─ 3. seal check  (UNTOUCHED logic) ─────────┐
                                                  │  all items terminal? ──no──► (grew: cannot │
                                                  │        │ yes                 seal this tick)│
                                                  │        ▼                                   │
                                                  │  'run.completed' + sealEpoch(runId)        │
                                                  └────────────────────────────────────────────┘
```

Seal safety is the ordering: spawns land in step 2, the all-terminal check runs in step 3 — a
run that just grew has pending items and structurally cannot seal in the tick that grew it. No
veto mechanism, no new state.

## 4. The Pattern contract

```typescript
// contracts/pattern.ts (new, beside trigger.ts — same "policy seam" family)

/** Items a pattern asks to append to the run, in submission (pre-namespace) id space. */
export interface SpawnDirective {
  items: WorkItem[];          // deterministic ids — replay-safe by construction
}

export interface PatternContext {
  /** All items of the completed item's run, de-namespaced — the pattern's ENTIRE world.
   *  Derived from the store by the orchestrator; patterns never touch the store. */
  runItems: ItemState[];
}

export interface Pattern {
  id: string;                                   // 'static-dag' | 'map-reduce' | 'pipeline'
  /** Expand/normalize a submission BEFORE validateRun. Pure. Identity for static-DAG.
   *  MAY throw a descriptive Error on malformed pattern config (e.g. bad inputs.mapReduce);
   *  submitRun surfaces it like a validation failure — before saveRun, so the store stays clean. */
  plan(run: Run): Run;
  /** Called AT LEAST ONCE per terminal item of an unsealed run, every tick until the run
   *  seals. MUST be pure and idempotent: deterministic spawn ids; same inputs → same
   *  directive. Returns spawn directives (or null). The orchestrator applies them. */
  onTaskDone(item: ItemState, ctx: PatternContext): SpawnDirective | null;
}
```

- **Binding:** `QueueConfig` becomes `{ concurrency: number; pattern?: Pattern }`. No pattern =
  exactly today's behavior. The queue carries the pattern; tasks in it are routed by it.
- **Both hooks are pure decisions** — the orchestrator owns all store/audit application,
  mirroring the engine's `computeNewlyReady` / `selectRunnable` / `resolveInputRefs` split.
  Pattern implementations live in a new `patterns/` directory (sibling of `triggers/`,
  `executors/`), one file per pattern.
- **`plan()` runs inside `submitRun`** before `normalizeRun`/`validateRun` — pattern expansion
  goes through the same validation chokepoint as hand-written runs. A pattern cannot emit an
  invalid graph and have it ingested.
- **`onTaskDone` fires for every terminal status** (`done`, `failed`, `skipped`, `cancelled`),
  not just done — gating needs failures; map→reduce needs to know a map died. Patterns ignore
  statuses they don't care about.
- **At-least-once, derived, never tracked.** The pattern phase in `orchestrator.tick()` scans
  the store it already reads for sealing: for each pattern-bound queue, for each in-scope run,
  call `onTaskDone` for every terminal item. Idempotency (deterministic ids + extendRun id-skip)
  makes repeated delivery a no-op. Cost is O(terminal items) of pure map lookups per tick —
  fine at v1 scale; a high-water mark is a later optimization if pulled.
- **Scan scope, both modes.** With `auditLog` configured: runs whose epoch is unsealed
  (`getAuditRoot(runId) === undefined` — the same guard the seal block uses). Without
  `auditLog`: all runs of the queue, accepting the idempotent re-scan of settled runs (pure
  lookups, no-op spawns). The scan-then-spawn-then-seal ordering within one tick is identical
  in both modes.
- **`cancelled` is operator intent, not a gate signal.** Curated v1 patterns never spawn from a
  `cancelled` cause, and `respawnLineage` skips any lineage containing a cancelled member —
  otherwise a gate's spawn-fix could resurrect a run the operator cancelled. (`onTaskDone`
  still *receives* cancelled items — the contract stays uniform; the curated policies ignore
  them.)
- **SoC: the scan is a pure helper, the orchestrator applies.** `patterns/scan.ts` exports
  `collectSpawns(items: ItemState[], pattern: Pattern) → Array<{ runId, causeItemId, items:
  WorkItem[] }>` (pure — mirrors `computeNewlyReady`/`selectRunnable`); `orchestrator.tick()`
  maps the directives through `extendRun`. Keeps the tick wrapper an applier, per the repo's
  engine idiom.

## 5. extendRun — the audited append seam

```typescript
// orchestrator.ts — internal; the pattern layer is the sole v1 caller
private extendRun(runId: string, items: WorkItem[], actor: string): string[]  // appended ids
```

Semantics, in order:

1. **Idempotency by id-skip** (the cron-dedup posture, item-granular): drop any item whose
   namespaced id already exists in the store. All dropped → no-op, no audit entry. This is what
   makes `onTaskDone` replay-safe.
2. **Normalize + validate the merged graph**: `normalizeRun` over the new items (auto-union
   `needs[*].from` into `depends_on`, exactly as at submit), then `validateRun` over existing
   items (as immutable facts) ∪ new items. New items may `depends_on`/`needs` existing items
   **including `done` ones** —
   resolve-at-fire reads their refs identically whether the consumer was submitted or spawned.
   Acyclicity is structural: existing items are never mutated, so new edges only point backward.
   Reject → the *spawn* fails (logged via `onError`-style best-effort, run unharmed), never a
   partial append. All-or-nothing.
3. **Namespace + save — reusing `store.saveRun` verbatim, zero `RunStateStore` change**: same
   `ns()` treatment as `submitRun`, then `store.saveRun({ id: runId, queue, items: newItemsOnly },
   'pattern:<queue>', now)`. `saveRun` is a plain transactional per-item INSERT
   (`runstate/sqlite.ts:102-115`) — appending only-new items to an existing run is already its
   semantics; existing rows are untouched. `items.id` is `TEXT PRIMARY KEY` on namespaced ids,
   so even a logic-bug double-insert hard-fails the transaction (all-or-nothing holds by
   schema, not just by code). New items start `pending`; zero-dep spawns ready on the next
   `computeNewlyReady` pass (`every` over `[]` is true — no trigger involvement).
4. **Audit**: append `'run.extended'` (new `AuditEntryKind` member — additive; `canonEntry`
   already serializes `kind` positionally): `{ kind: 'run.extended', runId, itemId: <cause
   item>, actor: 'pattern:<queue>', at }`. The *cause* — which completion triggered growth — is
   first-class evidence.
5. **Seal safety by ordering** (§3): all spawns apply before the seal block in the same tick.
6. **Runaway backstop**: `maxItemsPerRun` on `AgoraOrchestratorOptions` (default 1000);
   `extendRun` rejects past it. Pattern-level bounds (§6c `maxFixAttempts`) are the real guard;
   this is the engine-side fuse.

**Actor attribution.** Spawned items carry `actor: 'pattern:<queue>'` — honest attribution that
machine policy caused the growth. The original submitter remains on the run's original items and
its `run.submitted` entry. Chain of custody reads: human authorized the run → the
operator-declared pattern on the queue grew it → here is the validating `run.extended` entry
naming the cause item.

**Provenance closure extends to spawned graphs by construction**: spawned items append to the
same run, consume upstream refs via the same `needs` → resolve-at-fire path, and their
manifests/outputRefs land in the same per-run audit export — `checkHandoffClosure` does not
change by one line.

## 6. The three curated patterns (`patterns/`, one file each)

### The typed-product pathway a spawned item rides (unchanged handoff machinery)

```
 upstream item (done)                          spawned downstream item
 ┌──────────────────────┐                      ┌────────────────────────────────┐
 │ outputs/a.json ──────┼─ captureOutputs ──►  │ needs: { part-a: {from: up,    │  written by the
 │ outputs/b.json       │  outputRefs persisted│           select:{output,a}} } │  PATTERN at spawn
 └──────────────────────┘  (store, sealed in   └───────────────┬────────────────┘  time (concrete)
                            AuditItemOutcome)                  │ fire time
                                                               ▼
                                              resolveInputRefs (engine/needs-resolver, PURE)
                                                               │ inputs.inputRefs carrier
                                                               ▼
                                              worker: fetchVerified → overlay at inputs/part-a
                                                               │
                                                               ▼
                                              manifest.inputRefs sealed at fire
                                                               │
                                                               ▼
                            agora verify: checkHandoffClosure — every consumed ref ∈
                            products of COMPLETED items in the SAME run  ✓
```

The pattern's only contribution is the boxed `needs` block — it *writes wiring*, never moves
bytes. Everything below the line is the shipped Wave A–C machinery.

### 6a. `static-dag`

`plan` = identity; `onTaskDone` = null. Formalizes current behavior; an unbound queue behaves
identically. The explicit object exists so the curated set is uniform.

```
 submitted: A ──► B ──► D          nothing spawns; pattern is inert.
            └──► C ──┘             Unbound queue ≡ this.
```

### 6b. `pipeline`

`plan` auto-chains: any item with empty `depends_on` (except the first) gets
`depends_on: [previous item]` in submission order. `needs` stays explicit — typed-product wiring
cannot be guessed (which key, which selector). Carries the gate policy (§6c).

```
 submitted: [implement, review, package]      (array order, no depends_on)
                          │ plan()
                          ▼
            implement ──► review ──► package
                          (gate, subject: implement)
```

### 6c. Gating (pipeline policy) — circle-back via lineage respawn

Layering with the engine is clean and ordered: **engine retry/backoff** (attempts, same item)
handles transient failure first; **`computeSkipped`** cascades the dead branch; gating fires
only on *terminal* status and spawns **new** work. No interaction beyond ordering.

Gate config rides the gate item's inputs (the reserved-key convention):

```typescript
inputs.gate = {
  onRed: 'advance' | 'spawn-fix',   // default 'advance' (gate red = informational)
  subject: string,                  // itemId whose product is being gated (e.g. implement)
  fixTemplate?: { executor, inputs, subagentShape?, resourceLocks? },
  maxFixAttempts?: number,          // default 1
}
```

- A gate item signals red by **failing** (executor reports failed → engine retries → terminal
  failed → cascade skips downstream). A done-but-red-`verify` item (report-only Gap A signal)
  with `spawn-fix` triggers the same spawn, minus the cascade (its downstream proceeds — that is
  what report-only means; authors who want holding-back semantics make the gate fail).
- **`spawn-fix`** applies a substitution map over the failed lineage. Spawn
  `<gate>-fix-<n>` (from `fixTemplate`), then copies of the gate and each skipped descendant
  with ids suffixed `~<n+1>`, every copied `depends_on`/`needs.from` mapped through
  `S = { subject → fix, gate → gate~next, each skipped d → d~next }` (identity otherwise).
  Implemented as a shared pure helper `respawnLineage()` in `patterns/` — map-reduce can reuse
  it later for map remediation.
- **What the fix item consumes.** Its `needs` binds the subject's product (subject is `done`,
  so closure holds). The gate's findings `outputRefs` bind **only in the done-but-red case** —
  a *failed* gate has no `outputRefs` (`tick.ts` persists them on `done` only) and provenance
  closure only admits `done` producers; for failed gates the failure `reason` (ItemState.reason)
  is threaded into the fix's plain `inputs` as data, not as a ref.
- **Attempt numbering derives from the cause, never from counting.** The cause item's id
  carries its attempt (`review` = attempt 1, `review~2` = attempt 2): `onTaskDone(review
  failed)` spawns exactly `{review-fix-1, review~2, …}`; `onTaskDone(review~2 failed)` spawns
  exactly `{review-fix-2, review~3, …}`. Deterministic per cause → replay re-derives the same
  ids → id-skip. (Counting existing fix items would break idempotency: replay after `fix-1`
  exists would mint `fix-2`.)
- Bounded by `maxFixAttempts` (default 1): when the cause's attempt exceeds it, spawn nothing —
  the run settles failed. `maxItemsPerRun` is the engine-side fuse behind it.
- **Never from `cancelled`.** A cancelled cause, or any cancelled member in the lineage, means
  no respawn — operator cancel is intent to stop, and spawn-fix must not resurrect it (§4).

```
 BEFORE (tick N)                            AFTER pattern phase (same tick)
                                            S = { implement→review-fix-1,
 implement ──► review ──► package                 review→review~2, package→package~2 }
   done        FAILED      skipped
    │            │  (engine retry exhausted; implement   review-fix-1 ◄─ consumes implement's
    │            │   computeSkipped cascaded)   done ───► (fix)          patch; review's failure
    │            │                               │          │            reason rides fix inputs
    │            └── onTaskDone(review failed,   │          ▼
    │                gate: spawn-fix, subject:   │       review~2   ◄─ gates the FIX's product
    │                implement) ─────────────►   │          │          (needs remapped via S)
    │                                            │          ▼
    └─ original branch stays as history          │       package~2  ◄─ consumes fix's product
       (failed/skipped — auditable)              │
```

The failed branch is never mutated or deleted — it stays in the run as sealed history (`review`
failed, `package` skipped), and the audit export shows `run.extended` with `itemId: review` as
the cause. The graph only grows forward; "circle-back" is a *new* arc of items, not a cycle.

### 6d. `map-reduce`

The splitter item carries config under a reserved inputs key (the established
`inputs.{subagent, env, workerInput, inputRefs}` convention — zero contract/persistence change,
replay-safe because `inputs` is already persisted and immutable):

```typescript
inputs.mapReduce = {
  map:    { executor, inputs, subagentShape?,
            needsKey?,      // input key each map's needs binding uses; default 'input'
            outputPath? },  // outputs/ path each map writes its product to; default 'result'
  reduce: { executor, inputs, subagentShape?,
            keyPrefix? },   // reduce needs-key prefix; default 'part'
}
```

- `plan()` validates the config shape (fail-fast at submit), passes the run through.
- `onTaskDone(splitter done)` → spawn one map item per `splitter.outputRefs` entry: id
  **`map-<outputKey>`** (deterministic from the product key),
  `needs: { [needsKey]: { from: splitter, select: { kind: 'output', path: key } } }`.
- `onTaskDone(any map terminal)` → if **all** `map-*` items are `done` and `reduce` does not
  exist → spawn `reduce` with concrete `needs: { '<keyPrefix>-<key>': { from: 'map-<key>',
  select: { kind: 'output', path: map.outputPath } } }` over all maps (the map template's
  `outputPath` is the contract for what each map produces). If any map terminally failed: no
  reduce spawn — the run settles red and the failed map's status tells the story (v1 policy;
  partial-tolerance config is demand-pulled).
- Everything is derived from `ctx.runItems` by id convention — no pattern state anywhere.

```
 submitted:            after splitter done:           after last map done:
 ┌──────────┐          onTaskDone spawns N            onTaskDone spawns reduce w/
 │ splitter │          (one per outputRefs key)       CONCRETE needs over N maps
 │ inputs.  │
 │ mapReduce│          splitter ──► map-a             splitter ──► map-a ──► reduce
 │ {map,    │                  ├──► map-b                     ├──► map-b ──►│
 │  reduce} │                  └──► map-c                     └──► map-c ──►┘
 └──────────┘                                         needs: { part-a:{from:map-a},
                        ids deterministic                      part-b:{from:map-b},
                        from product keys                      part-c:{from:map-c} }
                        → replay = id-skip no-op
```

**Spawn-time concretization is the answer to the N-unknown reduce problem.** The reduce node is
simply not submitted until N is known; when it is spawned, its `needs` are fully concrete. The
`needs` shape, `needs-resolver`, and `run-validator` are untouched — no collector selector
(`{kind: 'outputs-of'}`) is needed, in v1 or structurally. The same trick handles split-driven
fan-out: the pattern reads the splitter's `outputRefs` keys and spawns one item per ref.

## 7. Pattern state — none, by construction (replay/resume)

All pattern decisions are pure functions of `ctx.runItems` (ids, statuses, `outputRefs`,
reserved `inputs` keys — all already persisted by the single-writer store). Nothing new is
persisted; restart-then-tick re-derives everything; double-application is structurally
impossible (deterministic ids + id-skip + all-or-nothing extendRun).

```
 tick K:  review fails ──► onTaskDone ──► extendRun spawns {review-fix-1, review~2, package~2}
                                                │
          ✗ CRASH anywhere here ────────────────┤
                                                ▼
 restart, tick K+1:  pattern phase re-scans unsealed run
                     → onTaskDone(review) fires AGAIN (at-least-once)
                     → same deterministic ids → extendRun id-skip → no-op  ✓
                     → partially-applied spawn? impossible — extendRun appends
                       all-or-nothing after merged-graph validation
```

## 8. Audit — what changes, what is proven

- **`AuditEntryKind` gains `'run.extended'`** (additive — `canonEntry` serializes positionally;
  existing chains untouched). Entry shape: `{ kind, runId, itemId: <cause>, actor:
  'pattern:<queue>', at }`.
- **No manifest change.** Spawned items fire through the unchanged executor path; their
  `inputRefs` seal in the fire-time `DispatchManifest`, their `outputRefs` land in
  `AuditItemOutcome` — exactly as for submitted items.
- **Provenance closure over dynamic graphs** is the headline guarantee: because spawn appends to
  the same run through the same `needs` machinery, `agora verify`'s `checkHandoffClosure` proves
  every byte a spawned consumer saw was produced by a verified completed item in the same sealed
  run — zero new verification code.
- The seal still fires exactly once per run, when all items (original + spawned) are terminal.

## 9. Scope — v1 vs deferred

**In v1**

- `contracts/pattern.ts` (`Pattern`, `SpawnDirective`, `PatternContext`).
- `patterns/{static-dag,pipeline,map-reduce,respawn,scan}.ts` (respawn = the shared
  `respawnLineage()` pure helper; scan = the pure `collectSpawns()` the orchestrator applies).
- `QueueConfig.pattern?`; `plan()` invocation in `submitRun`; the pattern phase + `extendRun` +
  `maxItemsPerRun` in `orchestrator.ts`; `'run.extended'` audit kind.
- `examples/pattern-mapreduce` — fake splitter writes N `outputs/` files (N decided by the fake
  at runtime, unknown at submit) → N spawned maps → reduce concatenates via `inputs/` overlay.
  Run ends with a passing provenance-closure `agora verify`.
- `examples/pattern-dogfood` — a 3-node DAG-plan excerpt (`implement → review(gate) → package`)
  on the pipeline pattern. The fake executor keys red/green off item id (`review` → red,
  `review~2` → green — fully deterministic, no state). Demonstrates terminal-fail → cascade →
  spawn-fix → lineage respawn → green re-gate → `package~2` delivered; the original failed
  branch stays as sealed history.
- Integration tests mirroring the handoff integration test (offline, fake executors).

**Tests**

- Per-pattern unit tests over the pure hooks (plan expansion, spawn decisions, id determinism).
- `extendRun`: id-skip idempotency; merged-graph validation rejection (cycle attempt, unknown
  ref, duplicate id); audit entry emission; `maxItemsPerRun` backstop; all-or-nothing on
  rejection.
- Seal-ordering: a run that spawns in tick N does not seal in tick N; seals when the spawned
  items go terminal.
- Provenance closure over a spawned graph: `verifyBundle` green on the mapreduce example.
- Crash-replay: simulate restart between completion and spawn → re-tick → zero duplicate
  spawns, identical final graph.

**Deferred (demand-pulled)**

- External extend submissions (an `extend` kind on `SubmissionEnvelope` + inbox handling +
  the operator-append race story).
- User-defined patterns (the pluggable seam exists; curation discipline per the locked decision).
- Collector/`outputs-of` selectors — spawn-time concretization made them structurally
  unnecessary **for spawnable consumers** (reduce-style: don't submit until N is known). One
  adjacent case remains genuinely deferred-not-unnecessary: a PRE-SUBMITTED item whose source
  varies at runtime (e.g. consume fast-path's product, else fallback's). The secure shape, if
  a use case pulls it, is a richer DECLARATIVE selector (`oneOf` alternatives resolved by the
  same pure resolve-at-fire, chosen ref sealed in the manifest as today — never mutation of
  pending items), and the real cost is OR-readiness semantics in the engine
  (`computeNewlyReady` + skip cascade) — a separate design pass that must wait for a concrete
  consumer to define its give-up policy.
- Map partial-tolerance config (`minSuccess`, reduce-over-survivors).
- Cross-run provenance; pattern-config persistence beyond reserved `inputs` keys; high-water-mark
  optimization for the at-least-once scan.

## 10. Conformance to repo patterns & engineering principles

| Concern | Repo pattern followed | Where |
|---|---|---|
| Policy seam contract | `Trigger` (contracts/trigger.ts) — small policy interface, impls in own dir | `contracts/pattern.ts`, `patterns/` |
| Engine SoC | `tick` orchestrates; pure IO-free decision helpers; **engine untouched here** | pattern hooks + `collectSpawns` pure; orchestrator applies |
| Store interface stability | `saveRun` is a plain transactional INSERT; `items.id` PK enforces all-or-nothing | extendRun reuses `store.saveRun` — zero `RunStateStore` change |
| Idempotency | cron's deterministic-id → free-dedup posture | deterministic spawn ids + id-skip |
| Validation | One pure validator, N callers (was 2: submit + CLI; now 3: + extendRun) | `validateRun` over merged graph |
| Audit additivity | `canonEntry` positional fields; additive optional fields hash-safe | `'run.extended'` kind |
| Reserved inputs keys | `inputs.{subagent, env, workerInput, inputRefs}` | `inputs.mapReduce`, `inputs.gate` |
| Namespacing | `${runId}\x1f${id}` at ingestion | extendRun reuses `ns()` |
| Offline demo | `examples/handoff-dag` + handoff integration test | the two pattern examples |

**SoC summary:** pattern decision (pure, `patterns/`) ≠ application (`orchestrator.ts`:
extendRun + pattern phase) ≠ execution (unchanged) ≠ persistence (unchanged store interface) ≠
validation (`validateRun`, shared) ≠ seal (unchanged, ordering-protected). Each addition lands
in exactly one place.

## 11. Risks / open notes

- **The at-least-once scan is O(terminal items × ticks until seal).** Pure in-memory lookups; at
  v1 scale (tens-to-hundreds of items, 2s ticks) this is negligible. If a long-running run with
  thousands of items pulls it, a per-process high-water mark is a drop-in optimization (the
  contract is already at-least-once, so memoization cannot change semantics).
- **`respawnLineage`'s substitution map** assumes the skipped lineage is a closed set under the
  cascade (it is: `computeSkipped` cascades transitively across ticks; the pattern phase sees
  the settled state because gating only fires on terminal items whose downstream cascade has
  settled — worst case the respawn happens one tick later, which is correct since `onTaskDone`
  re-fires every tick). Tests must cover a diamond-shaped downstream.
- **Gate semantics for done-but-red** (`verify` red, status done) deliberately do NOT hold back
  downstream — report-only is the shipped Gap A contract. Authors wanting blocking gates make
  the gate item fail. This is documented behavior, not a gap.
- **`inputs.gate` / `inputs.mapReduce` are conventions, not schema** — a typo fails at `plan()`
  validation (fail-fast at submit), but the keys are stringly. Acceptable for a curated set;
  revisit if user-defined patterns land.
- **Whole bet is live-dogfood-unvalidated** — offline fakes prove the machinery; the first real
  DAG-plan-on-agora run (with live workers) is the actual validation, consistent with the
  medium confidence on the parent decisions.

## Amendment (2026-06-06): red gates block dependents

The engine gains one scoped gate-aware predicate, pulled by the first live gated run (`examples/dogfood-gated`, run 3). In `engine/dep-resolver.ts`, `computeNewlyReady` and `computeSkipped` now treat a dependency as **failed-like** (blocks readiness; cascades skip) when the item is `done` AND `verify?.passed === false` AND declares `inputs.gate.onRed === 'spawn-fix'`. This change was necessary because the original spec omitted gating semantics for the done-but-red case: without this predicate, a red gate item satisfied readiness (its status is done), so downstream items fired against unreviewed work in the same tick; the pattern phase ran after, so the respawned skipped descendants were unreachable, making findings-by-provenance and the downstream skip-and-remap mutually exclusive. The offline demo masked this by using a *failed* gate, which loses the `outputRefs.findings` sentinel entirely. **Scope:** the predicate applies only to items declaring `inputs.gate.onRed === 'spawn-fix'` — red verify on every other item remains report-only, unchanged. The global "verify is report-only" contract holds everywhere outside of declared gates. See [dogfood run-3 design](./2026-06-06-dogfood-run3-gated-circleback-design.md) §7 for the driving design and full motivation.
