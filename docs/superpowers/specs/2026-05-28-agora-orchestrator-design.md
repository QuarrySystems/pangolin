---
title: Agora Orchestrator — Architecture & Trunk Spec
date: 2026-05-28
status: design (approved direction; trunk pending implementation plan)
branch: docs/orchestrator-spec
authors: [human:Brett, agent:claude-opus-4-8]
supersedes: design note "Agora Architecture — Full Spec for Consideration" (v2)
---

# Agora Orchestrator — Architecture & Trunk Spec

> **Status:** design note. Approved direction; not yet implemented.
> **Trunk** = overnight dev offload (*agora-offload*). This spec captures the
> architecture the trunk should grow into. Build the mechanism; let contents be
> pulled by real tasks. Trap-check at §11.

This document is the consolidated, internally-reconciled version of the v2
architecture note. The architecture body (§0–§12) is preserved as authored; a
**Decision Ledger** records the implementation decisions locked during the
2026-05-28 brainstorming session, and inline **Resolved (Dn)** notes mark where
those decisions sharpen something the original note left open.

---

## Decision Ledger (locked 2026-05-28)

These are the implementation decisions made on top of the architecture. They are
binding for the trunk build. Where a decision resolves something the body text
floats as "likely" or "open", the body carries an inline **Resolved (Dn)** note.

| # | Decision | Resolution |
|---|---|---|
| **D1** | Overall shape | **Approach C** — four independent registries (packs, executors, triggers, interpreters) sharing ONE effect-tier vocabulary, over a small orchestrator core, interoperating through shared narrow-waist core types. |
| **D2** | Run-state store | **SQLite, split-store.** Mutable run-state (queues, item status, claims, resource locks, retry/cost counters) lives in SQLite. Work *products* (patches, dispatch envelopes, audit traces, intent payloads) stay content-addressed in agora storage, joined by a `result_ref` URI on the run-state row. Behind a `RunStateStore` seam so it is swappable. |
| **D3** | Deployment model | Orchestrator is a **long-running remote container service** and the **single, exclusive owner** of its run-state DB. CLI/MCP are *clients*; they never open the DB. (This is what makes single-file SQLite safe: one writer. >1 replica is a branch that would graduate to a networked DB.) |
| **D4** | DB location | The orchestrator's **own persistent volume** — EFS/EBS on a remote (Fargate) deploy; a named Docker volume for the all-local dev stack. **Not** `~/.agora`, **not** S3. `~/.agora` retains its meaning only as the *local dev stack's* storage root. |
| **D5** | Submission/query transport | **S3 inbox/outbox (poll)** behind a `SubmissionTransport` seam. Clients write a Run spec to an S3 `submissions/` prefix; the orchestrator polls, ingests, runs, and publishes status + completion records to the outbox. **No inbound networking to the container** (there is no Stoa/CF tunnel to lean on today). An HTTP transport is an additive seam impl, deferred until an ingress exists. |
| **D6** | Execution model | **Tick-based fire-and-reconcile.** `agora-client.dispatch()` blocks on `awaitExit()` today — fatal for an overnight queue. The orchestrator must NOT loop over blocking dispatch. Each tick: advance ready items, fire dispatches *without blocking*, record each `dispatch_hash`, and reconcile completed dispatches from their records on later ticks. Crash-safe by construction; mirrors the DAG executor's controller-turn loop. |
| **D7** | Worker output channel | **New `.agora/output.json` sentinel**, schema-validated against `subagentShape.outputSchema`, carrying typed `output` + `intents` + `signals`. Mirrors the existing `.agora/needs_input.json` sentinel. This is the one net-new *worker* mechanism the trunk requires — it is what makes `dev.code-edit → Patch` and `dev.open-pr → Intent` work. |
| **D8** | Registry model | **Static construction-time maps**, not a dynamic `.register()` registry. The four registries (packs/executors/triggers/interpreters) are `Record<string, Impl>` injected into the `AgoraOrchestrator` constructor and resolved from `agora.config.mjs`, validated fail-fast — identical to how `compute`/`credentials`/`targets` work on `AgoraClient` today (`client.ts:86-99`). No runtime registration API; "duplicate-id rejection" becomes construction-time validation. Aligns with the `agora-inline-secret` constructor-hook follow-up. |
| **D9** | dispatch-executor reuse | **Split `AgoraClient.dispatch` into internal `fire()` + `reconcile()`.** Existing blocking `dispatch()` becomes `fire()` → `awaitExit()` → `reconcile()`. The `dispatch-executor` *composes* `fire()` + later `reconcile()` (per D6); all ref-resolution / secret-staging / record-writing stays in `agora-client`, not duplicated. This is a real, called-out change to existing `agora-client` code. |
| **D10** | SubmissionTransport | **Thin layer over the existing `StorageProvider` seam**, not a parallel storage stack. Inbox/outbox = a prefix convention (`submissions/`, `outbox/`) + a poll helper on `agora-storage-s3`/`agora-storage-local`. Local dev and remote S3 both work with zero new storage code. (A distinct HTTP transport remains an additive seam impl, D5.) |
| **D11** | Contracts home | Orchestrator seams + shared types live **in the new `agora-orchestrator` package** (`src/contracts/`), not in `agora-core`. Keeps `agora-core` minimal — low-level providers/worker stay ignorant of orchestration. Mirrors how `agora-secret-store` holds its own interface. |

