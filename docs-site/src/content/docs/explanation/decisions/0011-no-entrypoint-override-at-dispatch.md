---
title: "ADR-0011: No entrypoint override at dispatch time"
description: "No entrypoint override at dispatch time; customization goes through worker images or pangolin-setup.sh."
status: accepted
date: 2026-05-21
deciders: pangolin-scale-mvp-design
---

## Context

Container platforms commonly let callers override the container's entrypoint per-invocation. Translated to Pangolin Scale, that would mean `DispatchWork` carrying an optional `entrypoint?: string[]` field that, when set, replaces the worker image's default ENTRYPOINT for that one dispatch.

Two patterns push integrators toward asking for this:

1. Per-dispatch shell wrappers — "just this once, run my script before the worker boots."
2. Per-dispatch container customization — "this dispatch needs a different binary search path / different sidecar / different setup phase."

Counter-pressures:

- The worker image is the Pangolin Scale trust root for everything below `RuntimeAdapter` (fetch, integrity verification, overlay engine, secrets, env, setup, channel, notifications, lifecycle). Overriding its entrypoint at dispatch time means a caller can replace the entire boot sequence with arbitrary commands — bypassing integrity checks, lifecycle emissions, sentinel-file conventions (§6.9), and notification setup.
- Per-dispatch entrypoint overrides are not content-addressable: there is no hash to pin, no audit trail of which override ran where, no way to reproduce a past run by replaying its artifacts. The override lives only in the dispatch call's parameters, which decay quickly.
- The two real needs the override would address are each handled by an existing, better-shaped mechanism:
  - **Container-level customization** is handled by extending the worker image. Integrators who need a custom binary, sidecar, or base image build their own worker image FROM the Pangolin Scale worker, register it once, and dispatches reference it by name. The customization is versioned with the image and audited with the image.
  - **Per-dispatch setup** is handled by `pangolin-setup.sh` inside capability content. The setup script is part of the capability bundle, content-hashed alongside the rest, fetched and verified by the worker, and executed in a documented stage of the boot sequence.

The decision turns on whether Pangolin Scale preserves "the worker image and capability bundle are the only sources of execution behavior" as an invariant, or admits a per-dispatch escape hatch that quietly erodes it.

## Decision

From §10.1 of `docs/superpowers/specs/2026-05-21-pangolin-scale-mvp-design.md`:

> **No `entrypoint` override at dispatch time.** Container-level customization is handled by extending the worker image. Per-dispatch setup is handled by `pangolin-setup.sh` content in capability bundles — versioned, content-addressable, audit-friendly. Dispatch-time entrypoint override would lose those properties.

`DispatchWork` carries no `entrypoint` field in MVP. The worker image's ENTRYPOINT is the only entry path; capability `pangolin-setup.sh` is the only per-dispatch customization seam.

Concretely:

- Integrators who want a custom container build a custom worker image (FROM the official Pangolin Scale worker, layer their additions, push to their registry, register the image once) and reference it by name in dispatches.
- Integrators who want per-dispatch setup ship that logic as part of the capability bundle's `pangolin-setup.sh`. The script is content-hashed with the rest of the capability, runs in the documented setup stage of the worker's boot sequence, and is auditable by inspecting the capability artifact.

## Consequences

What stays true:

- The worker boot sequence is fixed. Every dispatch starts in the same controlled environment: fetch artifacts, verify integrity, materialize overlays, inject secrets, source env, run setup, hand off to runtime adapter. There is no path that skips any stage.
- Every execution input is content-addressable. The worker image is pinned by digest; capability bundles are pinned by content hash. Replaying a past dispatch reproduces exactly the same inputs.
- Lifecycle emissions, sentinel-file conventions, and notification wiring are guaranteed because the worker's own entrypoint sets them up before any user-controlled code runs.
- Auditors can prove what ran in a given dispatch by reading the worker image digest + capability content hashes referenced in the dispatch record. There is no per-call parameter that can bypass the artifacts.

What integrators carry instead:

- Custom container needs become "register a custom worker image once." Heavier first-time effort than passing a one-off entrypoint, but the customization is then versioned, named, and reusable.
- Per-dispatch setup needs become "extend the capability's `pangolin-setup.sh`." Setup edits move at the cadence of capability versioning, which is the right cadence for behavior that affects every dispatch using that capability.
- One-off "just this dispatch is different" cases require either a new capability version or a new worker image. There is no shortcut. This is intended — one-off boot-behavior changes that don't justify a versioned artifact also don't justify the trust they would receive.

Trade-offs:

- We pay a small ergonomic cost — no in-line entrypoint twiddling — in exchange for the invariant that "what runs is fully described by named, content-addressed artifacts." For an architecture whose trust story rests on that invariant, the trade is correct.
- If integrators consistently hit a use case the two mechanisms don't cover well, the v0.2 question is whether a more constrained extension (e.g., a "pre-setup hook" with documented limits on what it can do) is justified — not whether to add a raw `entrypoint` override.
