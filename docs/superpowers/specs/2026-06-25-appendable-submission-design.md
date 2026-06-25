# Append-able submission (push-then-close) — design

**Date:** 2026-06-25
**Status:** approved (design) — pending implementation plan
**Scope:** `pangolin-orchestrator` — an opt-in `Run.openEnded` flag; an `extend` verb on a NEW optional `AppendChannel` (data plane) + a `close` variant on the existing `ControlChannel` (control plane); a new `producerExtend` orchestrator method (the guarded producer push) that delegates to the **unchanged** internal `extendRun`; run-level open/closed flags on `RunStateStore` (optional); an opt-in seal-gate. Patterned open-ended runs route pushed items through the existing `onTaskDone` path — **no `Pattern` change**. Plus a runnable `examples/appendable-stream` proof. The only `pangolin-core` change is an additive `'run.closed'` `AuditEntryKind`. **No** worker-image change, **no** audit-bundle/format change.

> The **"prove the shape end-to-end" proof** for append-able submission: an external producer pushes work items into an already-running, durable, audited run over time, sends an explicit `close` (epoch boundary), and the run seals once over the grown graph. Append-able is **opt-in** and composes with execution patterns. The epoch-window chain (true continuous sealing) and pattern *templating* of pushed units are explicitly **deferred** — see _Deferred_.

## Problem

Today an orchestrated `Run` is a **closed plan**: the submitter hands `submit(plan.json)` the entire DAG up front, `submitRun` validates the whole graph, and the run executes that fixed set. This is the wrong integration shape for the ICP.

The GTM ICP is **seed–Series-A vertical-agent builders who embed Pangolin as a library** to unblock a regulated deal. Their application produces agent work **imperatively, as events arrive** (a claim lands → dispatch an appeal agent), not as a pre-compiled DAG of everything the app will ever do. Forcing a rigid `plan.json` mismatches how the buyer integrates. The owned-position synthesis already names this: the **FED BY → append-able orchestration** layer ("submit anytime; deps across batches") is what makes Pangolin "a substrate you live on," and a continuously-fed run turns a one-shot patch receipt into a "growing, continuously-sealed ledger" — the center of gravity of the position.

Two existing entry points both miss the need:
- `client.dispatch(work)` — push, but **standalone**: no queue/deps/locks/pattern, no run-level audit ledger.
- orchestrator `submit(plan.json)` — durable + gated + sealed, but **rigid** (closed DAG up front).

The missing third shape: **push items into a durable, gated, sealed, possibly-patterned run over time.**

## What is and isn't hard (the honest split)

- **Execution engine: no change.** The tick re-scans the run-state store every tick and gates on deps/locks/concurrency (`engine/tick.ts`); appended items are picked up next tick. `extendRun` already exists (`orchestrator.ts:207-250`): idempotent-by-item-id, validates the **merged** graph all-or-nothing, fused by `maxItemsPerRun`, emits `run.extended`. It is also the path the pattern layer's spawn uses (`orchestrator.ts:292`).
- **Pattern routing of pushed items: also free.** `collectSpawns` (`patterns/scan.ts:8-12`) calls `pattern.onTaskDone` for **every** terminal item regardless of origin, so producer-pushed items route through gating / fan-in / circle-back exactly like `plan()`-created ones.
- **Quiescence under patterns: free.** `tick` runs `applyPatternPhase` (spawn) **before** the seal block (`orchestrator.ts:333-335`, with an explicit comment), so a pattern that circles back — even after `close` — adds *pending* items, the run isn't all-terminal, and it cannot seal until the pattern reaches its fixpoint.
- **Audit / seal model: the real design.** An **audit epoch == a run**, sealing **once** when *all* items are terminal (`orchestrator.ts:337-368` → `sealEpoch`, `audit/audit-log.ts:77-95`). A continuously-fed run never reaches "all terminal," so it never seals. Resolving this — without breaking the ~13 existing `SubmissionTransport`/`RunStateStore` test fakes, the existing auto-seal, or the existing pattern spawn — is the substance of this spec.

## Goals

1. An external producer can `extend` a live run with new items over time through the durable, no-inbound mailbox.
2. An explicit `close` signal decouples **submission-complete** from **all-items-terminal**.
3. **Opt-in, back-compat sealing.** A run sealed at all-terminal as today UNLESS submitted `openEnded: true`, in which case it waits for `close`. A normal run's behaviour is byte-for-byte unchanged.
4. **Composes with patterns.** A patterned, open-ended run routes pushed items through the existing `onTaskDone` path; pattern circle-back after `close` drains before the seal.
5. **Non-breaking contracts.** No existing `SubmissionTransport`/`RunStateStore` impl or test fake breaks; the internal `extendRun`/spawn path is unchanged.
6. A runnable `examples/appendable-stream` proving the end-to-end shape ($0 / CI-runnable via the fake compute), including a *patterned* open-ended run.

