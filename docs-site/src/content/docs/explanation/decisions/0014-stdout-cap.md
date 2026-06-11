---
title: "ADR-0014: Stdout capped at 4 MiB, stderr at 256 KiB, with explicit truncation markers"
description: "Stdout is capped at 4 MiB and stderr at 256 KiB on DispatchResult, with explicit truncation markers."
status: accepted
date: 2026-05-21
deciders: pangolin-scale-mvp-design
---

## Context

The worker captures the sub-agent's stdout and stderr and returns them on the
`DispatchResult` object (`stdout: string`, `stderr: string`, §4.2). Two
opposing forces apply:

- **Bigger caps** let integrators see the full output without round-tripping
  to the compute provider's log stream. Agentic outputs are not small:
  multi-file syntheses, long-form code reviews, and "explain this codebase"
  reports routinely exceed a megabyte once verbose tool calls and embedded
  file contents are included.
- **Smaller caps** keep `DispatchResult` payloads cheap to ship over the
  callback wire, cheap to retain in the dispatch record, and cheap to render
  in MCP tool responses (where the entire result has to fit in an
  orchestrator's context window).

The prior revision of the spec proposed a 1 MiB stdout cap. Field experience
with realistic agentic dispatches showed 1 MiB clipped useful outputs in the
median case, not just in pathological tail cases — large enough to be wrong,
small enough to feel arbitrary.

A second concern: silent truncation is worse than visible truncation. A
consumer reading `result.stdout` has no way to tell whether the string
represents the whole output or only the leading portion, unless the
truncation is marked.

Stderr has a different shape from stdout. It carries diagnostic noise, not
deliverables; the upper end of realistic stderr volume (verbose tool-call
logging, deprecation warnings, lifecycle banners) is one or two orders of
magnitude below stdout. A separate, smaller cap matches the data better than
forcing both streams under the same ceiling.

## Decision

From §10.1 of `docs/superpowers/specs/2026-05-21-pangolin-scale-mvp-design.md`:

> **Stdout capped at 4 MiB, stderr at 256 KiB, with explicit truncation
> markers.** 1 MiB stdout was too tight for typical agentic outputs
> (multi-file syntheses, long-form reports). 4 MiB covers virtually all
> reasonable cases while keeping `DispatchResult` payloads manageable.
> Truncation appends a clear marker so consumers see the truncation rather
> than silently believing the output was complete. The compute provider's
> full log stream is unaffected — the cap is only on the in-memory
> `DispatchResult`.

The cap is enforced at `DispatchResult` construction time. When either
stream exceeds its ceiling, the worker truncates to the cap boundary and
appends a clear marker so the consumer sees the truncation explicitly. The
compute provider's full log stream (CloudWatch Logs, container stdout,
etc.) is untouched — integrators who need the full output without rebuilding
the worker can fetch it from the provider's log backend.

## Consequences

What becomes easier:

- Typical agentic outputs — multi-file syntheses, long-form reports, code
  reviews of several files — fit inside the cap without truncation. The
  "did my output get clipped?" question rarely arises in practice.
- `DispatchResult` payloads remain bounded. Callback POSTs, dispatch record
  retention, and MCP tool responses all stay within a predictable size
  envelope (low single-digit MiB worst case).
- Stderr stays small enough to be displayed inline in CLI tooling and MCP
  responses without paging or chunking.
- Truncation is honest. Consumers that see the marker know to fetch the
  full log stream from the compute provider if they need everything.

What becomes harder:

- Integrators who genuinely need outputs above 4 MiB (rare; usually a sign
  the sub-agent is dumping file contents inline rather than writing to
  workspace) must fetch from the provider's log backend, not from
  `DispatchResult`. The escape hatch exists but is not as ergonomic as
  reading the field directly.
- The truncation marker is part of the wire contract. Tooling that parses
  `stdout` (rare — the field is meant for humans) must tolerate the marker
  appearing at the end of any sufficiently long output.

Trade-offs:

- We pay a 4 MiB worst-case ceiling on result payloads in exchange for the
  median dispatch returning a complete, parse-free output. The alternative
  — a smaller cap with frequent truncation, or no cap with unbounded
  payloads — was worse on either ergonomics or operational safety.
- The 4 MiB and 256 KiB numbers are not magic. They were chosen as
  "comfortably above observed p99 of realistic dispatches" while staying
  below thresholds that strain HTTP callback delivery and dispatch-record
  storage. If integrators consistently hit the cap, revisit in v0.2 rather
  than treating the numbers as load-bearing.
