---
title: "ADR-0006: pangolin-mcp authentication is 'whoever launched the server'"
description: "pangolin-mcp authentication is 'whoever launched the server'; host-level IAM is the trust boundary."
status: accepted
date: 2026-05-21
deciders: pangolin-scale-mvp-design
---

## Context

The `pangolin-mcp` stdio server exposes the six run-time tools from §4.6 to any
MCP client that can talk to it. The question is what authentication and
authorization model pangolin-mcp itself should enforce: per-call auth, per-
orchestrator scoping, granular ACLs (e.g., "this orchestrator can only
dispatch with the `code-reviewer` subagent"), or none of the above.

The forces in tension:

- **Construction-buyer demo and most early integrations** run one
  orchestrator process on a host the integrator already controls. The
  integrator's host-IAM story (filesystem permissions, container orchestration
  policy, IAM credentials available to the launching process) already
  determines who can run what on that host.
- **Adding per-call auth in MVP** means inventing a token scheme, a
  configuration surface for issuing/rotating tokens, an enforcement layer in
  every MCP tool handler, and an audit story for failed-auth events.
  Substantial scope.
- **Hosted or multi-tenant Pangolin Scale** absolutely needs more — per-call auth,
  per-orchestrator scoping, ACLs. But that is not an MVP shape; the MVP is
  single-namespace and assumes the integrator owns the host the orchestrator
  runs on (§10.1 single-namespace decision, ADR-0004).

The decision is whether to ship a half-built auth layer in MVP that hosted-
tenancy will rewrite anyway, or to declare the trust boundary explicitly and
push the authentication concern to the layer that already owns it.

## Decision

From §10.1:

> **`pangolin-mcp` authentication is "whoever launched the server."** There is
> no per-call authentication, no per-orchestrator scoping, no granular
> MCP-level ACL. Anyone who can launch the pangolin-mcp stdio server (typically
> by virtue of being able to run a process on the host) has full access to
> all six run-time tools and can dispatch against any artifact in the
> registry. Limiting who can launch the MCP server is the integrator's IAM
> concern — controlled by host filesystem permissions, container
> orchestration policy, and the IAM credentials available to the launching
> process. The orchestrator's environment IS the trust boundary. Per-call
> auth, per-orchestrator scoping, and granular MCP-level ACLs (e.g., "this
> orchestrator can only dispatch with the `code-reviewer` subagent") are all
> v0.2+. For the construction-buyer demo and most early integrations,
> host-IAM scoping is sufficient; for hosted or multi-tenant Pangolin Scale, more is
> required.

The host's IAM is the trust boundary. pangolin-mcp does not authenticate; it
authorizes by virtue of having been launched at all.

## Consequences

- MVP integrators get a small, predictable surface: launch the server,
  every connected MCP client has full run-time access. No token plumbing,
  no per-call configuration.
- The threat model is explicit: if an attacker can run a process as the
  user/role that launched pangolin-mcp, they can dispatch arbitrary workers
  against the registry. The mitigations are at the OS / container /
  cloud-IAM layer, not in Pangolin Scale.
- Multi-tenant or hosted Pangolin Scale deployments cannot use MVP pangolin-mcp as-is.
  This is a deliberate non-goal of MVP; hosted tenancy is v0.2+ and will
  introduce per-call auth, scoping, and ACLs at that time.
- The deploy-time / run-time split (ADR-0005) still holds: even with full
  run-time access, an attacker cannot register new capabilities, subagents,
  or env bundles through pangolin-mcp. The blast radius is "dispatch using
  artifacts a human already registered," which is bounded by the
  pre-provisioned catalog.
- Documentation must call this out loudly. Integrators who assume
  "MCP server means authenticated server" will be surprised; the README and
  pangolin-mcp package docs should state the trust-boundary contract in the
  first screen of content.
