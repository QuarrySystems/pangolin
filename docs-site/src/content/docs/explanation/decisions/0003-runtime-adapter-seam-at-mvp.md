---
title: "ADR-0003: RuntimeAdapter seam is introduced at MVP"
description: "The RuntimeAdapter interface ships in MVP with the Claude Code adapter as the sole implementation."
status: accepted
date: 2026-05-21
deciders: pangolin-scale-mvp-design
---

## Context

The Pangolin Scale worker runs sub-agents inside containers. In MVP, the only sub-agent runtime that ships is Claude Code. Other plausible runtimes (Codex, Gemini CLI, custom harnesses) are on the post-MVP roadmap but explicitly out of MVP scope (§11 of the spec).

The natural temptation when only one implementation exists is to inline runtime-specific concerns directly into the worker: write Claude-specific prompt rendering in the worker's main path, embed Claude-specific permission merge rules in the worker's overlay engine, hard-code Claude's `--print` invocation in the worker's process management, etc. This is the cheaper thing to ship in the very short term — no interface to design, no abstraction to defend, no second implementation to validate against.

The question is whether to pay an abstraction tax now (designing and implementing a `RuntimeAdapter` interface with exactly one implementation behind it) in exchange for a much lower retrofit cost later, or to defer the abstraction until a second runtime actually arrives.

Two forces push against deferral:

1. **Calcification cost.** Worker code that grows up assuming Claude-specific shapes becomes load-bearing fast. Every Claude-specific helper, merge rule, and invocation path that future runtimes have to extract from the worker is a retrofit cost that compounds. The longer the worker carries those assumptions, the more downstream code (telemetry, error handling, prompt construction, merge resolution) accretes around them.
2. **Boundary sharpness.** Without the seam, the worker has no clean answer to "what is runtime-specific and what is runtime-agnostic?" With the seam, the worker is exactly the runtime-agnostic concerns (fetch, integrity, overlay engine, secrets, env, setup, channel, notifications, lifecycle) and the adapter is exactly the runtime-specific concerns (prompt rendering, runtime invocation, runtime-specific merge rules, needs_input signaling). The boundary itself surfaces and prevents whole classes of subtle bugs at the worker/runtime interface.

## Decision

The `RuntimeAdapter` interface ships in MVP, with the Claude Code adapter as the sole implementation. Per §10.1 of `docs/superpowers/specs/2026-05-21-pangolin-scale-mvp-design.md`:

> **RuntimeAdapter seam is introduced at MVP rather than deferred.** Even though MVP ships only one adapter (Claude Code), the abstraction exists in v0.1. The cost of adding the seam now is significantly lower than retrofitting it after Claude-specific assumptions calcify in the worker. The cost of *not* shipping it now is that every Claude-specific helper, merge rule, and invocation path becomes load-bearing worker code that future runtimes have to extract from. Adding the adapter interface plus one implementation is bounded work; extracting Claude-specific knowledge from a mature worker after the fact is significantly larger. The seam also makes the worker contract sharper: the worker is exactly the runtime-agnostic concerns (fetch, integrity, overlay engine, secrets, env, setup, channel, notifications, lifecycle), and the adapter is exactly the runtime-specific concerns (prompt rendering, runtime invocation, runtime-specific merge rules, needs_input signaling). Sharper boundaries mean fewer subtle bugs at the worker/runtime interface.

## Consequences

What becomes easier:

- Adding a second runtime (Codex, Gemini CLI, a custom harness) post-MVP is a matter of implementing the `RuntimeAdapter` interface, not refactoring the worker.
- The worker's responsibilities are crisply defined: anything in the runtime-agnostic list (fetch, integrity, overlay engine, secrets, env, setup, channel, notifications, lifecycle) belongs in the worker; anything else belongs behind the adapter.
- Reasoning about the worker/runtime interface is local: bugs in Claude-specific behavior are quarantined to the Claude adapter, not scattered through worker code paths.
- Testing improves: the worker can be exercised against a stub adapter without spinning up Claude Code, and the Claude adapter can be exercised against a stub worker harness.

What becomes harder:

- The MVP carries one extra interface and one extra layer of indirection where, on paper, neither is strictly necessary today. The adapter file and its interface have to be designed, documented, and reviewed.
- New worker features must consciously decide which side of the seam they belong on. This is a discipline cost paid by every contributor touching the worker or the adapter.
- Premature abstraction risk: the interface is designed against a single implementation, so the shape may need to widen when a second adapter arrives. Mitigation: the spec calls out exactly which concerns are runtime-specific (prompt rendering, runtime invocation, runtime-specific merge rules, needs_input signaling), which constrains the interface design to known axes of variation rather than speculative ones.

Trade-offs:

- We pay a bounded design cost up front in exchange for avoiding an unbounded retrofit cost later. The spec's framing — "adding the adapter interface plus one implementation is bounded work; extracting Claude-specific knowledge from a mature worker after the fact is significantly larger" — captures the asymmetry: retrofits scale with how much Claude-specific knowledge has leaked, which is unbounded; the up-front seam is a fixed, one-time cost.
