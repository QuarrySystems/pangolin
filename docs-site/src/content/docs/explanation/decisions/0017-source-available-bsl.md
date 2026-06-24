---
title: "ADR-0017: Pangolin Scale is source-available under BSL 1.1 (superseding FSL-1.1-MIT)"
description: "Pangolin Scale is source-available under BSL 1.1 (no hosted-service grant; 4yr to Apache-2.0), superseding the earlier FSL-1.1-MIT choice."
status: accepted
date: 2026-06-01
deciders: pangolin-offload-v1-design
---

## Context

The repository was first licensed under the **Functional Source License 1.1,
MIT Future License (`FSL-1.1-MIT`)** — committed 2026-05-22 per the Pangolin Scale MVP
spec. FSL is source-available: it forbids any **"Competing Use"** and converts
each version to the permissive **MIT** license two years after release.

The offload V1 delivery spec
(`docs/superpowers/specs/2026-05-29-agora-offload-v1-design.md`, decision V1-D2)
revisited the license as part of productizing the offload stack and chose the
**Business Source License 1.1 (`BUSL-1.1` SPDX)** instead. The two specs
therefore disagreed, and the `offload-launch` wave is where §8 of the V1 spec
turns license choice into shipped packaging — forcing the question to be
settled in one direction.

The decision turns on **adoption friction** for the users V1 targets:
self-hosters and security/compliance-conscious teams running agents against
their own repos, credentials, and (self-hosted) regulated data.

- FSL's **"Competing Use"** restriction is broad and somewhat fuzzy. A company
  with an internal agent platform has to stop and ask "is this a competing
  use?" — and that hesitation is exactly where an evaluation stalls.
- BSL's restriction is **narrow and explicit**: you author an Additional Use
  Grant, and ours forbids only *offering Pangolin Scale (or a derivative) as a hosted or
  managed orchestration / agent-dispatch service*. A team evaluating Pangolin Scale to
  run their own agents reads that and immediately knows they're clear.
- BSL is the **recognized incumbent** (MariaDB, CockroachDB, Sentry-then,
  HashiCorp) — lower legal-review friction than the newer FSL.
- BSL's "no hosted service" line **maps onto the architecture already built**:
  the §10.6 `client`/`service` privilege split is the commercial boundary, and
  the future hosted multi-tenant control plane is the `service` side.

Nothing is published yet (`private: true`, `version: 0.0.0`), so this is a clean
swap with no relicensing of shipped artifacts.

## Decision

Pangolin Scale is **source-available under the Business Source License 1.1**, superseding
the earlier FSL-1.1-MIT choice. Parameters (`LICENSE`, with the canonical BSL
terms incorporated by reference to <https://mariadb.com/bsl11/> to avoid
reproducing the copyrighted template verbatim):

- **Licensor:** Quarry Systems.
- **Licensed Work:** Pangolin Scale (this repository).
- **Additional Use Grant:** all use permitted *except* offering Pangolin Scale, or a
  derivative, to third parties as a hosted or managed orchestration /
  agent-dispatch service.
- **Change Date:** 2030-06-01 (four years from first publish; the date in
  `LICENSE` is authoritative and advances with major releases).
- **Change License:** Apache License, Version 2.0.

`"license": "BUSL-1.1"` is set on the root and every workspace `package.json`; a
plain-language summary lives in `LICENSING.md`. All public copy says
**"source-available (BSL)"** — never "open source" (BSL is not OSI-approved).

## Consequences

What becomes easier:

- Self-host adoption: the one restriction is explicit and narrow, so an
  evaluating team (and its lawyers) can clear it quickly. The self-host
  compliance story (regulated data never leaves the customer's account) is
  unobstructed because production self-host use is plainly permitted.
- Commercial clarity: "self-host everything; we monetize only the hosted
  control plane" is a clean, honest story that matches the §10.6 split.
- Familiarity: reviewers have seen BSL before; less friction than FSL.

What becomes harder:

- Less aggressive competitive protection than FSL: BSL (with our grant) lets
  others build competing tooling, forbidding only reselling Pangolin Scale *itself* as a
  hosted service. That breadth was FSL's edge — traded away deliberately, since
  the same breadth chills the legitimate early adopters V1 needs first.
- Longer closed horizon: 4 years → Apache-2.0, versus FSL's 2 years → MIT.

Trade-offs:

- We accept weaker anti-fork protection and a longer conversion horizon in
  exchange for the lowest adoption friction and an architecture-aligned
  commercial boundary. For an unshipped, early-stage project optimizing for
  getting real users, reducing evaluation friction beats maximizing protection.
- This ADR supersedes the FSL-1.1-MIT choice (which predated the ADR series and
  was recorded only in the MVP spec + the `8e33e4e`/`63e34b1` license commits),
  not an existing ADR.

## Addendum (2026-06-24): license stability + the self-hosted-embedding scope

A licensing audit revisited this decision. Three things settled:

**The license is frozen — do not relicense again without a concrete trigger.**
Each relicense re-triggers adopter legal review, the exact friction this ADR removed,
so license churn is itself an adoption tax (this would be the second change in a month).
Revenue protection lives in **open-core mechanics** — the closed Enterprise modules and
the hosted Cloud control plane — both already covered by the Additional Use Grant's
hosted/managed-service restriction. It does **not** depend on tightening the core grant.
Alternatives weighed and rejected for now: **Elastic License 2.0** (a sidegrade — adds
perpetual protection but loses the Apache-2.0 conversion goodwill), **PolyForm Perimeter**
(closes the embedding gap below but reintroduces FSL's fuzzy "compete" line this ADR fled),
**SSPL** (adoption-toxic, OSI-rejected, enterprise-banned), and **AGPL + commercial
dual-license** (a different model that requires the OSI "open source" branding this
project explicitly rejects).

**Scope clarified: self-hosted embedding is permitted by the current grant.** The
Additional Use Grant reserves only *offering Pangolin Scale (or a derivative) to third
parties as a hosted or managed service*. Embedding Pangolin Scale into a product a third
party **self-hosts** is **not** restricted by the current LICENSE. The public copy
(`commercial.md`, `licensing-bsl.md`) was reconciled to say so — it previously implied
self-hosted embedding required a commercial license, which the grant does not compel.
The commercial track for self-hosted embedders is a support/indemnity relationship, not
a license obligation.

**`"license": "BUSL-1.1"` is now on every workspace `package.json`**, including the
four previously-bare `private: true` packages (`docs-site`, `hello-world`,
`orchestrator-offload`, `spike/rfc3161`), making the body's "root and every workspace
`package.json`" statement literally true.

**Revisit the Additional Use Grant** (widen it, or move to PolyForm Perimeter) **only**
if a concrete trigger fires:

- a competitor ships Pangolin Scale embedded in a rival **self-hosted** product, or
- the hosted Cloud offering launches and a third party resells the engine as a competing
  hosted service in a way the current grant doesn't cleanly reach.

Until a trigger fires, the license is stable.
