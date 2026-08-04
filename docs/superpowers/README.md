# `docs/superpowers/`

`specs/` holds design documents. `plans/` holds the DAG plans that execute them.

## The one rule: a status marker is a claim, not a fact

**Verify a `status:` line against the code before believing it.** These markers
are written once, when the document is authored, and there is no mechanism that
updates them when the work lands. They rot silently, and they rot in the
direction that wastes the most time — a shipped thing still advertising itself as
unbuilt.

Measured on 2026-08-03: **12 of 47 specs** claimed `draft` / `design (plan
pending)` / `DESIGNED — ready for a plan` for work that was already on `main`,
including one marked "ready for a plan" the day after it merged. Two plans in
`plans/` still carried `status: pending` on every task for code that shipped in
May, under a header instructing agents to execute them — which would have meant
re-implementing live code.

That is the failure mode to guard against. It is not a filing inconvenience: an
agent or a consumer scanning for work takes these lines literally.

## When you touch a spec or plan

- Landing the work? **Update the status in the same PR.** It is one line, and it
  is the only moment anyone reliably knows the truth.
- Correcting a stale marker? Say what you verified (`Verified on main: <path>`)
  and keep the original text under **Originally:**. What was believed, and when
  it stopped being true, is part of the record.
- **Pick the marker from what the spec DESIGNED, not from its title.** The
  2026-08-03 sweep got this wrong on the cron spec and left it marked `draft`
  while it was fully shipped: the file is titled "cron **trigger**", so the check
  looked in `src/triggers/`, found only `manual.ts`, and concluded correctly
  about that directory and wrongly about the feature. The spec's own §0.1 decides
  that cron is deliberately **not** a `Trigger` — it is a submission producer, and
  it lives in `src/scheduling/`. Reasoning from the title picked the one location
  the design guaranteed would be empty. Read far enough into a spec to know what
  it claims to have built before deciding where to look for it.
- A plan that shipped is **historical**. Mark it so at the top, and do not
  silently flip its per-task markers — those describe the plan at authoring time,
  and rewriting them fakes a verification nobody performed.

## Why there is no status index here

An index would need the same maintenance the `status:` lines already fail to get,
and would then be a second stale source disagreeing with the first. The rule
above is the durable version. If you want current state, read the code.
