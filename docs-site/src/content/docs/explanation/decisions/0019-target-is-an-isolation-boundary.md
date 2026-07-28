---
title: "ADR-0019: `target` is an isolation boundary, not a router"
description: "A dispatch target names the isolation boundary a dispatch runs inside — the compute + credentials + secretStore tuple that bounds what it can reach. Vary it when blast radius changes; pin it otherwise. It is not a scheduling hint and not an authorization check."
status: accepted
date: 2026-07-27
deciders: pangolin-consumer-roadmap-review
---

## Context

`PangolinClient` requires a `targets` registry mapping a logical name to a
`TargetConfig`:

```typescript
interface TargetConfig {
  compute: string;        // name in `compute`
  credentials: string;    // name in `credentials`
  secretStore?: string;   // name in `secretStores`
  defaultResources?: { cpu?: number; memory?: number };
}
```

Every dispatch carries a required `target: string` (`DispatchWork.target`),
resolved at fire time against this registry. The constructor validates that
every referenced provider name exists; `dispatchWork` throws on an unknown
target.

The field therefore *permits* target to vary per dispatch — but every shipped
example and every known consumer pins a single target for all dispatches. That
left the semantics undefined: nothing in the reference docs, the architecture
overview, or the threat model said what a target is *for*. Two readings were
equally available to an integrator reading only the type:

1. **A router / scheduling label** — "analysis runs go to `fast`, batch jobs go
   to `slow`," with target as a queue selector or resource-class hint.
2. **An isolation boundary** — the credential and compute envelope a dispatch
   executes inside, chosen by what the dispatch is allowed to reach.

The two readings diverge sharply in consequence. Under (1), splitting targets is
a free organizational convenience and collapsing them is a pure simplification.
Under (2), splitting targets is how you contain blast radius, and collapsing two
targets that hold different credentials silently widens what every dispatch can
reach.

The composition of `TargetConfig` settles which reading the type actually
supports: three of its four fields (`compute`, `credentials`, `secretStore`)
select *what a dispatch can reach* — where it executes, which cloud identity it
assumes, which secret material resolves for it. Only `defaultResources` is
scheduling-flavored, and it is a defaultable convenience already superseded
per-dispatch by `DispatchWork.resources`.

## Decision

**A target names the isolation boundary a dispatch runs inside.** It is the
`compute` + `credentials` + `secretStore` tuple that bounds what a dispatch can
reach, touch, and spend.

The governing rule for integrators:

> Introduce a new target when the answer to *"what could this dispatch steal or
> break?"* changes. Pin a single target otherwise.

Legitimate reasons to vary target:

- **Effect tier.** A read-only analysis dispatch and a dispatch holding
  production write credentials must not share a `credentials` or `secretStore`
  entry, even when they run the same subagent.
- **Tenancy.** Per-client or per-grant compute and secret isolation. The
  boundary a target draws must never be wider than the trust boundary it is
  standing in for.
- **Execution environment.** A dispatch needing a genuinely different
  `ComputeProvider` — a different cluster, region, or provider account.

Not a reason to vary target:

- **Scheduling or queueing convenience.** Two targets whose `compute`,
  `credentials`, and `secretStore` are all identical, differing only in label,
  draw no boundary. Concurrency and queueing are the orchestrator's concern
  (`queues`, `maxRuntimeMs`), not the target registry's.
- **Resource sizing alone.** `DispatchWork.resources` overrides
  `defaultResources` per dispatch, and a subagent shape's `imageDigest` selects
  the image. Neither requires a second target.

A target carrying the same value for every dispatch is **not dead weight**. It
is the seam that lets an integrator split a boundary later without touching call
sites, and the recorded answer to "what could this run reach?" for auditors
reading the dispatch record.

### What a target explicitly is not

`target` is **not an authorization check**. The caller chooses it freely; the
runtime validates only that the name resolves. A dispatch record's `target`
field states which envelope a dispatch ran inside — it does not attest that the
caller was permitted to select that envelope.

Authorization *is* modeled elsewhere: the `Authorizer` seam
(`AuthorizationContext` → `Authorization`) gates the orchestrator's fire path
and seals `{verdict, principal, onBehalfOf, policyRef, effectClass}` into the
dispatch manifest. But its decision inputs are `effectClass`, `actor`, and
`shapeId` — **not `target`**. Nothing gates which target a caller may select,
and the shipped `createConfigAuthorizer` rule shape has no target predicate.

Two limits follow, and integrators should hold both:

- The authorization gate runs in `pangolin-orchestrator`, not in the client
  dispatch path. An integrator calling `client.dispatch.fire()` directly
  bypasses it entirely — no verdict is evaluated and none is sealed.
- Even under the orchestrator, `actor` is caller-supplied on the submit
  envelope; the seam proves *a decision was made and sealed*, not that the
  identity it decided about was authenticated. That remains host-level IAM's
  job, consistent with
  [ADR-0006](/pangolin/explanation/decisions/0006-pangolin-mcp-auth-whoever-launched/)
  and [ADR-0013](/pangolin/explanation/decisions/0013-mvp-single-namespace/).

## Consequences

What becomes true:

- Integrators have a decision rule. "Should this run type get its own target?"
  reduces to "does it change what could be stolen or broken?" — answerable
  without reading Pangolin's internals.
- Per-`run_type` targets are a **supported topology**, not an anti-pattern, when
  the run types differ in reachable credentials or secret material. Consumers
  that route by effect tier are using the field as designed.
- A collapsed target registry becomes a reviewable claim. One target for all
  dispatches asserts that every dispatch has identical reach — true and fine for
  most single-tenant deployments, and now an explicit statement rather than an
  accident.
- Auditors reading a sealed dispatch record can interpret `target` as the
  isolation envelope, bounded by the honesty note above: it records the envelope
  selected, not an authorization to select it.

What integrators carry:

- Splitting a target is a constructor change plus a provider instance, not a
  config edit. That friction is intended — a new isolation boundary should cost
  a deliberate wiring decision.
- Because targets are constructor-wired live provider instances rather than
  content-addressed registry artifacts, they do not appear in
  `pangolin.config.yaml` and are not reconciled by `pangolin deploy`. The
  manifest registers hashable content (capabilities, subagents, envs); the
  constructor wires providers. Integrators wanting a declarative `run_type →
  target` table own that table themselves.

Trade-offs:

- Per-`run_type` targets remain a lightly-exercised path. Validation happens at
  construction and at fire time, but no shipped example runs a multi-target
  matrix, so integrators leaning on it are early users of a supported but
  untrodden topology.
- This ADR defines semantics for an existing field rather than changing
  behavior. No code changes; existing single-target deployments are unaffected
  and remain correct.
</content>
</invoke>