**Reserved for Mneme** (see §2): the `Claim` core type is *not* built in the
trunk. When a second consumer eventually pulls it into the core (most likely a
research/knowledge pack), its shape MUST be sourced from / aligned with
**Mneme**'s claim model — a typed assertion with evidence pointers + confidence
(Mneme spec v0.2 §2) — rather than agora inventing a divergent claim type. Mneme
lives at `C:/Users/brett/source/repos/My_Projects/Mneme`.

**Still genuinely open** (do not block trunk; §12): pre-dispatch snapshot stage
location, package seam for the `dev` pack, per-type semver policy, and the
Signal/Intent/Output sharpening.

---

## 0. Framing

Agora has a general core and opinionated layers on top. The core is
domain-neutral substrate: content-addressable dispatch, hibernating isolation,
the deploy-time / run-time security split, audit-grade provenance. The opinions
live in registered contributions — packs, executors, triggers, interpreters —
that the core orchestrates without knowing what they mean.

This spec defines the architecture in twelve sections:

1. Effect tiers (shared vocabulary)
2. Shared core types (the narrow waist)
3. SubagentShape (packs contribute)
4. Executor (runtime contract)
5. Trigger (scheduling policy)
6. WorkItem (the assembled unit)
7. Orchestrator core (queues, deps, locks, run-state)
8. IntentInterpreter (privileged write-side execution)
9. How the pieces compose
10. Operator surface (CLI + MCP) — consolidated logic, thin surfaces
11. Trap check — what to actually build
12. Open questions worth pinning
13. Package layout & convention conformance

Effect tiers (§1) are both their own section and a property on §3/§4/§8. Counted
once because it's one vocabulary.

The load-bearing observation: **packs, executors, triggers, and interpreters are
four independent registries that share ONE effect-tier vocabulary**. That
vocabulary is how one policy engine reasons across all of them without special
cases.

---

## 1. Effect tiers — the shared spine

Every primitive that produces or consumes side effects declares an effect tier.
Three classes:

- **pure** — compute only. No network, no external writes, no live state. Same
  inputs → same outputs. Fully cacheable, replayable, parallelizable.
- **read-impure** — needs live external state. Handled by snapshotting the read
  into the context bundle BEFORE dispatch, via a privileged pre-step. Worker
  sees a frozen, content-addressed snapshot. Never holds live credentials.
- **write-impure** — produces external side effects. Worker emits a structured
  `Intent` in its output; a registered IntentInterpreter realizes it under
  declared policy. Outbox pattern. Worker never performs the effect directly.

Determinism guarantee: **deterministic except where a capability declares
impurity.** CI-checkable. Honest.

MCP placement:
- read-only MCP → read-impure (pre-dispatch snapshot)
- write MCP → write-impure (outbox + interpreter)
- genuinely interactive live MCP → explicit impure capability, excluded from
  cache, audit log records "live egress, outputs not reproducible," per-dispatch
  TTL'd scoped creds.

Effect tier lives on SubagentShape, Executor, and IntentInterpreter. The
orchestrator's policy engine reads it from all three to decide what's cacheable,
what needs snapshotting, what gets gated.

---

## 2. Shared core types — the narrow waist

A small, versioned vocabulary of pack-neutral types. Packs interop THROUGH
these. Get the shape of these right and composition is free; get them wrong and
you'll be writing N² adapters.

Starter set (extend on demand, never speculatively):

```
Patch       — a unified diff against a declared base commit hash
Document    — a content-addressed text blob with provenance metadata
Claim       — a typed assertion with evidence pointers + confidence
FileRef     — a content-addressed reference to a file in vault/storage
Intent      — a structured proposal for a side effect; kind + payload
```

Versioned independently of the packs that use them. Mismatch fails at
registration or dispatch boundary, never silently at 3am.

Rule: a type enters the core only when a SECOND consumer needs it. Adapter
sub-agents are the escape hatch when two packs don't share a type; don't
preemptively unify.

> **Resolved (Mneme reservation).** Of the starter set, the trunk builds only
> `Patch` and `Intent` (§11). `Claim` is **reserved for Mneme integration**:
> Mneme is a confidence-weighted claims library (typed assertions + evidence +
> confidence, with a query algebra and contradiction clustering). When a second
> consumer pulls `Claim` into agora's core, its shape MUST align with Mneme's
> claim model — agora must not fork a divergent claim type. `Document`,
> `FileRef` likewise wait for a second consumer.

---

## 3. SubagentShape — what work can be done (packs contribute)

