---
title: "ADR-0015: Capability size cap is 50 MiB, rejected at register() time"
description: "Capability size cap is 50 MiB, rejected synchronously at register() time."
status: accepted
date: 2026-05-21
deciders: pangolin-scale-mvp-design
---

## Context

A capability bundle is a `Record<string, Uint8Array | string>` of paths to
contents that overlay onto the worker filesystem (§4.1.1). There is no
syntactic upper bound — integrators can technically pass a 5 GiB
`Uint8Array`. Two failure modes follow from unbounded sizes:

- **Storage and transfer cost.** Capability content is stored
  content-addressed in the configured `StorageProvider` (S3 in the MVP
  reference deployment, §5.3) and fetched by every worker that uses it.
  Multi-hundred-MiB capabilities turn every dispatch into a slow,
  expensive pull.
- **Wrong-shape packaging.** Capabilities that grow past tens of megabytes
  are almost always packaging the wrong thing: model weights, vendor
  binaries, fat npm node_modules trees, large datasets. Those belong
  somewhere else — fetched at runtime from object storage, installed from
  a package registry, mounted as a volume — not baked into a
  content-hashed capability bundle that every dispatch re-fetches.

The earlier alternative ("warn at 10 MiB, hard-cap at some larger number")
adds a soft-warning tier that doesn't exist anywhere else in the SDK's
shape. Soft warnings either get ignored or escalate into hard errors
later; the MVP picks the hard ceiling and skips the warning tier.

Where the cap is enforced matters too. A late check (at dispatch time, or
inside the worker after fetch) wastes the integrator's storage budget and
delays the failure signal. An early check (at `register()`, before any
content is uploaded) gives the integrator a synchronous error at the only
moment they can do something about it without losing work.

## Decision

From §10.1 of `docs/superpowers/specs/2026-05-21-agora-mvp-design.md`:

> **Capability size cap is 50 MiB, rejected at `register()` time.** Above
> this, integrators are probably packaging the wrong thing (model files,
> vendor binaries, fat library bundles); those should be fetched at runtime
> via `pangolin-setup.sh`, not baked into the capability. No soft-warning tier
> in MVP (e.g., warn above 10 MiB); add one in v0.2 if integrators
> consistently hit unintentional bloat.

The cap is the sum of all `files` values in a single
`capabilities.register()` call. The SDK measures the total before staging
any content and throws `CapabilityTooLargeError` if the total exceeds
50 MiB. No partial upload, no async failure, no worker-time surprise.

The escape hatch is the existing `pangolin-setup.sh` mechanism (§6.3): a
capability ships a small setup script that fetches the large payload from
the integrator's chosen storage at dispatch time. The capability bundle
stays small (the script, configuration, and any small static assets);
the heavy content is pulled into the workspace once the worker has
resolved env vars and can authenticate against the integrator's storage.

## Consequences

What becomes easier:

- Capability registration is fast and bounded. The SDK can hash, stage,
  and confirm the registration inside a single short request.
- Workers fetch capabilities quickly. Cold-start dispatch latency stays
  predictable when every bundle is under 50 MiB.
- Integrators who exceed the cap get a synchronous, descriptive error at
  the call site, not a buried failure inside a dispatch they paid for.
- The "what is a capability?" conceptual model stays sharp: capabilities
  carry the *definitions* of what the worker can do, not the bulk
  artifacts those definitions reference.

What becomes harder:

- Use cases that genuinely need large embedded assets (a baked-in model
  weight file, a large reference corpus, a vendored binary) cannot ship
  the asset inside the capability. Integrators write a `pangolin-setup.sh`
  that pulls the asset at runtime, accepting one additional network hop
  per cold dispatch in exchange for the smaller capability bundle.
- There is no soft-warning tier. Integrators may bloat capabilities up to
  49 MiB without any signal that they're approaching a problem. The MVP
  treats this as acceptable; v0.2 may add a warning threshold (e.g., warn
  above 10 MiB) if integrators consistently hit the cap unintentionally.

Trade-offs:

- We pay one additional indirection (`pangolin-setup.sh` pulling large
  assets) on dispatches that need bulk content, in exchange for keeping
  the capability registration surface fast and the storage backend cheap.
- The 50 MiB number is a deliberate over-shoot of typical capability
  sizes (kilobytes to single-digit MiB) and a deliberate under-shoot of
  bulk-asset sizes (hundreds of MiB to GiB). The gap is wide enough that
  the cap rarely surprises capability authors and effectively blocks the
  wrong-shape packaging cases.
