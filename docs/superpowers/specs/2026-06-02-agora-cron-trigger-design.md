---
title: "Agora Offload — Cron Scheduling (recurring submission, no refactor)"
date: 2026-06-02
status: "**SHIPPED — status corrected 2026-08-03.** Built as designed, including D1 (cron is a submission PRODUCER, not a `Trigger`). Verified on main: `src/scheduling/cron-scheduler.ts` (coalesced catch-up via `it.prev()`, deterministic runId `${id}@${slot}`), `src/contracts/schedule-store.ts` + `schedule.ts`, `src/runstate/sqlite-schedule-store.ts`, drained each tick at `src/serve/driver.ts:259`, CLI `schedule add|list|rm` at `pangolin-cli/src/cmd-orch.ts:373`, and six test files green in the orchestrator suite. The §0.2 deferrals (per-schedule timezone, sub-minute schedules, concurrency policy beyond the runId dedup, an MCP surface) remain deferred and are the only open work here. **Originally:** draft"
authors: [human:Brett, agent:claude-opus-4-8]
builds_on:
  - "[[docs/superpowers/specs/2026-05-28-agora-orchestrator-design.md]]"
  - "[[docs/superpowers/specs/2026-05-29-agora-offload-v1-design.md]]"
---

# Agora Offload — Cron Scheduling