A pack is a registry contribution that declares typed sub-agent shapes. Packs
don't run anything; they describe what *can* run.

```
SubagentShape {
  id            : "<pack>.<name>"   // dev.code-edit, research.gather
  effectTier    : pure | read-impure | write-impure
  inputSchema   : typed schema (Zod/JSON Schema), validated at boundary
  outputSchema  : typed schema, validated before return
  capability    : {
    imageDigest : pinned container image
    permissions : capability-scoped IAM/secrets policy
    contextShape: declarative description of what context the capability
                  stages on activation (e.g. "PR diff + review history")
  }
}
```

Two fields make packs interoperate: `effectTier` (policy engine reads it) and
`outputSchema` referencing shared core types (handoff between packs).

Failure modes guarded against:
- ID collision → pack-prefixed IDs from day one; **construction-time validation**
  rejects duplicates (D8 — static maps, not a dynamic registry).
- Schema drift → version core types independently; boundary validation fails
  fast.

Sub-agents propose intents and transform them; they NEVER realize them. Only
interpreters realize.

> **Resolved (D7).** `outputSchema` is enforced via the new `.agora/output.json`
> worker sentinel: the worker writes its typed output + intents + signals to
> that file; the orchestrator reads and validates it against this shape before
> recording the result. Mirrors `.agora/needs_input.json`.

---

## 4. Executor — how work gets carried out (runtime contract)

Mirrors the existing RuntimeAdapter pattern, one level up. The orchestrator
picks an executor per work item; the executor knows how to run things, not what
they mean.

```
Executor {
  id          : "dispatch" | "shell" | "batch-api" | "dag-plan" | ...
  effectTier  : the floor — the most permissive tier this executor
                supports. (shell-executor on your laptop is at least
                write-impure; dispatch-executor can host any tier.)
  run(item, ctx) → ExecutionResult
}
```

Initial executors worth conceiving (build only `dispatch` first):

- **dispatch-executor** — the Agora dispatch primitive. Hibernating isolation,
  content-addressable, audit-graded. Default executor; everything else is an
  optimization.
- **shell-executor** — runs a command on the host, captures exit/output. Cheap.
  Only for pure or already-trusted work. No isolation; clearly marked
  write-impure floor.
- **batch-api-executor** — async, latency-tolerant, ~1/10 the cost of dispatch.
  For high-volume pure work where wall-clock doesn't matter.
- **dag-plan-executor** — runs a sub-DAG inside a single dispatch or via a
  controller session. Recursive composition; defer until needed.

**Critical discipline:** executors are MECHANISM only. Do not bake pack-specific
logic ("emit a patch, base commit in input") into the dispatch-executor. That
logic belongs in the dev pack's sub-agent shape. Executors stay agnostic to what
the worker's output means.

> **Resolved (D6).** The trunk's `dispatch-executor` is **fire-and-reconcile**,
> not blocking. `run()` fires the dispatch and returns an in-flight handle
> (`dispatch_hash`); the orchestrator core reconciles completion from the
> dispatch record on a later tick. It must NOT call the blocking
> `client.awaitExit()` path inline.

---

## 5. Trigger — when work becomes ready (scheduling policy)

The third axis. Anything that takes a work item from "defined" to "ready for the
queue" is a trigger. Typed contract, registry, same shape as packs and
executors.

```
Trigger {
  id      : "cron" | "event" | "dep-satisfied" | "manual" | ...
  kind    : how the trigger fires
  config  : trigger-specific (cron expression, event source, predicate)
  fires() → emits a ready WorkItem (or readies an existing one)
}
```

Initial triggers worth conceiving:

- **manual** — user runs it. Trivial. Build first.
- **cron** — scheduled. Required for overnight runs. Build second.
- **dep-satisfied** — fires when DAG predecessors complete. Internal; the
  orchestrator owns it. Required for any multi-task plan.
- **event** — webhook, file watch, channel post. Build when a real use case
  demands it.
- **conditional / predicate** — fires when a deterministic predicate over
  run-state holds. Powerful, defer until pulled.
- **signal-fired** — another work item's structured signal output triggers this
  one. The bounded-reactive-workflow pattern. Defer.

Triggers are first-class so future scheduling logic doesn't require orchestrator
refactors. Keep the contract minimal; register concrete instances on demand.

---

## 6. WorkItem — the assembled unit

The primitive the orchestrator actually queues. Combines all three axes plus
run-time policy.

```
WorkItem {
  id              : stable identifier
  subagentShape   : id of the registered shape (what)
  executor        : id of the registered executor (how)
  trigger         : id of the registered trigger (when)

  inputs          : conforms to subagentShape.inputSchema
  depends_on      : [WorkItem.id]   // DAG edges
  resourceLocks   : [string]        // shared resource keys

  effectPolicy    : per-tier policy overrides for this item
    {
      readImpure  : snapshot strategy
      writeImpure : intent policy (auto | human-approve | conditional)
    }

  budget          : { perDispatch: $X, total: $Y }
  baseCommit?     : hash, when the sub-agent emits a Patch
}
```

