# Architecture Decision Records

This directory holds the accepted Architecture Decision Records (ADRs) for the agora MVP. The format follows Michael Nygard's "Context / Decision / Consequences" template: each ADR opens with the forces in tension, states the choice, and records the consequences (what becomes easier, what becomes harder, what trade-offs were accepted).

Each ADR is immutable once accepted. Superseding a decision means adding a new ADR that references the old one, not editing the existing file.

## Index

- [0001](0001-package-scope.md) — Agora packages publish under the `@quarry-systems/agora-*` npm scope.
- [0002](0002-dedicated-repo.md) — Agora lives in a dedicated repository, not inside an existing Quarry Systems monorepo.
- [0003](0003-runtime-adapter-seam-at-mvp.md) — The `RuntimeAdapter` interface ships in MVP with the Claude Code adapter as the sole implementation.
- [0004](0004-lifecycle-vocabulary-closed-at-six.md) — Lifecycle event vocabulary is closed at six kinds for MVP and extensible at minor versions.
- [0005](0005-privileged-ops-never-ai-reachable.md) — Privileged deploy-time operations (`register`, `assign`) are never reachable through `agora-mcp`.
- [0006](0006-agora-mcp-auth-whoever-launched.md) — `agora-mcp` authentication is "whoever launched the server"; host-level IAM is the trust boundary.
- [0007](0007-inline-secret-ttl-auto-computed.md) — Inline secret TTL is auto-computed from dispatch timeout plus a 5-minute cleanup grace.
- [0008](0008-needs-input-request-stop-restart.md) — `needs_input` uses request-stop-restart (Shape A), not in-flight ask.
- [0009](0009-needs-input-sentinel-file-vs-exit-code.md) — `needs_input` is signaled by a sentinel file at a documented path, not by an exit code.
- [0010](0010-no-workflow-primitive.md) — No `agora.workflow()` / `agora.procedure()` primitive in MVP; integrators wrap `dispatch()` themselves.
- [0011](0011-no-entrypoint-override-at-dispatch.md) — No `entrypoint` override at dispatch time; customization goes through worker images or `agora-setup.sh`.
- [0012](0012-notifications-dual-home.md) — Notifications live in two homes by design: capability content (behavior-tied) and dispatch field (operational).
- [0013](0013-mvp-single-namespace.md) — MVP is strictly single-namespace; no public cross-namespace addressing.
- [0014](0014-stdout-cap.md) — Stdout is capped at 4 MiB and stderr at 256 KiB on `DispatchResult`, with explicit truncation markers.
- [0015](0015-capability-size-cap.md) — Capability size cap is 50 MiB, rejected synchronously at `register()` time.
- [0016](0016-cancel-in-mvp.md) — `cancel()` is in MVP, not v0.2; best-effort cancellation via provider stop + worker SIGTERM trap.
- [0017](0017-source-available-bsl.md) — Agora is source-available under BSL 1.1 (no hosted-service Additional Use Grant; 4yr → Apache-2.0), superseding the earlier FSL-1.1-MIT choice.

## Source

These ADRs were extracted from §10.1 of the agora MVP design spec
(`docs/superpowers/specs/2026-05-21-agora-mvp-design.md`). That spec currently
lives outside this repo, in the author's knowledge vault, and is not vendored
here. When the spec is brought into the repo it will be linked at the relative
path above; until then, refer to each ADR's `## Decision` section, which quotes
the relevant spec passage verbatim.

## Validation

The `scripts/validate-adrs.mjs` script checks that each ADR file has the required frontmatter keys (`status`, `date`, `deciders`) and the three required H2 headings (`## Context`, `## Decision`, `## Consequences`), and that this README references every ADR file present in this directory. Run it from the repo root with `node scripts/validate-adrs.mjs`.
