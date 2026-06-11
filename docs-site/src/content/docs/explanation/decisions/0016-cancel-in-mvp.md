---
title: "ADR-0016: cancel() is in MVP, not v0.2"
description: "cancel() is in MVP, not v0.2; best-effort cancellation via provider stop + worker SIGTERM trap."
status: accepted
date: 2026-05-21
deciders: pangolin-scale-mvp-design
---

## Context

`PangolinClient.cancel(dispatchId)` lets an operator stop a running dispatch
before its compute-provider timeout fires. Implementing it spans three
layers (§7.6):

- The `ComputeProvider` interface needs a `stop()` method that each
  concrete provider implements (Fargate `StopTask`, local Docker
  `container.kill()`, etc.).
- `pangolin-client` needs to expose `cancel(dispatchId)` and route it through
  the provider.
- The worker needs to trap SIGTERM, attempt to emit `dispatch.cancelled`,
  release channel subscriptions, and exit cleanly.

The original spec revision held cancellation out of MVP on cost grounds —
three layers of touchpoints across packages, plus the worker-side
signal-handling correctness pass, looked like work that could slip past the
MVP deadline. The case for deferring was "it's nice to have, the timeout
catches runaways eventually, ship without it and add in v0.2."

Two pressures pushed the decision the other way:

- **Operator and audit story.** Regulated buyers and ops-conscious
  integrators expect "stop a runaway dispatch" as a baseline capability,
  not a v0.2 enhancement. A 24-hour `timeoutSeconds` cap means a misfired
  dispatch can burn compute for an entire day if there's no kill switch.
  The audit trail also benefits: an explicit `dispatch.cancelled` event
  with an operator-attributable cause is meaningfully more useful than a
  silent timeout.
- **Bounded implementation cost.** The provider `stop()` shape is already
  implicit in each provider's underlying API. The worker's SIGTERM
  handling overlaps with the cleanup path it already runs at normal exit
  (channel teardown, inline-secret deletion). The cost estimate
  collapsed to roughly one to two days of work once the touchpoints were
  walked end-to-end.

## Decision

From §10.1 of `docs/superpowers/specs/2026-05-21-pangolin-scale-mvp-design.md`:

> **`cancel()` is in MVP, not v0.2.** Implementation cost is bounded (~1-2
> days across provider stop implementations + pangolin-client + worker
> SIGTERM handling, all already partially specced). The audit/operational
> story benefits significantly; regulated buyers expect "stop a runaway
> dispatch" as table-stakes.

Cancellation is best-effort, not synchronous-acknowledged. The provider's
stop semantics apply (for Fargate, that's `StopTask` with a SIGTERM grace
period). The worker traps SIGTERM, attempts to emit `dispatch.cancelled`,
releases channel subscriptions, and exits. If the worker fails to honor
SIGTERM within the grace window, the provider escalates to SIGKILL and
the dispatch ends without a clean lifecycle event — the integrator still
sees a terminated dispatch, but the `dispatch.cancelled` event is
best-effort, not guaranteed.

## Consequences

What becomes easier:

- Operators can stop a runaway dispatch immediately instead of waiting
  for `timeoutSeconds` to expire. With a 24-hour cap, that's the
  difference between minutes of wasted compute and a full day.
- The audit trail carries an explicit `dispatch.cancelled` event with
  the operator-attributable cause, which is materially better than the
  silent timeout pathway.
- The compliance conversation with regulated buyers shortens. "We can
  stop a dispatch" is a yes/no question and the answer is yes from
  MVP day one.
- The `pangolin-mcp` surface includes `pangolin_dispatch_cancel` as a run-time
  tool (§4.6), giving orchestrator LLMs an operational primitive for
  recovering from their own bad dispatches.

What becomes harder:

- The MVP scope grew by a small but non-zero amount. Three packages
  (`pangolin-core`, `pangolin-client`, `pangolin-worker`) plus each compute
  provider implementation now have a `cancel` / `stop` path to test
  and maintain.
- Cancellation semantics are best-effort, which means integrator code
  must not assume `dispatch.cancelled` always fires after a `cancel()`
  call. Documentation has to be explicit about this; otherwise
  integrators write code that hangs waiting for an event that may never
  arrive.

Trade-offs:

- We pay one to two days of MVP implementation cost in exchange for the
  audit-trail benefits and the cleaner operational story with regulated
  buyers. The alternative (defer to v0.2) was cheaper in MVP but more
  expensive in the conversations the SDK has to have with its early
  integrators.
- Best-effort cancellation is a real limitation, but it's the same
  limitation every compute orchestrator has at this layer (Kubernetes,
  Nomad, Fargate, plain Docker). Pretending we can deliver
  synchronous-acknowledged cancellation would be dishonest; calling it
  best-effort matches reality.