Result on completion:

```
WorkItemResult {
  itemId            : ...
  dispatchHash      : content-address of the full execution envelope
  status            : done | needs_input | needs_context | failed | skipped
  output            : conforms to subagentShape.outputSchema
  intents           : [Intent]    // proposed, not yet realized
  signals?          : [Signal]    // structured outputs that may
                                  // trigger further work items
  audit             : trace + cost + duration
}
```

Notes:
- `dispatchHash` covers (subagentShape + inputs + capability digest + baseCommit
  + relevant context bundle hash). This is what makes caching, replay, and audit
  work.
- `needs_input` / `needs_context` are NON-BLOCKING under overnight policy: log to
  journal, mark skipped, continue the DAG.
- A failed item never kills the plan. Isolation is by construction.

> **Resolved (D7).** `WorkItemResult` is materialized from the worker's
> `.agora/output.json` (output/intents/signals) plus the dispatch record's
> terminal lifecycle event (status/audit). The run-state row stores `itemId`,
> `status`, `dispatchHash`, and a `result_ref` URI pointing at the
> content-addressed envelope in agora storage (D2 split-store); `output`,
> `intents`, `signals`, and `audit` live in that envelope, not in SQLite.

---

## 7. Orchestrator core — queues, deps, locks, scheduling, run-state

The genuinely hard part. Build this once, well.

Responsibilities:

- **Named persistent queues.** WorkItems live in queues with declared
  concurrency limits. Crash-safe persistence.
- **Dependency resolution.** Topological execution of `depends_on`. Re-dispatch
  on `needs_context` against updated base.
- **Resource locks.** Shared resource keys (file paths, external systems)
  serialize work items that contend.
- **Scheduling.** Honors registered triggers; readies items when their trigger
  fires.
