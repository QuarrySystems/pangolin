---
title: "ADR-0010: No agora.workflow() / agora.procedure() primitive"
description: "No agora.workflow() / agora.procedure() primitive in MVP; integrators wrap dispatch() themselves. PARTIALLY SUPERSEDED by ADR-0018 — agora now ships orchestration as a separate layer."
status: superseded
superseded_by: ADR-0018
date: 2026-05-21
deciders: agora-mvp-design
---

:::caution[Partially superseded by ADR-0018]
The **narrow** decision below still holds: there is no `agora.workflow()` /
`agora.procedure()` sugar primitive on the client SDK. But this ADR's **broad
posture** — that orchestration "sits above agora, not inside it" and is "out of
scope forever," and that the MCP surface "stays at six tools" — has been reversed.
agora now ships orchestration as a separate, opt-in layer (`agora-orchestrator` /
offload), and the MCP surface is nine tools. See
[ADR-0018](/agora/explanation/decisions/0018-orchestration-ships-as-a-layer/).
The original text is preserved below as the point-in-time record.
:::

## Context

Once `dispatch()` is in integrators' hands, a natural-feeling next ask is "give me a primitive that names a pre-composed dispatch shape." A team that runs the same `{subagent, capabilities, env, notifications, timeout}` combination ten times a day starts to want something like:

```ts
const codeReview = agora.workflow({
  subagent: 'code-reviewer',
  capabilities: ['typescript-lint', 'security-scan'],
  env: 'review-creds',
  notifications: [{ channel: 'slack', ... }],
});
await codeReview.run({ pr: 1234 });
```

or a `procedure()` variant aimed at multi-step pipelines (fan-out, sequencing, conditional dispatch).

Two pressures push toward shipping such a primitive in MVP:

1. Ergonomic appeal — naming a recurring shape is satisfying and reads cleanly.
2. Anticipated demand — multiple integrators will plausibly want this once they're past hello-world.

Counter-pressures:

- Workflow primitives are an entire category of complexity: composition rules, error semantics across steps, partial-failure recovery, cancellation propagation, idempotency, retry coordination, observability across steps. The MVP `dispatch()` surface is deliberately one-shot and stateless; a workflow primitive imports state-machine concerns that the rest of the architecture has been kept free of.
- The functionality is already trivially available in user code: any integrator can wrap `dispatch()` in a function and call it a workflow. The wrapper costs five lines of TypeScript.
- §11 explicitly lists "Workflow primitives (fan-out, branching)" as out of scope forever — not just deferred — because the architectural posture is that orchestration sits *above* agora, not *inside* it.
- Shipping a workflow primitive before seeing how integrators actually compose dispatches risks locking in the wrong abstraction. The shape an SRE-facing platform team builds is materially different from what an in-application orchestrator agent builds.

The decision turns on whether agora ships the "named pre-composed dispatch" abstraction itself, or treats it as integrator-side ergonomics that emerge from observation rather than fiat.

## Decision

From §10.1 of `docs/superpowers/specs/2026-05-21-agora-mvp-design.md`:

> **No `agora.workflow()` / `agora.procedure()` primitive.** Named pre-composed dispatch templates are sugar that integrators implement as wrapper functions around `dispatch()`. Revisit in v0.2 if multiple integrators independently reinvent the wrapper.

Integrators who want named dispatch templates build them as ordinary TypeScript:

```ts
function codeReview(client: AgoraClient, pr: number) {
  return client.dispatch({
    subagent: 'code-reviewer',
    capabilities: ['typescript-lint', 'security-scan'],
    env: 'review-creds',
    notifications: [{ channel: 'slack', ... }],
    inputs: { pr },
  });
}
```

Revisit only if multiple independent integrators converge on the same wrapper shape — that is the signal that an abstraction has actually emerged in the wild and that agora is justified in canonicalizing it.

## Consequences

What stays simple:

- The `dispatch()` surface remains one-shot, stateless, and one operation. There is no second composition surface to keep coherent with it.
- Error semantics, cancellation, timeouts, and notifications have one definition (per-dispatch), not two (per-dispatch and per-workflow-step).
- The MCP run-time tool surface stays at six tools (§4.6, §5.7) — no workflow-runner tools to add, audit, or sandbox.
- The documentation surface stays small: contributors and integrators learn one primitive, not a primitive plus a composition language.

What integrators carry instead:

- Anyone who wants a named, reusable dispatch shape writes a wrapper function. This is five lines of TypeScript and lives in their codebase, where it can evolve at their pace.
- Multi-step pipelines (fan-out, sequencing, conditional dispatch) are built with ordinary control flow in integrator code, possibly leveraging their existing job/queue infrastructure. Agora doesn't try to be a workflow runner.

Future revisit conditions:

- The trigger to reopen this decision is empirical, not speculative: multiple independent integrators must each reinvent substantially the same wrapper. That is evidence of a real shared abstraction, not just an attractive idea.
- Even then, the v0.2 question is whether a thin helper (e.g., a `defineDispatch()` builder) is enough, or whether anything resembling step composition is justified. The §11 stance ("workflow primitives out of scope forever") would have to be revisited explicitly.

Trade-offs:

- Ergonomic appeal is paid out by integrators (writing the wrapper) rather than by agora (designing and maintaining the abstraction). For the MVP audience, this is the correct allocation: integrators who can use agora at all can write a five-line wrapper.
- The risk of shipping the wrong abstraction prematurely is higher than the cost of having integrators write small wrappers. Wrappers can be deleted; published primitives cannot.
