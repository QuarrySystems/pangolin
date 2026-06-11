---
title: "ADR-0018: Pangolin Scale ships orchestration as a separate opt-in layer"
description: "Pangolin Scale ships orchestration as a distinct package + service (pangolin-orchestrator / offload), superseding ADR-0010's posture that orchestration lives only above Pangolin Scale and is out of scope forever. The client-SDK workflow-primitive rejection still stands."
status: accepted
date: 2026-06-01
deciders: pangolin-offload-v1
supersedes: ADR-0010
---

:::note[Relationship to ADR-0010]
This ADR **partially supersedes [ADR-0010](/pangolin/explanation/decisions/0010-no-workflow-primitive/)**.
ADR-0010's *narrow* decision — no `pangolin.workflow()` / `pangolin.procedure()` sugar
primitive on the client SDK — **still holds**. What this ADR reverses is ADR-0010's
*broad posture*: that orchestration "sits above Pangolin Scale, not inside it" and is "out of
scope forever." Pangolin Scale now ships orchestration as a distinct, opt-in layer.
:::

## Context

[ADR-0010](/pangolin/explanation/decisions/0010-no-workflow-primitive/) (MVP, 2026-05-21)
made two claims that have since diverged:

1. **Narrow:** Pangolin Scale should not ship a `pangolin.workflow()` / `pangolin.procedure()`
   primitive — a named, pre-composed dispatch template as sugar on the client SDK.
   Integrators wrap `dispatch()` themselves.
2. **Broad:** the architectural posture is that *"orchestration sits above Pangolin Scale,
   not inside it,"* multi-step pipelines are *"out of scope forever,"* and the MCP
   surface *"stays at six tools — no workflow-runner tools to add."*

The MVP correctly deferred judgement on multi-step orchestration until there was
evidence of a real shape. That evidence arrived: the **overnight dev-offload** use
case — submit a DAG of agent tasks, fan out under resource locks, retry with
backoff, produce a reviewable patch per task and a tamper-evident audit trail —
is not expressible as a five-line `dispatch()` wrapper. It requires:

- **Crash-safe persistent run-state** (a single-writer SQLite store, D2/D3).
- **A non-blocking execution model.** `PangolinClient.dispatch()` blocks on
  `awaitExit()`; an unattended queue cannot loop over blocking dispatch. The
  orchestrator runs a **tick-based fire-and-reconcile** loop (D6).
- **Dependency resolution + resource locks** (disjoint locks fan out in parallel;
  shared locks serialize) and **retry/backoff** with `failed`/`skipped` cascade.
- **A signed manifest + Merkle-rooted audit log** with a pluggable tamper-evidence
  anchor (the compliance edge, §6 of the offload V1 spec).

None of that fits the one-shot, stateless `dispatch()` contract. ADR-0010's
"wrappers in user code" answer does not cover persistent state, crash recovery,
or a verifiable audit trail. The question this ADR answers: does Pangolin Scale ship that
capability, and if so, *where* — bolted onto the client, or as a distinct layer?

## Decision

**Pangolin Scale ships orchestration as a separate, opt-in layer — not as a primitive on
`PangolinClient`.** Concretely (per the
[Orchestrator architecture spec](https://github.com/quarrysystems/pangolin/blob/main/docs/superpowers/specs/2026-05-28-pangolin-scale-orchestrator-design.md)
and the
[Offload V1 delivery spec](https://github.com/quarrysystems/pangolin/blob/main/docs/superpowers/specs/2026-05-29-pangolin-offload-v1-design.md),
shipped as pangolin-offload V1):

- Orchestration lives in its **own package** `@quarry-systems/pangolin-orchestrator`,
  with its seams + types in `src/contracts/` — **not** in `pangolin-core`, which stays
  minimal (D11). Low-level providers and the worker remain ignorant of orchestration.
- It runs as a **distinct long-running service** (`pangolin orch serve`) that is the
  exclusive owner of its run-state DB (D3). The CLI and MCP are *clients* of that
  service; they never open the DB.
- Its surface is **`pangolin orch` (submit / status / watch / cancel / audit)** plus
  **three client MCP tools** (`pangolin_orchestrator_submit`, `_status`, `_watch`).
- The client `dispatch()` surface is **unchanged** — still one-shot and stateless.
  The orchestrator composes the internal `fire()` + `reconcile()` split (D9); that
  split is internal and does not add a second composition surface to the SDK.

**What ADR-0010 still governs:** there is no `pangolin.workflow()` /
`pangolin.procedure()` method on `PangolinClient`. Named pre-composed *single* dispatches
remain integrator-side wrapper functions. Orchestration is reached through a
deliberately separate layer, not by overloading the dispatch SDK.

## Consequences

- The MCP run-time surface is now **nine tools**, not six — the three
  `pangolin_orchestrator_*` client tools were added. ADR-0010's "stays at six tools"
  consequence is therefore superseded. The privilege boundary of
  [ADR-0005](/pangolin/explanation/decisions/0005-privileged-ops-never-ai-reachable/)
  is **preserved**: the orchestrator tools are client/read operations; privileged
  ops (`register`, `assign`) and the service/operator action `audit` remain off the
  AI tool surface, enforced by the CI allowlist check.
- "Orchestration above Pangolin Scale, not inside it" no longer describes the codebase.
  The accurate statement is: orchestration is a **separable layer that ships in the
  Pangolin Scale repo as its own package and process**, composed at the deployment boundary
  like any other seam — present when you wire it, absent when you don't.
- The deferred layers (additional executors, packs, `Intent`/interpreter, named
  queues beyond `default`, `cron`) remain out of V1 but are **additive**, not
  re-litigations of this decision. See the
  [Roadmap](/pangolin/explanation/project-status-roadmap/).
- Pangolin Scale is still **not a general-purpose workflow engine.** The orchestrator is
  scoped to dispatching DAGs of agent tasks with locks/deps/audit; it is not a BPMN
  runner, and the §1.3 "branches" (predicate/event triggers, pause/resume, etc.)
  are pulled only when a real use case needs them.

## Why this is a supersede, not an edit

Per the [decision-records convention](/pangolin/explanation/decisions/), an ADR is
immutable once accepted; a changed direction is recorded by a new ADR that
references the old one. ADR-0010 keeps its original text and gains a "superseded by"
banner; this ADR carries the new reasoning.