- **Run-state store.** Persistent record of every work item's status, dispatch
  hash, `result_ref`, and cost. **Resolved (D2/D3/D4):** SQLite, split-store,
  on the orchestrator service's own persistent volume (EFS/EBS remote; named
  Docker volume for the local dev stack). The orchestrator is the single
  exclusive writer (D3), which is what makes single-file SQLite safe. Work
  products stay content-addressed in agora storage, joined by `result_ref`. The
  store sits behind a `RunStateStore` seam so it is swappable. *(This replaces
  the original note's "SQLite in the vault, likely default, confirm later.")*
- **Submission transport.** **Resolved (D5):** an S3 inbox/outbox behind a
  `SubmissionTransport` seam. The core polls the inbox for new Runs and
  publishes status + completion to the outbox. No inbound networking required.
- **Effect-tier policy engine.** Reads the tier on each work item's shape and
  executor; caches pure results, invokes the read-impure snapshot step, routes
  write-impure intents to interpreters under declared policy.
- **Execution model.** **Resolved (D6):** tick-based fire-and-reconcile. A tick
  advances ready items, fires dispatches without blocking, records each
  `dispatch_hash`, and reconciles completed dispatches from their records on
  later ticks.
- **Crash recovery.** On restart, resume from run-state. In-flight dispatches
  reconcile via `dispatch_hash` (already content-addressable).
- **Cost accounting.** Per-item budget enforcement; whole-run cap halts the
  queue.

What the orchestrator does NOT do:
- Decide what work means (packs do).
- Decide how to run it (executors do).
- Decide when to fire (triggers do).
- Decide whether to realize an effect (interpreters do, under policy).

The orchestrator is a router and a scheduler with a policy engine. It should be
small. Most lines of code in the system live in packs, executors, and
interpreters — not here.

---

## 8. IntentInterpreter — privileged write-side execution

The missing half of the write-impure outbox, made first-class. Sub-agents
PROPOSE intents in their output; interpreters REALIZE them.

**Adapter vs. interpreter — keep distinct:**

- **Intent adapter** — TRANSFORMS one intent into another or into a shared core
  type. Pure, deterministic, run-time, no special trust. Just a pure sub-agent.
- **Intent interpreter** — EXECUTES, crosses the boundary, causes the side
  effect. Privileged. Lives on the deploy-time side. Registered by humans / CI,
  never by run-time code.

```
IntentInterpreter {
  intentKind  : "dev.open-pr" | "notify.slack" | "data.write-row" | ...
  effectTier  : write-impure (by definition)
  policy      : auto | human-approve | conditional(predicate)
  handler     : privileged code that performs the effect
  audit       : what gets logged when it fires
}
```

**Policy tiers — declared rule, never model judgment:**

- **auto** — fire immediately. Low-stakes (journal entry, dev channel post).
- **human-approve** — queue, surface in morning review, fires on explicit
  approval. Overnight default for anything touching prod or external parties.
- **conditional(predicate)** — fire automatically IF a deterministic predicate
  holds (amount < $X, target is test repo, dry-run set), else escalate to
  human-approve. The reason overnight runs can be useful: realize safe intents,
  park risky ones, all by rule.

**Fail-closed:** unregistered intent kind = parked + logged, NEVER executed. A
worker cannot emit `Intent<delete-prod-db>` and have it run, because no
interpreter is registered to realize it.

**Full write-side pipeline:**

```
worker proposes Intent  (run-time, untrusted)
    ↓
optional pure adapter normalizes  (run-time)
    ↓
registered interpreter realizes under declared policy
    (deploy-time, privileged)
    ↓
audit log records intent + policy decision + effect
```

**Hard no:** model-mediated interpretation. Interpreters are dumb, declared,
privileged handlers with deterministic gates. All intelligence lives in the
worker that PROPOSES the intent.

---

## 9. How the pieces compose

A work item flows through the system like this:

```
trigger fires
    → orchestrator readies WorkItem in its queue
    → deps resolved + resource locks acquired
    → policy engine inspects subagentShape.effectTier
        if read-impure: privileged pre-step snapshots reads into
                        context bundle
    → executor.run(item, ctx)            // D6: fires, does not block
        → worker executes against frozen context bundle
        → worker writes .agora/output.json conforming to outputSchema   // D7
        → output may include: data (Patch/Document/Claim/...)
                              intents (proposed effects)
                              signals (may trigger more items)
    → [later tick] orchestrator reconciles dispatch; validates output
      schema; records dispatchHash + result_ref
    → for each Intent in output:
        registered IntentInterpreter realizes under policy
        (auto fires now; human-approve queues; conditional checks predicate)
    → for each Signal in output:
        signal-fired triggers may ready new WorkItems
    → run-state updated; downstream deps unlocked
```

Two registries (packs, executors) and two more (triggers, interpreters) plug
into one core. One effect-tier vocabulary lets the policy engine reason across
all of them. Cross-pack handoff happens through shared core types. The whole
system is content-addressable end-to-end, so audit and replay are properties,
not features.

---

## 10. Operator surface — CLI, MCP, and the consolidation principle

### 10.1 Layering — dispatch stays a primitive

Even with the orchestrator in place, `agora dispatch` is unchanged. The
orchestrator doesn't absorb dispatch; it composes it. `dispatch-executor`
literally calls `client.dispatch()` under the hood.

```
 agora dispatch <subagent> ...   ← UNCHANGED. Synchronous, blocks till
                                   exit. The low-level primitive. Still
                                   useful on its own.
         ▲
         │ composed by
         │
 dispatch-executor               ← inside the orchestrator;
                                   fire-and-reconcile per D6.
         ▲
         │ chosen per WorkItem
         │
 agora orch ...                  ← NEW. Queue-aware, dep-aware,
                                   unattended-capable.
```

`dispatch` = "run this one thing now and wait."
`orch` = "queue these things, resolve their deps, run them unattended, reconcile
later."

### 10.2 Consolidation — one operations API, surfaces are nominal

**All business logic lives in the orchestrator core as a single operations API.**
Every surface — CLI, MCP, future HTTP — is a thin translator that maps its input
format to operations API calls. No business logic in any surface. No surface
knows about another surface.

```
                                  ┌───────────────────┐
 agora-cli  ── translates ─────► │                   │
                                  │   ORCHESTRATOR    │
 agora-mcp  ── translates ─────► │   OPERATIONS API  │ ← owns all logic
                                  │   (single source) │
 http-api   ── translates ─────► │                   │
 (future, D5 seam)                └───────────────────┘
```

What this buys you:
- Adding a new surface = define translation, done. Nominal effort.
- Bug in submit logic? Fix once, fixed everywhere.
- Logic + surface test independently. Surfaces test only translation.
- The privileged / run-time split (§10.6) lives on operations API methods,
  enforced once, not duplicated per surface.

Ports-and-adapters pattern, applied one level above the `SubmissionTransport`
seam (D5). Same discipline.

### 10.3 Conceptual model — Queue / Run / WorkItem

Three concepts, distinct, never conflated:

- **Queue** — long-lived named bucket with declared concurrency, rate limit, and
  pause state. Lives in run-state. Configure once, forget. The unit of
  "parallelism profile."
- **Run** — one plan submission. A set of WorkItems + their `depends_on` edges +
  a budget. Lives until terminal.
- **WorkItem** — a single dispatchable unit (defined in §6).

Relationships:
- A queue holds 0..N concurrent runs.
- A run holds 1..N work items with deps between them.
- Multiple runs in one queue share its concurrency budget.

**Worked example.** Queue `plan-a` (concurrency 5) holds run `plan-a-1` (15
items, 3 waves of 5 via deps + resource locks). Queue `plan-b` (concurrency 1)
holds run `plan-b-1` (15 items, serialized by file-level resource locks). Both
runs proceed concurrently because they're in different queues with independent
concurrency budgets.

Resource locks (declared on each WorkItem via `resourceLocks`) handle file-level
serialization *within* a queue. Disjoint locks fan out; overlapping locks
serialize. The dev pack's `code-edit` shapes declare locks via the files they
touch — the planner doesn't hand-DAG it.

### 10.4 CLI surface — `agora orch`

(Alias for `agora orchestrator`.)

| Command | Side | What it does |
| --- | --- | --- |
| `agora orch serve` | service | The long-running process itself. Owns SQLite run-state, polls S3 inbox, ticks the reconcile loop. Runs inside the deployed container. |
| `agora orch submit [--queue <name>] <plan.json>` | client | Writes a Run to the S3 submissions prefix. Returns a run id. Non-blocking. |
| `agora orch status [run-id]` | client | Renders queue / run / item tree from the outbox snapshot, with blocking-reason annotations ("waiting on dep X", "waiting on lock Y"). |
| `agora orch watch [run-id]` | client | Tail status changes, refreshed per tick. Critical for overnight check-ins. |
| `agora orch approve <intent-id>` | client, **privileged** | Flips a human-approve intent gate. Deploy-time action; CLI-only by design. |
| `agora orch cancel <run-id\|item-id>` | client, **privileged** | Stop a run or single item. CLI-only. |
| `agora orch queue list` | client | List configured queues + their state. |
| `agora orch queue config <name> [--concurrency N] [--rate-limit R]` | client, **privileged** | Create or update a named queue. |
| `agora orch queue pause/resume <name>` | client, **privileged** | Stop / resume firing new items in a queue. IN_FLIGHT items continue. |

Deployment reuses the existing `agora deploy` path — the orchestrator is just
another container image. No bespoke deploy verb needed.

**Status output shape** — the tree must show blocking reasons, not just
progress, so debugging at 8am is one command:

```
queue: plan-a            concurrency 5/5     2 runs
  run: plan-a-1          12/15 done · $4.20 / $20 budget
    ├── wave-1.task-3    IN_FLIGHT  (dispatch_hash abc123, 4m elapsed)
    ├── wave-2.task-1    READY      (waiting on lock: src/foo.ts)
    ├── wave-2.task-2    PENDING    (waiting on dep: wave-1.task-3)
    └── wave-3.task-4    DONE       (patch on branch agora/wave-3-task-4)
queue: plan-b            concurrency 1/1     1 run
  run: plan-b-1          7/15 done · $1.80 / $10 budget
    └── task-8           IN_FLIGHT  (dispatch_hash def456)
```

### 10.5 MCP surface — narrow by design

Only what a run-time agent legitimately needs to offload work and follow it:

| Tool | Side | Why exposed |
| --- | --- | --- |
| `agora_orchestrator_submit` | client | Lets a Claude Code session offload overnight work. |
| `agora_orchestrator_status` | client | Lets the same session check on its own submission. |
| `agora_orchestrator_watch` | client | Read-only wait-for-completion. Useful and safe. |

**Not on MCP:** `approve`, `cancel`, `queue config`, `pause`, `resume`, `serve`.
Deploy-time / privileged. A run-time agent must not be able to configure its own
queues, approve its own intents, or cancel another agent's work.

### 10.6 Privileged vs. run-time split — enforced at the operations API

Every operations API method carries a tag. Surfaces inherit it; they cannot
upgrade or override:

```
 operations API method        tag          CLI?   MCP?
 ─────────────────────────    ──────────   ────   ────
 submit_run                   client        Y      Y
 get_status                   client        Y      Y
 watch_run                    client        Y      Y
 approve_intent               privileged    Y      N
 cancel_run / cancel_item     privileged    Y      N
 configure_queue              privileged    Y      N
 pause_queue / resume_queue   privileged    Y      N
 serve                        service       Y      N   (not a tool)
```

**CI check**, mirroring agora's existing MCP tool-allowlist precedent (the
`agora-mcp` server already excludes deploy-time/privileged registration ops, and
`AGORA_CLAUDE_PERMISSION_MODE` gates worker tool access): enumerate registered
MCP tools, intersect with the privileged set, fail on non-empty. The MCP server,
when constructed, refuses to register any privileged or service method.

