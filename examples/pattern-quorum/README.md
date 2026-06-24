# pattern-quorum

Zero-credit in-memory demo of the **independent-review quorum** pattern: a draft is reviewed
by N independent reviewers, and the effecting `commit` step is spawned **only on a sealed
quorum**. Every reviewer verdict and the tally are audit evidence.

This is the *"and that it was allowed to"* half of Pangolin's wedge rendered as an execution
pattern — an **independent-validation control** (SR 11-7 model validation, EU AI Act Art. 14
oversight) that a regulated-vertical buyer's auditor can verify from the bundle alone.

No Docker. No API key. Just SQLite `:memory:` + a deterministic fake executor.

## How to run

```
# From repo root (first time only):
pnpm install

# Run the demo:
pnpm --filter pattern-quorum-example start
```

## What you will see

```
=== BEFORE: submitted run ===
  items: draft  (just the draft — reviewers are spawned)

=== AFTER: graph status ===
  draft: done resultRef=pangolin://ns/artifact/draft/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaa…
  draft::rev-0: done verdict=APPROVE
  draft::rev-1: done verdict=APPROVE
  draft::rev-2: done verdict=DISSENT
  draft::commit: done resultRef=pangolin://ns/artifact/commit/sha256:bbbbbbbbbbbbbbbbbbbb…

=== independent-review tally (recomputed from sealed verdicts) ===
  reviewers: 3   approvals: 2   threshold: 2
  quorum reached: true  →  commit ADVANCED

=== run.extended entries ===
  kind=run.extended  causeItemId=draft         actor=pattern:default
  kind=run.extended  causeItemId=draft::rev-0  actor=pattern:default

=== draft::commit provenance ===
  inputRefs.work === draft resultRef: true

=== verifyBundle report ===
  intact:         true
  claim:          tamper-detecting
  checks.chain:   {"ok":true}
  checks.root:    {"ok":true}
  checks.handoff: {"ok":true,"detail":"4 input refs accounted for"}

=== pattern-quorum OK — 2-of-3 independent quorum advanced; dissent + tally sealed; provenance intact ===
```

Exit code 0.

## The model: fan-out → tally → advance (or circle back)

When the `draft` subject completes, the quorum pattern reads its reserved `inputs.quorum`
config and calls `extendRun`, fanning out **one reviewer item per template**
(`draft::rev-0..N-1`), each independently reviewing the draft's product:

```jsonc
"quorum": {
  "reviewers": [ {…}, {…}, {…} ],   // N independent reviewers
  "threshold": 2,                    // approvals needed to advance
  "commit":   {…},                   // spawned only on quorum
  "onReject": "spawn-fix",           // or "block" (rejection is final history)
  "fixTemplate": {…},
  "maxRounds": 1                      // circle-back bound
}
```

Once **all** reviewers are terminal, the next reviewer's `onTaskDone` tallies the approvals
(a reviewer *approves* iff it finished `done` and did not self-report `verify.passed === false`):

- **approvals ≥ threshold** → spawn the `commit` item (the effecting step), which `needs` the
  reviewed draft's product. One dissent is recorded but does not block a met quorum.
- **approvals < threshold** → reject. With `onReject: "spawn-fix"` the pattern spawns a `fix`
  plus a re-review copy `draft~2` (carrying the config forward, so it re-fans-out) — bounded by
  `maxRounds`, with the failed round preserved as sealed history. With `onReject: "block"`
  the rejection is final and nothing more is spawned.

This demo exercises the **advance** path (2-of-3, one dissent). The reject/circle-back path is
covered by the unit test (`packages/pangolin-orchestrator/test/patterns/quorum.test.ts`).

### Why this is the GTM-relevant pattern

The existing `pipeline` gate is a *single* reviewer. Quorum is **independent, redundant**
validation: N reviewers that don't see each other's verdicts, advance only on consensus, and —
critically — **the full tally is sealed**. The dissent is not swept away; it is part of the
evidence. An auditor recomputes "2 of 3 independent reviewers approved" directly from the
bundle, without trusting any dashboard or any single agent.

> In production each reviewer template carries a **distinct `subagentShape`** (e.g. opus /
> sonnet / haiku, or different review prompts) registered in a pack, so the reviewers are
> independent *by model*, not just by slot. This demo omits shapes (none are registered in the
> in-memory orchestrator); the unit test covers per-reviewer `subagentShape` pass-through.

