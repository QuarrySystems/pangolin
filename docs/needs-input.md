# `needs_input` — pausing for clarification

A sub-agent that hits ambiguity mid-task — "I could change function A or
function B; which?" — shouldn't guess. The MVP pattern is
**request-stop-restart**: the sub-agent writes a structured "I need input"
file and exits cleanly; the orchestrator routes the question to the right
answerer (human via Slack, another agent, a database lookup) and
re-dispatches with the answer added to `input`.

This page covers what the sub-agent does, what the worker reports, and
what the orchestrator does with the response.

For the design rationale, see ADR-0008 (why request-stop-restart, not
in-flight ask) and ADR-0009 (why sentinel file, not exit code).

## The contract in one paragraph

The sub-agent writes a JSON file at `/workspace/.agora/needs_input.json`
before terminating. The runtime adapter detects it post-exit and reports
its path. The worker reads, validates, and emits a `dispatch.needs_input`
lifecycle event (not `dispatch.finished`) with the question payload. The
worker exits 0 — billing stops. The orchestrator re-dispatches the same
subagent with the operator's answer appended to `input` and the prior
`partial_state` threaded through for continuity.

## Sentinel file shape

```json
{
  "question": "Should I rewrite function A or function B?",
  "options": ["A", "B"],
  "context": "Both have the same signature but different call sites.",
  "partial_state": { /* freeform, up to 1 MiB serialized */ }
}
```

Required: `question` (string).
Optional: `options` (string array — when the answer is constrained),
`context` (string — extra background for the answerer), `partial_state`
(any JSON — the sub-agent's analysis so far, threaded back on resume).

The 1 MiB serialized cap applies to the whole file. Larger continuity
needs go in external storage with a pointer in `partial_state`.

## How the sub-agent learns the convention

The `ClaudeCodeRuntimeAdapter` ships an overlay capability that teaches
the convention: a `SKILL.md` at `.claude/skills/agora-needs-input/`
explaining when and how to write the sentinel. The adapter applies it
before integrator capabilities unless `AGORA_DISABLE_NEEDS_INPUT_HELPER=
true` is set in the worker's env.

This means most integrators don't have to do anything for `needs_input`
to work — the convention is preloaded into every dispatch by default.

## Worker behavior

After the runtime adapter returns (step 11 of the 14-step lifecycle),
the worker checks `RuntimeExit.needsInputSentinelPath`:

- **Sentinel present and valid** → emit `dispatch.needs_input`, exit 0.
  The runtime's exit code is **ignored** — a non-zero exit from `claude
  --print` does not by itself fail the dispatch when the sentinel is
  present.
- **Sentinel present but malformed** (unparseable JSON, missing
  `question`, exceeds 1 MiB) → emit `dispatch.failed` with
  `reason: 'worker-failed'`. A broken sentinel is a real bug; the
  integrator needs to see it.
- **Sentinel absent + adapter exit 0** → emit `dispatch.finished`, exit 0.
- **Sentinel absent + adapter exit non-zero** → emit `dispatch.failed`
  with `reason: 'provider-failed'`.

The worker exits with code 0 for `needs_input` because the work paused
cleanly — it's not a failure, it's a deliberate stop. Billing ends.

## Orchestrator behavior — what you do with `dispatch.needs_input`

Three steps:

1. **Route the question.** The orchestrator (a Claude Code agent driving
   `agora_dispatch`, or TypeScript code in your own surface) takes the
   `question` (and `options` / `context` if present) and routes it
   somewhere a human or another agent will answer. Slack, an internal
   tool, a queued workflow — agora has no opinion.
2. **Receive the answer.** Out-of-band — whatever channel you chose.
3. **Re-dispatch.** Call `client.dispatch({...})` again with the same
   subagent, same env, same target — but add the answer to `input` and
   pass the prior `partial_state` so the sub-agent can pick up from
   where it left off.

Skeleton:

```typescript
const first = await client.dispatch({ subagent: 'planner', /* ... */ });
if (first.needsInput) {
  const answer = await yourSlackBot.ask(first.needsInput.question, {
    options: first.needsInput.options,
    context: first.needsInput.context,
  });
  const resumed = await client.dispatch({
    subagent: 'planner',
    /* same env / target / workerImage as before */,
    input: { ...originalInput, answer },
    partialState: first.needsInput.partialState,
  });
  // resumed may itself be needsInput — loop until terminal.
}
```

Re-dispatch is the orchestrator's responsibility, not the worker's. The
worker has no memory of prior runs; continuity rides entirely on
`partial_state` going in and the same subagent / env going in.

## "Prior reasoning as `partial_state`" — the load-bearing pattern

Spec §6.9.1 names the pattern that makes request-stop-restart competitive
with in-flight ask for typical cases: the sub-agent serializes its
analytical work-so-far into `partial_state` before writing the sentinel,
so the resumed dispatch doesn't redo the analysis. Without this, every
re-dispatch starts from scratch and the round-trip cost dominates.

The agora-needs-input-helper SKILL.md teaches this pattern; most stock
Claude Code prompts pick it up naturally.

## Cost model — why this beats in-flight ask

A worker waiting on a human Slack answer would bill for compute time
across minutes-to-hours of wait. The sentinel approach pays:

- One sentinel-file write + stat (negligible)
- A cold start on resume (image fetch + workspace rehydrate + runtime
  warmup — typically seconds)
- Whatever redoing-from-`partial_state` costs (small if the pattern is
  applied; large if not)

The cost gap widens the longer the operator takes to answer, which is the
common case. See ADR-0008 §3 for the full economic argument.

## What's NOT supported (deferred to v0.2+)

- **In-flight ask** — synchronous mid-dispatch conversation requiring a
  `ConversationAdapter`. Not built, not stubbed.
- **Snapshot-resume** — bypassing cold-start on resume by snapshotting
  the worker mid-flight. Not built; the snapshot machinery cost wasn't
  worth the narrowed cost gap.
- **Multiple concurrent `needs_input`** — one sentinel per dispatch.
  Multiple questions = either ask them serially across re-dispatches, or
  combine them into one sentinel's `options`.

## See also

- ADR-0008 — request-stop-restart vs in-flight ask, with the cost
  argument.
- ADR-0009 — why a sentinel file and not an exit code.
- MVP spec §6.9 — the formal protocol.
- [Dispatch lifecycle](dispatch-lifecycle.md) — how `dispatch.needs_input`
  fits in the 6-kind closed vocabulary.