This is why "all logic consolidated" matters: the privilege tag lives on the
operations API method, in one place. You can't accidentally expose
`approve_intent` over MCP by writing a new MCP tool — there's no business logic
in MCP to expose, only translation, and the underlying method refuses to
register.

### 10.7 Operator surface trap-check

**Trunk (build now):** `serve`, `submit`, `status`, `watch`, `approve`,
`cancel`. The minimum to actually run the system unattended. MCP surface:
`submit`, `status`, `watch`.

**Trunk-mechanism (build the contract, register one):** queue concept as a typed
primitive in the operations API; ONE registered queue at launch (`default`) with
a sensible concurrency. The contract for named queues exists from day one so the
second queue is additive.

**Branches (let a real task pull):**
- Named queues beyond `default` — wait until you actually run two plans
  concurrently (the Plan A + Plan B scenario pulls this in honestly).
- Queue rate limiting — wait until an external rate limit forces it.
- `pause` / `resume` — wait until you need to stop a runaway run without killing
  it.
- Separate `logs` command — probably subsumed by `status --verbose`.
- HTTP surface — wait until an external system needs to submit programmatically.
  S3 + CLI is enough until then (D5 seam makes it additive).

**Honest version for your first overnight run:** `default` queue with
concurrency set sensibly, `submit` your plan, `watch` it, `approve` what comes
back in the morning. Five commands. Everything else arrives when a real task
pulls it.