### Two assurance tiers: independent-validation vs. oversight / four-eyes

The pattern is **reviewer-agnostic** — a reviewer is just an executor that returns a verdict —
so the *same* quorum mechanism spans two compliance tiers, chosen by **what** each reviewer is:

| Tier | Reviewers | Meets | What the bundle proves |
|---|---|---|---|
| **Independent validation** | AI subagents, distinct `subagentShape`s | automated independent review (SR 11-7-style) | N independent *models* reached consensus |
| **Oversight / four-eyes** | ≥ 1 **human**-approval reviewer | EU AI Act Art. 14 human oversight, segregation-of-duties / four-eyes | a named *person* approved — identity + timestamp |

> ⚠️ The AI-only demo above is the **independent-validation** tier. It does **not**, on its own,
> satisfy human-oversight controls — those require a natural person in the loop. Sealing the
> verdicts is necessary but not sufficient; the *approver must be human*.

**Oversight / four-eyes needs no change to the pattern** — and ships as real code:
[`HumanApprovalExecutor`](../../packages/pangolin-orchestrator/src/executors/human-approval.ts)
(unit tests: `test/executors/human-approval.test.ts`; end-to-end through this pattern:
`test/pattern-quorum-human.int.test.ts`). A human-approval reviewer is just an executor whose:

- `fire()` opens a pending-approval state (writes an approval-request sentinel — e.g. a row a
  reviewer UI / Slack / email action resolves);
- `reconcile()` returns `null` (still pending) until a natural person submits a decision — the
  same reconcile-returns-null-until-resolved model the engine uses for any long-running work —
  then returns the verdict **plus the approver's sealed identity + timestamp** (the actual
  human-input sentinel).

That human verdict flows into the same tally and seals identically. So a four-eyes control is
just a quorum config — two AI reviewers plus a **mandatory** human sign-off:

```jsonc
"quorum": {
  "reviewers": [
    { "executor": "ai-review",      "inputs": {}, "subagentShape": "opus" },
    { "executor": "ai-review",      "inputs": {}, "subagentShape": "sonnet" },
    { "executor": "human-approval", "inputs": { "approverRole": "compliance-officer" } }
  ],
  "threshold": 3,           // unanimous — the human sign-off cannot be outvoted by the AIs
  "commit": { "executor": "deploy", "inputs": {} },
  "onReject": "block"       // rejection is final; the effecting step never runs
}
```

Wire the `human-approval` executor with an `ApprovalSource` (where decisions arrive — a reviewer
UI / Slack action / queue) and a content-addressed `ApprovalRecordSink` (where the sealed
record is written):

```ts
new HumanApprovalExecutor({ source, sink, namespace });
// fire() seals a request manifest bound to the exact artifact under review (inputRefs);
// reconcile() returns null until a person decides, then seals an ApprovalRecord
// { approver, decision, decidedAt, subjectItemId, approverRole } via outputRefs.approval.
```

Now `draft::commit` (the effecting action) is spawned only after a named compliance officer
approved alongside the AI reviewers — and the bundle proves *who*, *when*, and *that the agent
was allowed to act*. Setting `threshold` below the reviewer count would let the AI votes carry a
decision without the human; for a true four-eyes / segregation-of-duties control, make the human
slot mandatory (threshold = reviewer count, or a dedicated required-approver slot).

### A NEW forward arc — never a cycle

Like every Pangolin pattern, quorum only ever *appends* (`extendRun`): reviewers, the commit,
or a re-review copy are new forward nodes. The run is never rewound; a rejected round stays as
sealed history. Every spawn flows through the audited seam and writes a `run.extended` entry
naming the cause and `actor: pattern:default`.

### Why zero credits needed

The fake executor runs entirely in-memory: `fire()` builds a `buildManifest` blob and
`reconcile()` returns a deterministic verdict keyed by item id — no Docker, no LLM, no network.
Instantaneous and CI-friendly.

## Related

- Spec: `docs/superpowers/specs/2026-06-05-agora-pattern-layer-design.md`
- Unit test: `packages/pangolin-orchestrator/test/patterns/quorum.test.ts`
- Sibling demos: `examples/pattern-dogfood` (single-gate circle-back), `examples/pattern-mapreduce` (N-unknown fan-out)
