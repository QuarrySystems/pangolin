---
title: "ADR-0008: needs_input uses request-stop-restart (Shape A), not in-flight ask (Shape B)"
description: "needs_input uses request-stop-restart (Shape A), not in-flight ask."
status: accepted
date: 2026-05-21
deciders: pangolin-scale-mvp-design
---

## Context

Sub-agents dispatched through Pangolin Scale regularly hit ambiguity mid-task: "I could
change function A or function B; which?" The MVP needs a convention for how a
sub-agent surfaces that ambiguity back to its operator, and how the operator's
answer gets threaded back into a continuation of the work.

Two structural shapes were weighed:

- **Shape A — request-stop-restart.** The sub-agent emits a structured "I need
  input" outcome and terminates. The orchestrator (a Claude Code agent via
  pangolin-mcp, or TypeScript code) routes the question to the right answerer
  (human via Slack, another agent, a database lookup), and re-dispatches the
  same subagent with the answer added to its `input`. Each dispatch is a fresh
  worker; continuity rides on `partial_state` carried through the re-dispatch.
- **Shape B — in-flight ask.** A bidirectional channel is opened during
  dispatch so the running sub-agent can ask the operator a question, block on
  the answer, and resume in the same process. Requires a `ConversationAdapter`
  abstraction, a sub-agent-reachable ask primitive, and operator-side machinery
  to answer mid-dispatch.

Three considerations drove the choice toward Shape A for v0.1:

1. **Cost.** A worker blocked waiting for a human answer continues to bill
   for compute/runtime hours while it waits. A Slack round-trip is minutes-to-
   hours; a worker doing nothing during that window is pure waste.
2. **Mechanism cost.** Shape B requires a bidirectional adapter (sub-agent ↔
   operator), a sub-agent-reachable ask primitive distinct from normal tool
   calls, and orchestrator-side state to track an in-flight question. None of
   that machinery is needed for Shape A: a sentinel file plus a re-dispatch
   call is the whole protocol.
3. **Snapshot-resume does not eliminate cold start.** A naive defense of Shape
   B says "snapshot the worker mid-flight, resume it after the answer arrives,
   so you don't pay for the wait." But snapshot-resume still pays a cold-start
   cost on resume (image fetch, workspace rehydrate, runtime warmup) and adds
   substantial machinery (snapshot store, snapshot format versioning, resume-
   path bugs). It narrows the cost gap with Shape A without closing it, and
   it does so at the price of significantly more code.

The companion §6.9.1 pattern ("prior reasoning as `partial_state`") makes
Shape A competitive with Shape B for the common case: most of the work in a
typical "should I do A or B?" detour is analytical, and analysis can be passed
as data through `partial_state` without snapshot machinery.

## Decision

From §6.9:

> A sub-agent that hits ambiguity mid-task — "I could change function A or
> function B; which?" — should not guess. The MVP pattern for handling this is
> **request-stop-restart**, not in-flight ask. The sub-agent exits with a
> structured response indicating it needs input; the orchestrator (Claude Code
> agent via pangolin-mcp, or TypeScript code) routes the question to the right
> answerer (a human via Slack, another agent, a database lookup) and
> re-dispatches with the answer added to input.

Shape B (in-flight ask), snapshot-resume, and a future `ConversationAdapter`
are explicitly v0.2+ topics. They are not built, not stubbed, not reserved
in the MVP type surface beyond the additive room that closed-vocabulary event
extensions already permit.

## Consequences

- The `DispatchResult` shape carries an optional `needsInput` field; the
  closed lifecycle-event vocabulary gains a sixth kind, `dispatch.needs_input`,
  distinct from `dispatch.finished` so downstream telemetry can tell the two
  outcomes apart without payload inspection.
- Re-dispatch is the orchestrator's responsibility, not the worker's. The
  worker emits `dispatch.needs_input` and exits cleanly with code 0; the
  orchestrator decides whether/when/with-what-answer to redispatch.
- Continuity across the gap rides on `partial_state` (capped at 1 MiB
  serialized, see §6.9). Integrators with larger continuity needs persist bulk
  state externally and pass a pointer.
- A worker that hits `needs_input` finishes cleanly and stops billing. The
  cost gap between Shape A and Shape B widens the longer the operator takes
  to answer — which is the common case for human-in-the-loop clarifications.
- Integrators who genuinely need synchronous in-flight conversation are not
  served by the MVP. That deferral is intentional: when a `ConversationAdapter`
  ships, it will be additive to the existing surface, not a replacement for
  the `needs_input` convention.
- The "prior reasoning as `partial_state`" pattern (§6.9.1) is load-bearing
  for resume quality. Without it, every re-dispatch redoes the analytical
  work the prior dispatch already finished.