---

## 11. Trap check — what to actually build

The above is the *design*. The build is much smaller.

**Build now (trunk — unblocks overnight dev offload):**
- Orchestrator core: persistent named queues, deps, resource locks, manual +
  cron triggers, crash-safe run-state (SQLite split-store on the service's
  persistent volume, per D2/D3/D4), tick-based fire-and-reconcile (D6),
  S3 inbox/outbox transport (D5), cost accounting, non-blocking on `needs_input`.
- One executor: `dispatch-executor` only (fire-and-reconcile, D6).
- Worker change: the `.agora/output.json` typed-output channel + schema
  validation (D7).
- One pack: `dev`, with the minimum sub-agent shapes the actual overnight
  workload needs (probably `dev.code-edit`, `dev.verify`).
- Core types: `Patch`, `Intent`, and only the others when a second consumer
  appears. (`Claim` reserved for Mneme.)
- One interpreter: `dev.open-pr`, gated under conditional policy (auto-merge
  test-only changes; human-approve everything else).
- Effect-tier vocabulary as the typed property on shape, executor, interpreter —
  but only the tiers actually used.
- Operator surface: `serve`, `submit`, `status`, `watch`, `approve`, `cancel` on
  CLI; `submit`, `status`, `watch` on MCP. See §10.7.

**Build the mechanism, not the contents (trunk-mechanism):**
- The registries themselves (packs, executors, triggers, interpreters) exist as
  typed contracts with one or two registered instances each.
- The `SubagentShape` / `Executor` / `Trigger` / `IntentInterpreter` interfaces
  are stable from day one so the second instance is additive, not a refactor.
- The `RunStateStore` and `SubmissionTransport` seams exist so SQLite→networked
  DB and S3→HTTP are additive swaps.
- The operations API exists as a single source of business logic; CLI and MCP
  are thin translators. New surfaces are nominal.
- The queue contract exists with one registered queue (`default`); named queues
  are additive.

**Branch — let a real task pull it (do not build speculatively):**
- Additional executors (shell, batch-api, dag-plan).
- Additional packs (research, data, canopy, support, compliance, ...).
- Predicate triggers, signal-fired triggers, event triggers beyond the minimum.
- Rich interpreter libraries for arbitrary external systems.
- Cross-pack adapters.
- Speculative pre-warming, best-of-N, verifier patterns, result cache. (All real
  ideas; all branches until a task demands one.)
- Named queues beyond `default`, queue rate-limiting, `pause`/`resume`, HTTP
  surface. See §10.7.
- The `Claim` core type + Mneme integration. See §2 / §12.

**The seductive failure mode** (worth naming explicitly because it WILL fire):
each of the branch items is individually justifiable — "we'll obviously want a
research pack," "we'll need predicate triggers for X," "the verifier pattern is
the differentiation." Every justification is real. The trap is that the sum of
justified branches is an unshipped platform. The rule: every branch waits until
a real task with a real deadline pulls it through. The architecture above
ensures none of them require a refactor when pulled. That's what the design BUYS
you. Don't spend the savings before you've earned them.

---

## 12. Open questions worth pinning

These don't block the build but they're the choices that age poorly if deferred
too long. Decide deliberately when each becomes relevant.

- **~~Run-state store.~~** **Resolved (D2/D3/D4):** SQLite, split-store, on the
  orchestrator service's own persistent volume. See the Decision Ledger.
- **Pre-dispatch snapshot step — orchestrator or new privileged stage in the
  dispatch lifecycle?** Affects where read-impure machinery lives and what the
  executor contract looks like. (Not exercised by the trunk, which is
  pure/write-impure; revisit when the first read-impure shape lands.)
- **Package seam between core and dev pack.** Sibling under the `@quarry-systems`
  scope (consistent with the existing monorepo) vs separate repo? Driven by how
  packs get distributed later.
- **Versioning policy for shared core types.** Independent semver per type,
  validated at boundary. Worth writing down before the second type appears.
- **Signal vs. Intent vs. Output distinction in `WorkItemResult`.** All three
  are structured worker outputs but mean different things: Intent = proposed
  effect (interpreter realizes), Signal = trigger fuel for other items, Output =
  data product. Sharpen before the signal-fired trigger gets built.
- **Mneme integration (deferred).** When `Claim` is pulled in, decide the
  integration seam: does agora depend on Mneme as a library, exchange `Claim`
  blobs through shared storage, or treat Mneme as a write-impure interpreter
  target (`Intent<mneme.assert>`)? See §2.

