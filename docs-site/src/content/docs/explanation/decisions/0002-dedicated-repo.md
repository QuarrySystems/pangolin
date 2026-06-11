---
title: "ADR-0002: Pangolin Scale lives in a dedicated repository"
description: "Pangolin Scale lives in a dedicated repository, not inside an existing Quarry Systems monorepo."
status: accepted
date: 2026-05-21
deciders: pangolin-scale-mvp-design
---

## Context

Quarry Systems hosts several libraries today, with an existing Nx-managed monorepo for the platform's primary applications. A future `quarry-systems-platform` reference-orchestrator repo is also on the roadmap. Three plausible homes for Pangolin Scale existed:

1. **Inside the existing Quarry Systems Nx monorepo**, as another app or package. Cheap to start; shared tooling, shared CI, shared release infrastructure.
2. **Inside a future `quarry-systems-platform` repo**, as a sibling of the reference orchestrator that consumes it. Tight feedback loop between Pangolin Scale and its largest internal consumer.
3. **In a dedicated repository** of its own.

Pangolin Scale's defining architectural commitment is orthogonality: Pangolin Scale knows nothing about its consumers, and consumers know nothing about Pangolin Scale's internals beyond the public SDK surface. The spec spends considerable effort defending this (no consumer-specific assumptions in the worker, no shared types leaking out of `pangolin-core`, a CI allowlist that pins the legal dependency graph).

Physical co-location with other Quarry Systems code is not the same threat as code-level coupling — but it is a continuous source of pressure toward coupling. Shared `tsconfig` fragments, shared lint configs, shared utility modules, shared test helpers, and shared release scripts all tend to drift into cross-references over time. The CI allowlist catches dependency-level coupling, but it does not catch a shared `scripts/` directory or a shared `tools/` package that quietly accumulates Pangolin Scale-specific knowledge.

## Decision

Pangolin Scale lives in its own repository. Per §10.1 of `docs/superpowers/specs/2026-05-21-pangolin-scale-mvp-design.md`:

> **Dedicated repo.** Pangolin Scale lives in its own repo, not as another Nx app inside the existing `quarry-systems` monorepo and not inside a future `quarry-systems-platform` reference-orchestrator repo. Rationale: the orthogonality principle is enforced more durably when physical proximity to other Quarry Systems libraries can't introduce accidental coupling. The CI allowlist check (§8) catches dependency-level coupling; repo separation catches everything else (shared scripts, shared tsconfig fragments, shared utilities that drift into cross-references).

## Consequences

What becomes easier:

- Orthogonality is enforced at the strongest possible layer: there is literally no shared filesystem with other Quarry Systems projects. Accidental coupling cannot happen via a shared `scripts/` or `tools/` directory because there is none.
- Releases and versioning are decoupled from any other project's release cadence.
- Issues, PRs, branches, and contributor activity are all scoped to Pangolin Scale; the issue tracker is not polluted by unrelated work.
- A future OSS donation or hand-off is a repo transfer, not a multi-month extraction project.
- External contributors (including non-Quarry-Systems collaborators) can land changes without needing visibility into unrelated internal code.

What becomes harder:

- Cross-cutting refactors that touch Pangolin Scale and a consumer simultaneously require coordinated PRs across two repos. Mitigation: the pangolin-client SDK surface is the contract; cross-repo changes only happen at the SDK boundary, which is intentionally narrow.
- Shared tooling (lint config, tsconfig, release scripts) is duplicated rather than imported. Mitigation: this is a small, slow-changing surface; periodic manual reconciliation is cheaper than the coupling it would otherwise re-introduce.
- Dependency upgrades (pnpm, TypeScript, Node) are coordinated by hand across repos rather than by a single monorepo bump.

Trade-offs:

- We accept duplicated tooling and cross-repo coordination overhead in exchange for a structural guarantee that Pangolin Scale cannot accidentally bind to internals of other Quarry Systems code. The orthogonality principle is the product's biggest long-term asset; physical separation defends it more durably than any process or lint rule.
