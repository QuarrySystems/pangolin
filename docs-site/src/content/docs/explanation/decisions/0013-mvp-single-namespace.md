---
title: "ADR-0013: MVP is strictly single-namespace"
description: "MVP is strictly single-namespace; no public cross-namespace addressing."
status: accepted
date: 2026-05-21
deciders: pangolin-scale-mvp-design
---

## Context

Pangolin Scale's registry is organized by namespace: every capability, subagent, env bundle, and dispatch lives under a namespace identifier. Internally, the storage URI scheme `pangolin://<namespace>/...` encodes the namespace explicitly in every path, which means the underlying storage layer is already structured to support cross-namespace addressing.

The question for MVP is whether to expose that addressing on the public API surface. Three shapes were considered:

1. **Full cross-namespace addressing.** `DispatchWork` accepts capability and subagent references in another namespace (e.g., `pangolin://platform/capabilities/lint@v3` from a dispatch inside `pangolin://team-a/`). The orchestrator can reach across namespace boundaries arbitrarily.
2. **Read-only cross-namespace primitive.** A constrained variant: dispatches can *read* artifacts from other namespaces (catalog lookups, listing) but cannot *register* into them or be *dispatched* across them. Less power than full cross-namespace, but still introduces the addressing concept publicly.
3. **No public cross-namespace surface at all.** The single-namespace boundary is total at the public API level. Integrators who want shared catalogs across namespaces handle that themselves (CI pipelines that register the same artifacts into N namespaces, manual republication, etc.).

Pressures toward shipping cross-namespace in MVP:

- The internal URI scheme already supports it; not exposing it can feel like leaving capability on the table.
- Integrators with multiple namespaces (one per team, one per environment) will plausibly want to share a common capability library.

Counter-pressures:

- Cross-namespace introduces a whole class of design questions: ACLs ("who can dispatch from namespace A using a capability from namespace B?"), versioning semantics across namespace boundaries, audit trails that span namespaces, deprecation rules, accidental coupling of namespace lifecycles. None of these has a small answer.
- §10.1's `pangolin-mcp` authentication decision — "whoever launched the server has full access to all run-time tools" — is workable precisely because the trust boundary is the host. Cross-namespace adds a second trust dimension that the MVP auth model is not equipped to express.
- §11 lists "Cross-namespace registration and addressing" as deferred out of scope. Including a read-only variant would create a confusing partial story (some cross-namespace surfaces exist, others don't) that's harder to reason about than either extreme.
- The integrator's workaround — running a CI job that registers the same artifacts into N namespaces in parallel — is well-shaped, content-hashed, and aligned with how artifacts already flow through the system.

The decision turns on whether MVP draws the namespace boundary at "internal scheme supports it, public API exposes it" or at "internal scheme supports it, public API exposes none of it."

## Decision

From §10.1 of `docs/superpowers/specs/2026-05-21-pangolin-scale-mvp-design.md`:

> **MVP is strictly single-namespace.** No public cross-namespace addressing, no read-only cross-namespace primitive. Integrators who want to share capability libraries across namespaces use a shared deploy pipeline (CI job that registers the same artifacts into N namespaces in parallel) or republish manually. The internal storage URI scheme (`pangolin://<namespace>/...`) is structured to support cross-namespace later, but the public API surfaces none of it in MVP.

In MVP:

- Every `DispatchWork` operates entirely within one namespace. The capability, subagent, and env references it carries all resolve in the same namespace as the dispatch.
- Catalog-lookup tools (`pangolin_capabilities_list`, `pangolin_subagents_list`, `pangolin_envs_list`) return only the current namespace's artifacts.
- The internal storage URI scheme remains `pangolin://<namespace>/...` — structurally ready for cross-namespace to be added in v0.2+ — but no public API accepts or returns a cross-namespace URI.

Integrators who legitimately need shared catalogs:

- Set up a shared deploy pipeline (CI job that registers identical artifacts — same content hash, same name, same version — into N namespaces in parallel).
- Or republish manually when artifacts change.

Both approaches keep each namespace self-contained from Pangolin Scale's perspective; coordination happens upstream in the integrator's CI / release flow.

## Consequences

What stays bounded:

- The MVP authorization model — "host launching the pangolin-mcp server has full access to all artifacts in that namespace" — is internally consistent. No cross-namespace ACL is needed because no cross-namespace access exists.
- Catalog listings, dispatch records, and audit logs scope cleanly to one namespace. Operators reasoning about "what artifacts are reachable from here" get a single, finite answer.
- Each namespace's lifecycle (capability versions, subagent registrations, env rotations) is independent. A change in one namespace cannot accidentally invalidate dispatches in another.
- The MCP tool surface stays small and uniform. No tools need a "cross-namespace" mode flag, no responses need namespace-prefixed entries.

What integrators carry instead:

- Multi-namespace catalog sharing is handled by a CI pipeline that registers the same artifacts into each target namespace in parallel. The pipeline produces one set of artifacts (content-hashed, named, versioned) and routes them to N namespaces.
- Manual republication is the escape hatch for ad-hoc cases. It's tedious and error-prone for large catalogs; the CI-pipeline pattern is the recommended approach for any non-trivial multi-namespace deployment.
- Integrators with very few namespaces (one production, one staging) may find the CI-pipeline approach overkill and accept duplicate manual registrations. That trade-off is theirs to make.

What v0.2+ preserves the option for:

- The internal URI scheme already includes the namespace segment, so adding cross-namespace addressing later is a public-API addition, not an internal-layout migration.
- When cross-namespace is added, it can be added under a coherent authorization model (per-namespace ACLs, cross-namespace permission grants) rather than retrofitted onto a surface that was designed to assume single-namespace access.
- Read-only cross-namespace (catalog discovery without dispatch) and full cross-namespace (dispatch across boundaries) can be introduced as separate, independently-decidable capabilities at that time. Neither is locked in or out by the MVP shape.

Trade-offs:

- Integrators with multi-namespace setups pay an upfront cost (build or maintain a deploy pipeline) that a richer MVP API could have absorbed. The cost lands in their CI infrastructure, which is where multi-environment coordination already lives.
- Postponing the cross-namespace design decision is itself the win: any choice made now would be made without the operational evidence that comes from running MVP in real integrator environments. v0.2+ gets to make the call with data.