## Non-goals (explicit scope boundaries)

- **The epoch-window chain / continuous sealing.** A run that never "closes," sealing a chained epoch per checkpoint, is deferred (see _Deferred_). This proof requires a `close`.
- **Pattern *templating* of pushed units (`planExtend`).** Pushed items are *routed* by the pattern (free, via `onTaskDone`); they are NOT auto-*expanded* from a semantic unit into the pattern's item-shapes. That convenience is deferred (see _Deferred_) — the producer pushes pattern-shaped items it already knows how to build.
- **Worker-driven in-path fan-out.** The producer is an operator outside the graph; we add an *operator* push (`producerExtend`), not a worker-spawn API. The internal `extendRun` caller for pattern `spawn` is unchanged.
- **Throughput-as-parallelism.** Queue `concurrency` and serverless placement already exist. Per-item push-to-pickup latency ≈ one tick (2s default, `tickIntervalMs`-tunable in `serve/driver.ts:58`) — a tuning knob, not an architectural lever, out of scope.
- **`pangolin-core` / engine changes.** Only an additive `'run.closed'` `AuditEntryKind`. The tick, dep-resolver, locks, concurrency gate, and audit-bundle format are untouched.

## Decisions (from brainstorming)

- **Append-able is OPT-IN via `Run.openEnded`** — NOT a unilateral seal-gate change. "Seal when all-terminal AND closed" applied to all runs would (a) break every existing closed-plan run (they never `close`), and (b) via a "uniformly auto-close at submit" variant, break the existing pattern-layer spawn (auto-closed runs would reject the pattern's own `extendRun`). The opt-in flag preserves both the existing auto-seal AND the existing spawn.
- **Producer push is a NEW `producerExtend`, leaving `extendRun` unchanged** — NOT a closed-guard bolted onto `extendRun`. The pattern layer's spawn uses `extendRun`; guarding it would block legitimate pattern circle-back *after* close. So `producerExtend` (unknown-run + closed guard) is the producer seam, delegating to the unchanged internal `extendRun`. SoC: producer path vs internal-spawn path, separated by method, not by a flag.
- **`extend` is a SEPARATE optional `AppendChannel` capability** (mirroring `ControlChannel`) — NOT new required methods on `SubmissionTransport`. The repo has ~9 `SubmissionTransport` fakes; required methods break them all. Composed as `Partial<AppendChannel>`, optional-chained by the driver. Existing impls/fakes unaffected.
- **Run-flag store methods are OPTIONAL** (`isOpenEnded?`/`markOpenEnded?`/`isClosed?`/`markClosed?`), mirroring the repo's `runningSinceMs?` "back-compat for fakes" precedent; the orchestrator null-coalesces (`?? false`). Keeps the ~4 `RunStateStore` fakes compiling.
- **`close` is a `ControlEnvelope.kind` variant** on the existing `ControlChannel` (additive, alongside `cancel`) — no new control methods.
- **Quiescence is structural, not bookkept** — `applyPatternPhase` runs before the seal block, so pending spawns block the seal naturally. No "no-pending-spawns" check is added.
- **No audit-bundle/format change.** The deferred epoch-window chain's hook is purely conceptual (model `close` as an epoch boundary); no speculative schema now.

## Design

### The seam (`pangolin-orchestrator/src/contracts/...`)

**Opt-in flag — `Run.openEnded` (`contracts/types.ts`):**

```ts
export interface Run {
  id: string;
  queue: string;
  items: WorkItem[];
  /** OPT-IN append-able mode. true → the run does NOT auto-seal at all-terminal; it waits
   *  for an explicit close. Absent/false = today's closed-plan behaviour. */
  openEnded?: boolean;
}
```

**Data plane — `extend` on a new optional `AppendChannel` (`contracts/submission-transport.ts`):**

```ts
export interface ExtendEnvelope {
  runId: string;
  items: WorkItem[];     // logical-id items, same shape as Run.items
  actor: string;
  at: string;            // ISO-8601
  causeItemId?: string;
  seq?: string;          // TRANSPORT-assigned unique key (producers omit it); surfaced by pollExtends for ack
}

/** Optional capability, kept SEPARATE from SubmissionTransport (exactly like ControlChannel)
 *  so existing impls/fakes are unaffected. */
export interface AppendChannel {
  extend(env: ExtendEnvelope): Promise<void>;
  pollExtends(): Promise<ExtendEnvelope[]>;            // each envelope carries its seq
  ackExtend(runId: string, seq: string): Promise<void>;
}
```

**Control plane — `close` as a `ControlEnvelope` variant:**

```ts
export interface ControlEnvelope {
  kind: 'cancel' | 'close'; // 'close' added — the explicit epoch-boundary marker
  target: string;           // run-id
  actor: string;
  at: string;
}
```

`SubmissionTransport` itself is unchanged. `MailboxSubmissionTransport` additionally `implements AppendChannel`, reusing the existing module-level `enc`/`dec` helpers and keying each extend by a `randomUUID` under `{ns}/extends/{runId}/`; `pollExtends` surfaces that key as `seq`. `close` needs no new transport code (rides the control mailbox).

### Orchestrator (`pangolin-orchestrator/src/orchestrator.ts`)

1. **`submitRun`: mark open-ended runs.** After validation/`saveRun`, `if (run.openEnded) this.store.markOpenEnded?.(run.id)`.

2. **NEW `producerExtend(runId, items, actor, causeItemId?)`** — the guarded producer seam:
   - throw on unknown run (mirrors `extendRun`);
   - throw if `this.store.isClosed?.(runId)` (the closed-guard lives HERE, not on `extendRun`);
   - delegate to the existing `extendRun` (merged-graph validation + `run.extended` audit + fuse).

3. **`extendRun` — UNCHANGED.** Remains the internal, *unguarded* append used by pattern spawn (`orchestrator.ts:292`), so pattern circle-back after `close` still works and drains.

4. **`closeRun(runId, actor?)`** — sibling of `cancelRun`; throws on unknown run; `this.store.markClosed?.(runId)` (idempotent); emits a best-effort `run.closed` audit entry.

5. **Opt-in seal-gate** (`orchestrator.ts:337-368`):
   ```
   was: all-terminal
   now: all-terminal && (!(store.isOpenEnded?.(runId) ?? false) || (store.isClosed?.(runId) ?? false))
   ```
   A normal run (`isOpenEnded` false) collapses to `all-terminal` — unchanged. An open-ended run seals only once closed. Pending pattern spawns keep it non-terminal until quiescent.

### Run-level flags (`RunStateStore` + sqlite)

Four OPTIONAL methods on the interface (`contracts/runstate-store.ts`): `markOpenEnded?`/`isOpenEnded?`/`markClosed?`/`isClosed?`. The sole impl (`SqliteRunStateStore`) adds a `runs` table to `SCHEMA` (`CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, open_ended INTEGER NOT NULL DEFAULT 0, closed INTEGER NOT NULL DEFAULT 0)` — re-`exec`'d each construct, so no `MIGRATIONS` entry) and implements all four (open/closed independent, both idempotent, durable). There is exactly one impl (in-memory via `:memory:`); the optional signatures keep the ~4 test fakes compiling.

### Audit-root record shape — **no change** (YAGNI)

The proof makes no change to `putAuditRoot` / `audit_roots` / the `AuditBundle`. A tamper-evident epoch chain would have to **bind `prev_root` into the signed payload** (a `canonEntry`-style change, the `output_refs`-into-canon precedent), not a mere column, so adding speculative columns now would over-claim additivity. The non-foreclosing hook is purely conceptual (`close` = epoch boundary).

### Serve loop (`pangolin-orchestrator/src/serve/driver.ts`)

`ServeOptions.transport` widens to `SubmissionTransport & Partial<ControlChannel> & Partial<AppendChannel>`. One new poll step (`pollExtends` → `producerExtend`, ack by surfaced `seq`) before the existing control poll; the existing control dispatch gains a `close` branch (`ctl.kind === 'close'` → `closeRun`). Best-effort + dead-letter, matching submit/cancel.

## Data flow (happy path, patterned open-ended run)

```
producer.submit({ run: { id, queue:'pipeline-q', items:[seed], openEnded:true }, ... })
   → submitRun: pat.plan(seed) runs; markOpenEnded(runId)
producer.extend({ runId, items: wave })  (×N over time)
   → serve pollExtends → producerExtend (closed-guard) → extendRun → saved
   → next tick: items ready/fire; pattern onTaskDone routes/gates them as they finish
producer.control({ kind:'close', target: runId })
   → serve pollControl(close branch) → closeRun → markClosed + run.closed entry
tick: all-terminal && isOpenEnded && isClosed   (pattern fully drained)
   → run.completed + sealEpoch → root persisted (single epoch)
producer.readOutbox → sealed bundle ; verifyBundle → intact over the grown+routed graph
```

The engine never changes; appended items are present on the next store re-scan, and the pattern routes them via the existing path.

## Error handling & edge cases

| Case | Behavior |
|---|---|
| **Producer extend after close** | `producerExtend` throws (closed-guard) → transport dead-letters. |
| **Pattern spawn (circle-back) after close** | ALLOWED — uses the unguarded `extendRun`; the spawned work drains and the run seals only once quiescent. |
| **Extend before the run's `submit` is ingested** | `producerExtend` throws (unknown-run) → dead-letter. `pollInbox` runs before `pollExtends`, so a submit+extend in one window ingests in order; producers must still `submit` before `extend`. |
| **Forward-ref / cycle in pushed items** | `extendRun`'s merged-graph `validateRun` rejects all-or-nothing; store unchanged; dead-lettered. Producer constraint: append deps before dependents. |
| **Retries / duplicate pushes** | Safe. extend keyed by transport `randomUUID` (no collision); `extendRun` idempotent-by-item-id; `close`/`markClosed` idempotent; `submit` idempotent-by-run-id. |
| **Normal (non-openEnded) run** | Seals at all-terminal exactly as before — no `close` needed, no behaviour change. |
| **Open-ended run never closed** | Never seals — by design (this is the deferred epoch-window case). |
| **Close unknown run** | `closeRun` throws. |
| **Crash / restart mid-stream** | Survives: mailbox durable, `serve` re-polls, `open_ended`/`closed` persisted, `recoverStranded` handles in-flight. |

## Testing

**Unit (orchestrator):**
- `producerExtend`: appends via `extendRun`; throws on unknown run; throws when closed (leaving the store unchanged); pushed items still validated all-or-nothing.
- `extendRun` UNCHANGED: still appends on a closed run when called directly (the pattern-spawn path is unguarded) — guards the regression.
- `closeRun`: idempotent; unknown-run throws; emits `run.closed`.
- Seal gate: a NORMAL run seals at all-terminal (back-compat, no close); an open-ended run does NOT seal until closed, then seals (with `run.completed`); a patterned open-ended run with a post-close circle-back seals only after the spawn drains.

**Integration (serve-driver):** submit (openEnded) → poll-driven `extend` waves → `close` → sealed bundle in outbox; `verifyBundle` intact over the grown graph; `run.extended` + `run.closed` + `run.completed` present.

**Runnable example — `examples/appendable-stream`:** a driver-is-the-assertion proof on a **patterned** open-ended queue: submit a seed (`openEnded: true`), push items across ≥2 waves via `extend`, let the pattern route them, `close`, then read + `verifyBundle` the sealed ledger asserting `intact` + all items `done`. $0 / CI via the fake in-proc compute (mirrors `examples/offload-fanout`).

## Deferred

- **Epoch-window chain (continuous sealing).** The "growing, continuously-sealed ledger" — run stays open indefinitely, sealing a chained epoch per checkpoint (each Merkle root chaining to the prior). Low-friction but real: (a) `epoch_seq`/`prev_root` columns (a `MIGRATIONS` entry), (b) **binding `prev_root` into the signed payload** (a `canonEntry`-style canon change, not purely additive), (c) per-epoch seal-gate. Trigger: a consumer needing a never-closing run sealed continuously.
- **Pattern templating (`planExtend`).** Auto-expand a pushed semantic unit into the pattern's item-shapes (vs the producer pushing pattern-shaped items it already knows). A convenience that decouples producers from a pattern's internal id/wiring conventions (real value for convention-heavy patterns like quorum, marginal for pipeline). If built, it belongs **server-side as an optional `Pattern.planExtend?(items, run)`** hook (co-located with `plan()` so the pattern owns its shape once — DRY), called by `producerExtend`. Trigger: a real producer feeling the pain of hand-replicating a pattern's internal item conventions.

Both deferrals tracked in: mneme `project:agora / roadmap.append-able-submission.epoch-window-deferred`; vault `wikis/agora/inbox/2026-06-25-0540-come-back-to-epoch-window-chain-the`; relates to `synthesis-the-position-agora-owns-provable`.

## Affected files (anticipated)

- `pangolin-core/src/audit.ts` — additive `'run.closed'` `AuditEntryKind`.
- `pangolin-orchestrator/src/contracts/types.ts` — `Run.openEnded?`.
- `pangolin-orchestrator/src/contracts/submission-transport.ts` — `ExtendEnvelope`, `AppendChannel`, `ControlEnvelope.kind += 'close'`.
- `pangolin-orchestrator/src/contracts/runstate-store.ts` — optional `markOpenEnded?`/`isOpenEnded?`/`markClosed?`/`isClosed?`.
- `pangolin-orchestrator/src/runstate/sqlite.ts` — `runs` table + the four methods.
- `pangolin-orchestrator/src/orchestrator.ts` — `submitRun` openEnded mark; `producerExtend`; `closeRun`; opt-in seal-gate. (`extendRun` untouched.)
- `pangolin-orchestrator/src/transport/storage-transport.ts` — `AppendChannel` impl (reuse `enc`/`dec`).
- `pangolin-orchestrator/src/serve/driver.ts` — widen transport type; `pollExtends` → `producerExtend`; `close` branch.
- `examples/appendable-stream/` — the runnable proof (patterned open-ended run).
- Docs: a reference note on the producer push API + the example README.
