---
title: Decision records
description: The accepted Architecture Decision Records (ADRs) for Pangolin Scale — each records the forces in tension, the choice made, and its consequences.
---

This section holds the accepted Architecture Decision Records (ADRs) for Pangolin Scale.
The format follows Michael Nygard's "Context / Decision / Consequences" template:
each ADR opens with the forces in tension, states the choice, and records the
consequences (what becomes easier, what becomes harder, what trade-offs were
accepted).

Each ADR is immutable once accepted. Superseding a decision means adding a new
ADR that references the old one, not editing the existing file.

## Index

- [0001](/pangolin/explanation/decisions/0001-package-scope/) — Pangolin Scale packages publish under the `@quarry-systems/pangolin-*` npm scope.
- [0002](/pangolin/explanation/decisions/0002-dedicated-repo/) — Pangolin Scale lives in a dedicated repository, not inside an existing Quarry Systems monorepo.
- [0003](/pangolin/explanation/decisions/0003-runtime-adapter-seam-at-mvp/) — The `RuntimeAdapter` interface ships in MVP with the Claude Code adapter as the sole implementation.
- [0004](/pangolin/explanation/decisions/0004-lifecycle-vocabulary-closed-at-six/) — Lifecycle event vocabulary is closed at six kinds for MVP and extensible at minor versions.
- [0005](/pangolin/explanation/decisions/0005-privileged-ops-never-ai-reachable/) — Privileged deploy-time operations (`register`, `assign`) are never reachable through `pangolin-mcp`.
- [0006](/pangolin/explanation/decisions/0006-pangolin-mcp-auth-whoever-launched/) — `pangolin-mcp` authentication is "whoever launched the server"; host-level IAM is the trust boundary.
- [0007](/pangolin/explanation/decisions/0007-inline-secret-ttl-auto-computed/) — Inline secret TTL is auto-computed from dispatch timeout plus a 5-minute cleanup grace.
- [0008](/pangolin/explanation/decisions/0008-needs-input-request-stop-restart/) — `needs_input` uses request-stop-restart (Shape A), not in-flight ask.
- [0009](/pangolin/explanation/decisions/0009-needs-input-sentinel-file-vs-exit-code/) — `needs_input` is signaled by a sentinel file at a documented path, not by an exit code.
- [0010](/pangolin/explanation/decisions/0010-no-workflow-primitive/) — No `pangolin.workflow()` / `pangolin.procedure()` primitive in MVP; integrators wrap `dispatch()` themselves. **(Partially superseded by [0018](/pangolin/explanation/decisions/0018-orchestration-ships-as-a-layer/).)**
- [0011](/pangolin/explanation/decisions/0011-no-entrypoint-override-at-dispatch/) — No `entrypoint` override at dispatch time; customization goes through worker images or `pangolin-setup.sh`.
- [0012](/pangolin/explanation/decisions/0012-notifications-dual-home/) — Notifications live in two homes by design: capability content (behavior-tied) and dispatch field (operational).
- [0013](/pangolin/explanation/decisions/0013-mvp-single-namespace/) — MVP is strictly single-namespace; no public cross-namespace addressing.
- [0014](/pangolin/explanation/decisions/0014-stdout-cap/) — Stdout is capped at 4 MiB and stderr at 256 KiB on `DispatchResult`, with explicit truncation markers.
- [0015](/pangolin/explanation/decisions/0015-capability-size-cap/) — Capability size cap is 50 MiB, rejected synchronously at `register()` time.
- [0016](/pangolin/explanation/decisions/0016-cancel-in-mvp/) — `cancel()` is in MVP, not v0.2; best-effort cancellation via provider stop + worker SIGTERM trap.
- [0017](/pangolin/explanation/decisions/0017-source-available-bsl/) — Pangolin Scale is source-available under BSL 1.1 (no hosted-service Additional Use Grant; 4yr → Apache-2.0), superseding the earlier FSL-1.1-MIT choice.
- [0018](/pangolin/explanation/decisions/0018-orchestration-ships-as-a-layer/) — Pangolin Scale ships orchestration as a separate opt-in layer (`pangolin-orchestrator` / offload), partially superseding ADR-0010's "orchestration only above Pangolin Scale / out of scope forever" posture. The client-SDK workflow-primitive rejection still stands.

## Source

These ADRs were extracted from §10.1 of the Pangolin Scale MVP design spec
(`docs/superpowers/specs/2026-05-21-pangolin-scale-mvp-design.md`). Each ADR's `## Decision`
section quotes the relevant spec passage verbatim.
</content>
