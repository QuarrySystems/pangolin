---
title: "ADR-0012: Notifications live in two homes by design"
description: "Notifications live in two homes by design: capability content (behavior-tied) and dispatch field (operational)."
status: accepted
date: 2026-05-21
deciders: pangolin-scale-mvp-design
---

## Context

Notifications (HMAC-signed webhook calls fired by the worker on lifecycle events) need to be configurable. The natural design question is: where does the configuration live?

An earlier revision of the spec put notifications only in capability content — a single `pangolin-notifications.json` file shipped inside the capability bundle, defining where alerts go. That had the appeal of one home, one source of truth, no merging logic.

Two pressures pulled it apart:

1. **Capability authors and SRE teams own different concerns.** The capability author knows what the capability does and what behavior should always trigger an alert (e.g., "this capability can perform destructive operations — alert whenever it fires, regardless of who's dispatching it"). The SRE team owns where alerts for a specific operational dispatch land (PagerDuty for production, Slack for staging, internal webhook for dev). These are two different roles writing two different intents, and shoving them into the same file forces one to overwrite the other or to nest under awkward conditionals.

2. **Operational alerts depend on the dispatch context, not the capability.** A dispatch from the production orchestrator wants its alerts in the production on-call channel; the same capability dispatched from a staging job wants alerts in the staging channel. Capability content cannot know the dispatching environment without each environment registering its own capability variant — which would explode the capability namespace for an orthogonal concern.

The alternative — putting notifications only in dispatch fields — collapses the other direction: the capability author loses the ability to mandate alerts for dangerous behavior. A dispatcher could simply omit the notification block and bypass the alert that the capability author considered non-negotiable.

The decision turns on whether one-home simplicity is worth losing the role separation, or whether the redundancy is itself the feature.

## Decision

From §10.1 of `docs/superpowers/specs/2026-05-21-pangolin-scale-mvp-design.md`:

> **Notifications have two homes by design.** Capability-content notifications (`pangolin-notifications.json`) are behavior-tied — the capability author mandates alerts whenever the capability is in scope (e.g., "alert if this dangerous capability fires"). Dispatch-level notifications (`notifications: NotificationConfig[]` on `DispatchWork`) are operational — the SRE team owns where alerts for a specific dispatch go (PagerDuty, Slack, internal webhook). Both flow through the same HMAC-signing path; the worker merges both sources at boot. The redundancy is the point: two distinct concerns with two distinct homes. (This supersedes an earlier decision that put notifications only in capability content.)

Two locations, each owned by a different role:

- **Capability content** (`pangolin-notifications.json` inside the capability bundle). Authored by the capability author. Travels with the capability. Content-hashed with the rest of the bundle. The capability author uses this for alerts that are intrinsic to the capability's behavior — "this capability is dangerous; always notify."
- **Dispatch field** (`notifications: NotificationConfig[]` on `DispatchWork`). Set by the dispatcher, typically populated from the integrator's environment configuration. The SRE team uses this for operational routing — where the on-call team for this dispatch wants its alerts.

The worker merges both sources at boot. Both flow through the same HMAC-signing path, so subscribers see one notification stream with consistent integrity guarantees regardless of which home contributed a given entry.

## Consequences

What stays clean:

- Each role writes in its own home. Capability authors don't have to know about the integrator's PagerDuty setup; SRE teams don't have to know which capabilities the orchestrator might pick.
- The capability author's mandates survive dispatch-level configuration. A dispatcher cannot accidentally (or deliberately) suppress an alert that the capability author specified.
- Operational routing changes per environment, per team, per on-call rotation without re-publishing capabilities. The SRE team edits dispatch-side config and ships immediately.
- Subscribers receive a uniform notification stream. The two homes are an authoring concern; downstream consumers see one HMAC-signed feed.

What the worker must do:

- The worker fetches both sources during boot, merges them into a single subscriber list, and signs all outgoing notifications with the same key. The merge rule is additive: both sources contribute, neither overrides.
- Deduplication of subscribers that appear in both lists is a worker concern, not a configuration-time concern. If a capability mandates a Slack alert and the dispatch also adds the same Slack URL, the worker should not fire twice.

What redundancy buys:

- The redundancy is not a bug. It is the load-bearing property that lets two roles configure overlapping aspects of the same delivery channel without coordinating directly with each other.
- An apparent simplification — "let's just merge them into one file" — would force exactly the coordination this split avoids. Capability authors would have to know the SRE team's routing; SRE teams would have to edit capability content (or override it) to change operational routing.

Trade-offs:

- One additional config surface to document and to learn — capability-content notifications plus dispatch-field notifications. The cost is paid once at learning time; the benefit (role separation) is paid out continuously.
- The worker boot path is slightly more complex (two sources to merge, dedupe). The added complexity is local to the notification subsystem and does not propagate into the rest of the worker's responsibilities.
- If a future configuration concern develops a similar role-split pressure, the precedent set here is "two homes if the roles are genuinely distinct" — not "always pick one home for simplicity." The redundancy criterion applies case-by-case.
