---
title: "ADR-0004: Lifecycle event vocabulary is closed at six, extensible at minor versions"
description: "Lifecycle event vocabulary is closed at six kinds for MVP and extensible at minor versions."
status: accepted
date: 2026-05-21
deciders: pangolin-scale-mvp-design
---

## Context

Pangolin Scale emits lifecycle events for each dispatch (`dispatch.started`, `dispatch.finished`, etc.). These events flow to integrator-supplied telemetry hooks and downstream channels (ChannelAdapter implementations, notification routers, audit logs). The shape of the event vocabulary affects two distinct populations:

- **Event producers** (the worker, the SDK, the MCP layer): need a stable, documented set of event kinds they are permitted to emit so that downstream consumers can rely on the contract.
- **Event consumers** (integrator telemetry hooks, channel adapters, notification routers): need to handle every event kind they receive, and must not break when new kinds are introduced over time.

An earlier revision of the spec committed to a five-event closed vocabulary. During the design pass that produced the MVP spec, a sixth event (`dispatch.needs_input`) was identified as architecturally necessary: squeezing the sub-agent "needs more input" signal into `dispatch.finished` would have muddied downstream semantics (consumers would have had to inspect a sub-status field to distinguish completion from a pause-for-input). Surfacing it as a distinct event keeps the dispatch-completion semantics clean.

That experience also surfaced a more general point: the lifecycle vocabulary cannot be fully frozen at MVP. Future event kinds (potentially `dispatch.heartbeat` for long-running dispatches, `dispatch.warning` for soft failures) are foreseeable but not justified for MVP. The spec needs a forward-compatibility contract that lets new event kinds ship at minor-version boundaries without breaking existing consumers.

## Decision

The lifecycle event vocabulary is closed at six kinds for MVP and extensible at minor-version boundaries. Per §10.1 of `docs/superpowers/specs/2026-05-21-pangolin-scale-mvp-design.md`:

> **Lifecycle event vocabulary is closed at six for MVP, extensible at minor versions.** Five-event closed-vocabulary commitment retired. Sixth event (`dispatch.needs_input`) added because squeezing it into `dispatch.finished` muddied downstream semantics. Future kinds (potentially `dispatch.heartbeat`, `dispatch.warning`) reserved. Integrators implementing telemetry hooks MUST handle unknown event kinds gracefully (log + skip).

The contract has two halves:

1. MVP ships exactly six event kinds — no more, no less. Producers must not emit anything outside that set in MVP.
2. Consumers must handle unknown event kinds gracefully (log and skip). This is a hard requirement on integrator-implemented telemetry hooks and channel adapters; it is what makes future minor-version additions safe.

## Consequences

What becomes easier:

- The MVP event surface is small and fully documented; new integrators learn the full vocabulary in one sitting.
- Adding a foreseeable future event kind (e.g., `dispatch.heartbeat`) at a future minor version is non-breaking by contract: consumers that handle unknown kinds gracefully simply continue working; consumers that want the new signal opt in by handling it explicitly.
- Downstream semantics stay crisp: `dispatch.finished` means finished, not "finished-or-paused-for-input"; `dispatch.needs_input` carries its own dedicated payload shape.

What becomes harder:

- Integrators must explicitly handle the unknown-event-kind case in their telemetry hooks. Failing to do so makes them fragile against any future minor-version event addition. Mitigation: the contract is documented in the spec and called out in integrator-facing guides; a reference telemetry-hook implementation includes the log-and-skip pattern.
- The producer side must enforce the closed vocabulary in MVP: emitting a seventh kind in v0.1 would silently corrupt the contract. Mitigation: event-kind constants live in a single exported enum in `pangolin-core`; producers reference the enum rather than open-coding strings.
- Forward-compatibility means the vocabulary will grow over time, which makes the integrator-facing contract slightly less stable than a permanently-frozen vocabulary would be. This is the cost of admitting up front that we do not know every future event need.

Trade-offs:

- We trade vocabulary immutability for honest forward compatibility. A permanently-frozen six-event vocabulary would be cleaner on paper but would force ugly retrofits (overloading `dispatch.finished`, repurposing existing kinds with sub-status fields) the first time a new signal becomes necessary. The lesson from retiring the five-event commitment in favor of six is that the vocabulary will need to grow; the contract should plan for that explicitly rather than pretend otherwise.