---

## 13. Package layout & convention conformance

This section audits the architecture against the agora monorepo's established
library-separation conventions and records the conformance decisions (D8–D11).
It is the bridge from "architecturally sound" to "fits how this repo is built."

### 13.1 The conventions (extracted from the current repo)

1. **Seams in a core, impls in siblings.** `agora-core` is interfaces + data
   types only, with **zero dependencies** (`package.json` deps `{}`). Impl
   packages (`agora-providers-*`, `agora-storage-*`, `agora-runtime-*`) depend
   *only* on `agora-core`. Dependency direction is strictly downhill.
2. **One authority, thin surfaces.** `AgoraClient` owns all dispatch logic;
   `agora-cli` (`cmd-*.ts`) and `agora-mcp` (`tools.ts`) are pure translation
   layers that delegate to it, with **no duplicated business logic**. The
   design's §10.2 "consolidation principle" is this existing pattern, named.
3. **Injection by static maps, not registries.** `compute`, `credentials`,
   `targets` are `Record<string, Impl>` passed to the `AgoraClient` constructor,
   validated fail-fast (`client.ts:86-99`), resolved by name lookup at dispatch
   (`dispatch.ts:112-128`). There is **no dynamic registry anywhere** in the repo.
4. **No database.** Storage is strictly content-addressed files behind
   `StorageProvider`. SQLite is net-new to the repo.
5. **Naming.** `agora-<role>-<impl>`; tests in a `test/` dir at package root;
   `vitest`; `tsconfig.json` extends `tsconfig.base.json`; scope
   `@quarry-systems/*`.

### 13.2 Conformance decisions

- **D8 — Static maps over dynamic registries.** The four registries are
  constructor-injected `Record<string, Impl>` maps resolved from
  `agora.config.mjs`, exactly mirroring `AgoraClient`'s `compute`/`credentials`/
  `targets`. No `.register()` API.
- **D9 — Reuse via `fire()`/`reconcile()` split in `AgoraClient`.** The blocking
  `dispatch()` is decomposed so the orchestrator composes the start and collect
  steps (D6) without duplicating ref-resolution / secret-staging / record-writing.
- **D10 — `SubmissionTransport` is a thin layer over `StorageProvider`.** Prefix
  convention + poll helper; no parallel storage stack.
- **D11 — Orchestrator contracts live in `agora-orchestrator`,** not `agora-core`
  (which stays the minimal base-substrate seam package).

### 13.3 Proposed package layout (trunk)

```
packages/
  agora-core                     unchanged — base substrate seams, zero deps
  agora-client                   + internal fire()/reconcile() split (D9)
  agora-orchestrator             NEW. Plays the core+authority role for this layer.
     src/contracts/              seams + shared types (D11): Executor, Trigger,
                                 IntentInterpreter, SubagentShape, RunStateStore,
                                 SubmissionTransport, WorkItem, WorkItemResult,
                                 Patch, Intent, effect-tier vocabulary
     src/orchestrator.ts         AgoraOrchestrator — the operations API (B2)
     src/engine/                 tick loop, dep resolver, lock manager, policy engine
     src/executors/dispatch.ts   dispatch-executor (composes client fire/reconcile, D9)
     src/runstate/sqlite.ts      RunStateStore impl (better-sqlite3, D2/D5/B5)
     src/transport/storage.ts    SubmissionTransport over StorageProvider (D10)
        deps: agora-core, agora-client, agora-storage-s3, agora-storage-local,
              better-sqlite3
  agora-pack-dev                 NEW. SubagentShapes (dev.code-edit, dev.verify)
                                 + the dev.open-pr IntentInterpreter.
        deps: agora-orchestrator (only)
  agora-cli                      + `orch` subcommands (thin, delegate to AgoraOrchestrator)
  agora-mcp                      + submit/status/watch tools (thin)
```

Dependency direction stays strictly downhill:
`agora-pack-dev → agora-orchestrator → agora-client → agora-core`.

### 13.4 SRP judgment call for the trunk

Keep `dispatch-executor`, the SQLite `RunStateStore`, and the storage-backed
`SubmissionTransport` **as internal modules inside `agora-orchestrator`** for the
trunk (one impl each → no premature package split). Extract to sibling packages
(`agora-orchestrator-executors-shell`, `agora-pack-research`, …) only when a
second impl is pulled — exactly the trap-check discipline of §11, and exactly how
`agora-storage-s3` sits beside `agora-storage-local` today.

### 13.5 `better-sqlite3` containment

SQLite is the first database in the repo. It is confined to
`agora-orchestrator/src/runstate/sqlite.ts` behind the `RunStateStore` seam;
nothing else in the repo gains a DB dependency. `better-sqlite3` (synchronous,
single-file) is already in use in the sibling **Mneme** project, so it is a known
quantity on this machine.

---

End of spec. Read once, sit with the trap-check (§11), then ship the trunk.
