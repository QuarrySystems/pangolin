---
title: "ADR-0001: Package scope is @quarry-systems/pangolin-*"
description: "Pangolin Scale packages publish under the @quarry-systems/pangolin-* npm scope."
status: accepted
date: 2026-05-21
deciders: pangolin-scale-mvp-design
---

## Context

Pangolin Scale ships as a family of npm packages (`pangolin-core`, `pangolin-client`, `pangolin-worker`, `pangolin-mcp`, etc.). The package scope chosen at publication time becomes load-bearing: it appears in every `package.json`, every import statement, every published README, and every downstream integrator's lockfile. Renaming a scope after the fact is expensive (downstream churn, deprecation notices, ecosystem confusion).

Two candidates were weighed:

- `@quarry-systems/pangolin-*` — consistent with sibling Quarry Systems libraries (`@quarry-systems/bedrock-*`, `@quarry-systems/stoa-*`, etc.). Single platform story, single release pipeline, single set of contributor docs.
- `@pangolin-mcp/*` — a neutral scope, on the theory that it would make a future open-source spinout (extracting Pangolin Scale from the Quarry Systems platform) cheaper. The argument: an independent project would want an independent scope; starting there avoids the rename later.

The trade-off framing turned on whether the orthogonality principle — Pangolin Scale as a self-contained, independently-usable library — is enforced by package-scope separation or by something stronger.

## Decision

Pangolin Scale packages publish under `@quarry-systems/pangolin-*`. Per §10.1 of `docs/superpowers/specs/2026-05-21-pangolin-scale-mvp-design.md`:

> **Package scope is `@quarry-systems/pangolin-*`.** Originally weighed against `@pangolin-mcp/*` for "easier OSS spinout later." Spinouts happen when they happen regardless of npm scope; the orthogonality principle is enforced architecturally (CI allowlist on dependencies), not via separate scopes. Consistent platform story + easier release coordination + room to add `@quarry-systems/bedrock-*` and `@quarry-systems/stoa-*` alongside without scope thrash.

Orthogonality is enforced by the CI allowlist check (§8 of the spec) on the dependency graph, not by namespace separation.

## Consequences

What becomes easier:

- Release coordination: one publisher identity, one set of access tokens, one tag-and-publish flow shared with sibling Quarry Systems packages.
- Contributor onboarding: anyone already working in `@quarry-systems/*` lands in a familiar scope. No second org to join, no second set of credentials.
- Discoverability: searching npm for `@quarry-systems` surfaces the full Quarry Systems family together.
- Adding sibling packages (`@quarry-systems/bedrock-*`, `@quarry-systems/stoa-*`) without scope thrash.

What becomes harder:

- A future OSS spinout under a neutral scope (`@pangolin-mcp/*` or similar) would require a one-time rename across all packages, downstream lockfiles, and integrator imports. Mitigations: maintain the old scope as a redirect/deprecation for one major version; communicate the rename in release notes well ahead of cutover.
- Casual observers may assume Pangolin Scale is Quarry-Systems-coupled and skip evaluating it for standalone use. Counter: the README and package metadata make the orthogonality explicit, and the CI allowlist is the durable proof.

Trade-offs:

- We trade a theoretical future-rename cost for present-day consistency and release simplicity. The future rename is conditional on a spinout actually happening; the consistency benefit is paid out immediately and continuously.
