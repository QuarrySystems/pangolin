---
title: "ADR-0009: needs_input is signaled by a sentinel file, not by an exit code"
description: "needs_input is signaled by a sentinel file at a documented path, not by an exit code."
status: accepted
date: 2026-05-21
deciders: pangolin-scale-mvp-design
---

## Context

Once the `needs_input` convention adopts request-stop-restart (Shape A, see
ADR 0008), a follow-on question is how the sub-agent signals "I need input"
to the runtime adapter and the worker on its way out. Two signaling
mechanisms were considered:

- **Exit code.** Reserve a specific non-zero exit code (e.g. 42) to mean "I
  need input." The runtime adapter inspects the exit code after the runtime
  binary terminates and maps the reserved value to a `needs_input` outcome.
- **Sentinel file.** The sub-agent writes a structured JSON file to a
  documented path (`/workspace/.pangolin/needs_input.json`) before terminating.
  The runtime adapter checks for the file's presence after the runtime exits
  and reads the payload from there. Exit code is ignored for the purpose of
  this signal.

Exit codes lose the comparison on three counts:

1. **Pollutability.** Exit codes are produced by many sources beyond the
   sub-agent's deliberate intent: OS signals (SIGTERM, SIGKILL), shell wrapper
   layers, the sub-agent's own tool subprocesses (a failed grep, a non-zero
   `git status --porcelain` check), and the runtime binary's own conventions
   for non-interactive exit. Claude Code specifically has its own
   non-interactive exit behavior that the worker cannot reliably distinguish
   from a deliberate sub-agent signal. Whatever value gets reserved, some
   unrelated path will eventually produce it for the wrong reason.
2. **No documented contract for the sub-agent.** Asking a sub-agent to "exit
   with code 42" requires it to either (a) wrap its entire response in an
   `exit 42` shell invocation it doesn't normally control, or (b) trust the
   runtime to translate some special tool call into an exit code. Neither
   path uses tools the sub-agent already has and reasons about.
3. **No payload.** Exit codes carry one integer. The `needs_input` outcome
   needs at minimum a `question` string, optionally `options`, `context`, and
   `partial_state` (a freeform structure up to 1 MiB serialized). A sidecar
   file would be needed regardless, so the file becomes the natural primary
   signal.

A sentinel file inverts every weakness: the sub-agent produces it deliberately
through its existing write-capable tool, the payload travels with the signal,
and the worker's check (`fs.existsSync(path)`) is independent of any exit-code
noise the runtime might emit. The runtime adapter reports the file's path
back through `RuntimeExit.needsInputSentinelPath`; the worker reads, parses,
and validates it per the resolution rule in §6.9.

## Decision

From §6.9:

> Exit codes are pollutable — signals, OS quirks, the sub-agent's tool
> subprocesses, and the runtime's own non-interactive exit behavior can all
> produce non-zero exits unrelated to the sub-agent's intent. A sentinel file
> is a documented contract: the sub-agent's write-capable tool (Claude Code's
> `Write` for the MVP adapter; equivalent for future adapters) produces the
> file deliberately, and the runtime adapter detects its presence after the
> runtime exits regardless of exit code. The file's existence is the
> authoritative signal; its contents are the payload. The worker trusts the
> adapter's `RuntimeExit.needsInputSentinelPath` to know whether the file was
> present.

The sentinel path for the MVP `ClaudeCodeRuntimeAdapter` is
`/workspace/.pangolin/needs_input.json`. The convention itself is Pangolin Scale-level;
the content that teaches the sub-agent about it (the `pangolin-needs-input-helper`
overlay) is adapter-provided — a `.claude/skills/pangolin-needs-input/SKILL.md`
for the Claude Code adapter, equivalent instruction surfaces for future
adapters.

## Consequences

- The worker checks for sentinel-file presence regardless of the runtime's
  exit code. A non-zero exit from `claude --print` does not by itself fail
  the dispatch if the sentinel file is present and valid; the `needs_input`
  outcome dominates.
- A malformed sentinel (unparseable JSON, missing `question`, or
  `partial_state` exceeding the 1 MiB serialized cap) is treated as a worker
  failure (`reason: 'worker-failed'`), not silently as "no needs_input." A
  sub-agent that wrote the file but produced garbage content is broken; the
  integrator needs to see that.
- The sentinel-file path is part of the public contract per RuntimeAdapter.
  Future adapters are responsible for choosing a path appropriate to their
  runtime and reporting it via `RuntimeExit.needsInputSentinelPath`. The
  worker-side resolution rule is adapter-agnostic.
- The convention is taught to the sub-agent through an adapter-provided
  helper overlay that is always applied unless the integrator opts out via
  `PANGOLIN_DISABLE_NEEDS_INPUT_HELPER=true`. Most integrators benefit from the
  convention without thinking about it.
- The cost of the sentinel-file approach is one filesystem stat per dispatch
  (negligible) plus the adapter-side wiring to report the path. The benefit
  is a signal channel that survives every exit-code pollution mode the
  runtime can produce.
- Integrators writing new runtime adapters do not have to negotiate exit-code
  semantics with their runtime's existing conventions. They pick a writable
  path inside the workspace, report it, and the worker handles the rest.