> **Goal:** add *recurring* offload to the V1 orchestrator. V1 + `serve`
> already delivers *unattended* offload (submit once, walk away). Cron adds the
> missing axis — submit on a schedule, with no client present at fire time —
> as a strict superset of V1 that touches no existing code path.
>
> This is the first item pulled into V1.1 per `ROADMAP.md` ("**This is the first
> item to pull into V1.1.**").

---

## 0. Why this exists

V1 ships a `Trigger` seam whose only implementation is `ManualTrigger`
(`packages/agora-orchestrator/src/triggers/manual.ts`). A Run becomes work only
when a client writes a submission to the inbox and `serve`'s `pollInbox()`
ingests it. There is no way to say "run this plan every night at 02:00" without
an external scheduler poking the inbox.

The roadmap names this gap and its fix:

> **`cron` trigger** — recurring scheduling via the existing `Trigger` seam.
> `serve` + manual `submit` already delivers *unattended* offload (submit once,
> walk away); `cron` adds *recurring*.

This spec designs that feature.

## 0.1 The reframe — cron is a *producer*, not a `Trigger`

The roadmap phrases this as a "`cron` **trigger**," but the V1 `Trigger`
contract answers exactly one question:

```typescript
export interface Trigger {
  id: string;
  /** ids of items to mark ready the moment a run is submitted. */
  initialReady(run: Run): string[];
}
```

A `Trigger` decides *"this Run just landed — which of its items start `ready`?"*
Cron does not change that answer. A cron-emitted Run still has roots that
`ManualTrigger.initialReady` unblocks identically to any client submission.

What cron actually needs is to **produce a Run on a schedule** — a capability the
single-method `Trigger` interface cannot express (`initialReady(run)` assumes a
Run already exists). So the seam being extended is **"submission sources,"** not
the `Trigger` contract. Concretely: cron is an in-process *client* that calls the
same `SubmissionTransport.submit()` a human or agent calls, on a clock.

**Design decision (D1):** model cron as a Run **producer** that feeds the
existing inbox. The `Trigger` seam stays at one implementation (`manual`). This
keeps a single submission pipeline and leaves the engine, audit, and trigger code
completely untouched. (Rejected: extending `Trigger` with a `dueRuns(now)` method
— it overloads a single-purpose seam and makes `manual`/`cron` asymmetric for no
gain once the inbox path is chosen.)

## 0.2 What this proves vs. defers

**In scope:**
- A `CronScheduler` `serve` polls each tick, emitting due submissions through the
  existing transport.
- A persistent `ScheduleStore` (new SQLite table on the run-state volume `serve`
  already owns).
- Standard 5-field cron expressions.
- Catch-up policy: **fire one coalesced catch-up after downtime, then resume**
  (see §4).
- One CLI verb group for schedule lifecycle (`agora orch schedule add|list|rm`).

**Out of scope (deferred):**
- Sub-minute schedules, timezone-per-schedule (V1.1 is host-local / UTC; see §7).
- Predicate / signal / event triggers (already a separate `Later` roadmap item).
- Schedule-level concurrency policy beyond "skip if the prior run id still
  exists" (the deterministic-runId dedup of §4.3 is the only overlap guard).
- An MCP surface for schedule mutation — scheduling is an **operator** action, so
  it lands on the CLI only, mirroring V1's choice to keep `audit` off MCP
  (`ROADMAP.md` "Operator surface"). A CI allowlist check already fails if a
  privileged method becomes MCP-reachable; the new schedule methods inherit that.

---

## 1. Architecture

Two submission sources, one pipeline:

```
   client.submit()  ─┐
                      ├─▶ inbox/ ─▶ pollInbox ─▶ submitRun ─▶ ManualTrigger ─▶ tick
   cron (scheduler) ─┘
```

Cron contributes only the left-hand producer. Everything from `inbox/` rightward
is unchanged V1 code.

### 1.1 New components

| Unit | Role | Depends on |
|---|---|---|
| `Schedule` (type) | A cron expression + Run template + bookkeeping. | `Run` |
| `ScheduleStore` (seam) | Persist/query schedules. Sole writer: `serve`. | — |
| `SqliteScheduleStore` | Default store impl; new `schedules` table on the run-state DB. | `ScheduleStore`, SQLite |
| `CronScheduler` | Wraps a `ScheduleStore` + cron-expr parser; computes due submissions and advances bookkeeping. | `ScheduleStore`, cron-parser, `now()` |
| `serve` loop block | ~5 lines: drain `scheduler.dueSubmissions()` into `transport.submit()`. | `CronScheduler`, `SubmissionTransport` |
| `agora orch schedule …` | CLI lifecycle (add/list/rm). | `ScheduleStore` |

### 1.2 Contracts

```typescript
// contracts/schedule.ts
export interface Schedule {
  id: string;            // stable, user-chosen — e.g. "nightly-audit"
  cronExpr: string;      // standard 5-field cron (min hour dom mon dow)
  run: Run;              // template; runId is rewritten per-fire (§4.3)
  actor: string;         // identity stamped on every emitted submission
  lastFiredAt?: string;  // ISO-8601; undefined until first fire
  nextDueAt: string;     // ISO-8601; persisted for cheap due-checks
}

// contracts/schedule-store.ts
export interface ScheduleStore {
  due(nowMs: number): Schedule[];                                  // nextDueAt <= now
  markFired(id: string, firedAtMs: number, nextDueAt: string): void;
  upsert(s: Schedule): void;
  remove(id: string): void;
  list(): Schedule[];
}
```

`ScheduleStore` deliberately mirrors the shape and sole-writer discipline of the
existing `RunStateStore`, so its store-contract tests can follow the same
pattern.

### 1.3 The scheduler

```typescript
// scheduling/cron-scheduler.ts
export class CronScheduler {
  constructor(
    private readonly store: ScheduleStore,
    private readonly now: () => number,
  ) {}

  /**
   * For every schedule due as of `now`: emit ONE coalesced submission envelope
   * (for the most recent missed slot, §4) and advance its bookkeeping via
   * markFired(). Returns the envelopes for serve to submit().
   */
  dueSubmissions(): SubmissionEnvelope[] { /* §4 mechanics */ }
}
```

---

## 2. Data flow

```
                  ┌──────────────────────── serve (sole writer) ────────────────────────┐
                  │                                                                       │
  run-state.sqlite│   loop every tickIntervalMs:                                          │
  ┌──────────────┐│   ┌───────────────────────────────────────────────────────────────┐ │
  │ runs/items   ││   │ (NEW) scheduler.dueSubmissions()                                │ │
  │ queues       ││   │     │  reads schedules WHERE next_due_at <= now                 │ │
  │ schedules ◀──┼┼───┤     │  coalesces missed slots → ONE catch-up env per schedule   │ │
  │  id          ││   │     │  markFired(id, now, nextDue)  ──────────────┐             │ │
  │  cron_expr   ││   │     ▼                                             │ persists    │ │
  │  run_tmpl    ││   │  transport.submit(env) ──┐                        ▼             │ │
  │  last_fired  ││   │                          │              (advances next_due_at)  │ │
  │  next_due ◀──┼┼───┼──────────────────────────┼────────────────────────────────────┘ │
  └──────────────┘│   │                          ▼                                        │
                  │   │                       inbox/  (FS or S3 prefix)                   │
  ┌──────────────┐│   │                          │                                        │
  │   inbox/     │◀┼───┤  pollInbox() ────────────┘                                        │
  │ (durable;    ││   │     │                                                              │
  │  survives    ││   │     ▼                                                              │
  │  restart)    ││   │  submitRun(run)  ── idempotent no-op if runId already ingested     │
  └──────────────┘│   │     │                                                              │
                  │   │     ▼                                                              │
                  │   │  ManualTrigger.initialReady(run)  ← UNCHANGED V1 path             │
                  │   │     ▼                                                              │
                  │   │  tick(): dispatch · reconcile · retry · seal audit                │
                  │   └───────────────────────────────────────────────────────────────┘ │
                  └───────────────────────────────────────────────────────────────────────┘
```

---

## 3. `serve` integration

The entire wiring is one block in the existing `while (!opts.signal?.aborted)`
loop in `packages/agora-orchestrator/src/serve/driver.ts`, structurally
identical to the cancel-control block already at `driver.ts:53`:

```typescript
// driver.ts — inside the loop body, before orchestrator.tick()
if (opts.scheduler) {
  for (const env of opts.scheduler.dueSubmissions()) {
    try { await opts.transport.submit(env); }   // ← same method a client uses
    catch (err) { opts.onError?.(err); }
  }
}
```

`ServeOptions` gains one optional field:

```typescript
export interface ServeOptions {
  // ...existing...
  scheduler?: CronScheduler;   // omit → V1 behaviour, no scheduling
}
```

The emitted Run lands in the inbox; the next loop iteration's `pollInbox()`
ingests it through the untouched `submitRun → ManualTrigger` path. `serve`
already threads `now?: () => number` (`driver.ts:11,33,61`) for deterministic
time — `CronScheduler` is constructed with the same `now`.

---

## 4. Catch-up + idempotency mechanics

This is the one section with real subtlety. The chosen catch-up policy ("fire one
catch-up, then resume") combines with V1's already-idempotent `submitRun` to give
robust behaviour with almost no new safety code.

### 4.1 Due detection

`store.due(nowMs)` returns every schedule whose `nextDueAt <= now`. For a
schedule that fired on time, exactly one slot is due. For a schedule whose slots
were missed during downtime, several slots are in the past but the store returns
the schedule **once** — coalescing happens in the scheduler, not the store.

### 4.2 Coalesce-to-most-recent-missed-slot

**Design decision (D2):** on a tick where `now = 04:01` and slots `02:00` and
`03:00` were both missed (schedule = hourly), `dueSubmissions()` emits **one**
envelope — for the *most recent* missed slot (`03:00`) — and sets `nextDueAt` to
the next future slot (`05:00`). The `02:00` slot is dropped. This matches the
"fire one catch-up, then resume" choice and avoids a thundering herd after
downtime.

```
down 02:00 ─────── 04:00, schedule = hourly
missed slots: 02:00, 03:00      ← 02:00 dropped
restart tick @ 04:01: emit ONE run for slot 03:00
nextDueAt := 05:00
```

(Rejected alternative: "fire one run *now* with no slot identity." It works but
forfeits the free dedup of §4.3, so the slot-stamped version is preferred.)

### 4.3 Deterministic per-slot runId → free dedup

Each fire rewrites the template's runId to a value derived from the schedule id
and the **scheduled** slot time (not wall-clock):

```
runId := `${schedule.id}@${slotIso}`
// e.g. "nightly-audit@2026-06-03T02:00:00Z"
```

Because the runId is deterministic per (schedule, slot), any accidental
double-emit is absorbed by `submitRun`'s existing idempotency guard
(`orchestrator.ts:61`):

```typescript
if (this.store.getItems(run.id).length > 0) return run.id; // idempotent no-op
```

No new idempotency key, dedup table, or lock is required.

### 4.4 Crash safety

`markFired` persists `lastFiredAt` / `nextDueAt` to SQLite in the same volume as
run-state. Failure modes:

- **Crash after `submit()`, before `markFired()`** → on restart the slot looks
  still-due and is re-emitted, but the runId is identical, so §4.3 dedups it.
  Harmless.
- **Crash before `submit()`** → slot still due, emitted normally on restart.
- The inbox copy is itself durable (FS/S3), so an in-flight submission survives a
  `serve` restart regardless.

There is no failure window that double-runs a slot or silently skips one (beyond
the intentional catch-up coalescing of §4.2).

---

## 5. Persistence — the `schedules` table

Added to the existing run-state SQLite DB (`serve` is already its sole writer):

```sql
CREATE TABLE IF NOT EXISTS schedules (
  id            TEXT PRIMARY KEY,
  cron_expr     TEXT NOT NULL,
  run_template  TEXT NOT NULL,     -- JSON-serialized Run
  actor         TEXT NOT NULL,
  last_fired_at TEXT,              -- ISO-8601, nullable
  next_due_at   TEXT NOT NULL      -- ISO-8601
);
CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(next_due_at);
```

Migration is additive (`CREATE TABLE IF NOT EXISTS`) — an existing run-state DB
upgrades in place with no data movement. `next_due_at` is indexed so `due()` is a
cheap range scan.

---

## 6. Operator surface (CLI only)

```
agora orch schedule add  --id <id> --cron "<expr>" --plan <plan.json> [--actor <id>]
agora orch schedule list
agora orch schedule rm   --id <id>
```

- `add` parses the cron expression (reject invalid up front), computes the first
  `nextDueAt`, and `upsert`s. Re-running `add` with the same id is an idempotent
  update (cron/template/actor replaced; bookkeeping recomputed).
- `list` prints id, cron, last-fired, next-due.
- `rm` deletes by id (no-op if absent — re-runnable safety, matching the vault's
  "no destructive defaults" posture).

No MCP tool ships for any of these (§0.2): schedule mutation is an operator
action. The CI privilege-allowlist check guards against accidental MCP exposure.

---

## 7. Known limitations / deferred

- **Host-local / UTC time only.** Per-schedule timezones are deferred; the slot
  arithmetic uses a single clock. Document that operators set the host TZ (or
  author cron in UTC).
- **Minute granularity.** `tickIntervalMs` (default 2s) bounds resolution to the
  tick; sub-minute cron is out of scope and standard 5-field cron is
  minute-granular anyway.
- **No backfill replay.** "Fire every missed occurrence" was explicitly rejected
  (§4.2). A schedule that must account for every slot is not supported in V1.1.
- **Single-`serve` assumption.** Sole-writer run-state means one `serve` per DB,
  same as V1. Multi-`serve` scheduling (leader election) is not in scope.

---

## 8. Testing approach

- **`CronScheduler` unit tests** with injected `now()`:
  - due / not-due boundary,
  - coalesce multiple missed slots → one envelope for the most recent,
  - deterministic runId for a given (schedule, slot),
  - `nextDueAt` advances to the correct next future slot.
- **`SqliteScheduleStore` contract tests**, mirroring the existing
  `RunStateStore` test shape (upsert/list/remove/due/markFired round-trips,
  migration idempotency).
- **One integration test**: register a schedule, advance the fake clock past a
  due time, assert exactly one envelope reaches a fake transport's inbox and the
  resulting run reaches `done` through the unchanged pipeline.
- **Idempotency test**: simulate crash-after-submit (call `dueSubmissions()` +
  `submit()` twice for the same slot) → assert `submitRun` ingests once.

---

## 9. Acceptance

1. With a registered hourly schedule and a running `serve`, a new run appears in
   the outbox roughly each hour with runId `<id>@<slotIso>`, with no client
   present.
2. Stopping `serve` across ≥2 slots and restarting produces **exactly one**
   catch-up run (most-recent missed slot), then resumes on schedule.
3. `agora orch schedule list` reflects `last_fired_at` advancing per fire.
4. No existing V1 test changes behaviour; `Trigger`, `submitRun`, `tick`, and the
   audit path are untouched.
5. The CI MCP-allowlist check still passes (no schedule method is MCP-reachable).

---

## 10. Files (anticipated)

New:
- `packages/agora-orchestrator/src/contracts/schedule.ts`
- `packages/agora-orchestrator/src/contracts/schedule-store.ts`
- `packages/agora-orchestrator/src/scheduling/cron-scheduler.ts`
- `packages/agora-orchestrator/src/runstate/sqlite-schedule-store.ts`
- CLI: `agora orch schedule` verb wiring.

Modified (additive only):
- `packages/agora-orchestrator/src/serve/driver.ts` (~5-line block + optional
  `scheduler` field on `ServeOptions`).
- run-state migration (new `CREATE TABLE IF NOT EXISTS`).
- `packages/agora-orchestrator/src/index.ts` (exports).
- `ROADMAP.md` (move `cron` from *Next* to *Now* on completion).
