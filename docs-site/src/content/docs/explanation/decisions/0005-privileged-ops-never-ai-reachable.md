---
title: "ADR-0005: Privileged operations are never reachable through an AI tool surface"
description: "Privileged deploy-time operations (register, assign) are never reachable through pangolin-mcp."
status: accepted
date: 2026-05-21
deciders: pangolin-scale-mvp-design
---

## Context

The Pangolin Scale SDK splits its operations into two classes: deploy-time operations that
create or modify executable artifacts (capabilities, subagents, env bundles), and
run-time operations that compose existing artifacts into dispatches. The question
is whether the deploy-time operations — `capabilities.register()`,
`subagent.register()` / `assign()`, and `env.register()` — should be exposed
through the `pangolin-mcp` server alongside the run-time operations.

Exposing them would be ergonomic: an orchestrator LLM could provision its own
capabilities and subagents on demand. But three distinct prompt-injection risks
apply, and each one is sufficient on its own to keep the surface out of the AI
loop:

1. **Prompt injection on capability content.** An AI agent that can register
   capabilities can be tricked (via repo content, document text, or other
   reasoning-context contamination) into registering a capability that allows
   dangerous bash patterns, configures a malicious MCP server, or runs an
   attacker-controlled setup script. The capability defines the worker's
   authority surface; that authority is set by humans (or human-reviewed CI),
   not by LLMs.

2. **Prompt injection on subagent prompts.** A registered subagent's system
   prompt becomes the instruction set every dispatched worker runs. An AI
   registering a subagent could embed injection payloads that propagate to
   every future dispatch using that subagent.

3. **Secret exfiltration on env registration.** Even if the SDK redacts secret
   values in tool-call output, the LLM saw them at register time. Tool-call
   payloads land in conversation history, transcripts, model logs. The risk is
   unavoidable if `env.register()` is AI-reachable.

The underlying principle, stated once (§7.7): anything that defines what a
worker IS, what it CAN DO, or what it has access to is set by humans (or
human-reviewed CI). Anything that composes existing artifacts at run-time can
be set by orchestrators (human or AI). The three risks above are
illustrations of the same principle, not three independent rules.

## Decision

From §10.1:

> **Privileged operations are never reachable through `pangolin-mcp`.**
> `capabilities.register()`, `subagent.register()` / `assign()`, and
> `env.register()` are CLI- and TypeScript-only. The MCP surface exposes only
> run-time, orchestration-safe operations (dispatch + read-only catalog
> lookups). Rationale: prompt injection on capability content or subagent
> prompts is as dangerous as secret exfiltration on env; the entire
> artifact-creation surface stays out of the AI loop. See §7.7. This is the
> AWS IAM pattern: workloads reference pre-provisioned artifacts, not create
> them.

The orchestrator agent's role is **composition over an existing catalog**, not
catalog mutation. It picks subagents and capabilities by name, dispatches
workers, observes results. The catalog is pre-provisioned by humans or CI
pipelines (deploy manifest from §4.5).

This pattern mirrors the AWS IAM model: lambdas don't create their own
execution roles; an admin provisions roles and lambdas reference them. The
Pangolin Scale pattern is the same — artifacts are provisioned, dispatches reference
them.

The enforcement is **architectural, not policy**. A CI step (§9, end-to-end
test 14) runs the pangolin-mcp server in test mode, dumps its exposed tool
names, and asserts the set equals exactly the six run-time tool names from
§4.6: `{pangolin_dispatch, pangolin_dispatch_describe, pangolin_dispatch_cancel,
pangolin_capabilities_list, pangolin_subagents_list, pangolin_envs_list}`. Any
addition is a CI failure. Any tool name matching `pangolin_*_register` or
`pangolin_*_assign` is a CI failure regardless of intent. Without this check
the security boundary would be policy, not architecture, and policy decays
as code evolves.

## Consequences

- Orchestrator agents cannot bootstrap new capabilities or subagents on
  demand. A human (or human-reviewed CI pipeline via the `pangolin-manifest.yaml`
  reconciler) must provision the catalog before any dispatch can use it.
- The `pangolin-mcp` tool surface is small and stable: six run-time tools, period.
  Future additions go through human review of this decision.
- Integrators who want self-modifying orchestration workflows are blocked at
  the MCP boundary by design. The escape hatch is to write a TypeScript
  orchestrator that uses `pangolin-client` directly — which means a human wrote
  the orchestration code, which is the trust model we want.
- The CI allowlist check is load-bearing. If it ever regresses, the security
  boundary collapses silently. Treat that test as a tier-1 invariant.
- Auditors reading the Pangolin Scale codebase can verify the boundary by inspecting
  one file (the pangolin-mcp tool registration) plus the CI check. The proof is
  local and shallow, not "read the whole codebase and convince yourself."
