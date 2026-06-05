# pattern-mapreduce — offline mapReduce fan-out demo

Demonstrates that the Agora orchestrator can grow a run's item graph at
runtime through the audited `extendRun` seam, and that provenance closure
over the dynamically-spawned graph is fully verifiable.

## What this example proves

- `plan.json` submits **only** the splitter item.
- The `mapReduce` pattern intercepts the splitter's `done` event and spawns
  3 map items (`map-a.json`, `map-b.json`, `map-c.json`).
- Once all maps are done, it spawns a single `reduce` item.
- The final printed item tree contains **5 items** — visibly more than the 1
  submitted in the plan.
- Every `extendRun` call is captured in the audit log as a `run.extended`
  entry, with `actor: pattern:default` and the cause item id.
- `assembleBundle` + `verifyBundle` confirm `intact === true` and
  `checks.handoff.ok === true` — every spawned item's consumed input refs are
  provenance-sealed to a completed item in the same run.

Design spec: `docs/superpowers/specs/2026-06-05-agora-pattern-layer-design.md`

## Why no API credits or workers are needed

This example uses a **fake in-memory executor**. No Docker, no Anthropic API
key, no network traffic. The orchestrator, run-state store (SQLite in-memory),
and audit log all run in the same Node.js process.

## How to run

Install dependencies once at the repo root:

```sh
pnpm install
```

Then start the demo:

```sh
# From the repo root
pnpm --filter pattern-mapreduce-example start

# Or from this directory
pnpm start
```

## What you will see

```
Submitted run 'pattern-mapreduce-demo' — plan has 1 item(s) (splitter only).

=== Grown item tree (splitter + 3 maps + reduce) ===
  map-a.json: done
  map-b.json: done
  map-c.json: done
  reduce: done
  split: done
  Total items: 5 (plan submitted 1; orchestrator grew to 5)

=== run.extended audit entries ===
  kind=run.extended  actor=pattern:default  causeItemId=split
  kind=run.extended  actor=pattern:default  causeItemId=map-c.json

=== verifyBundle provenance closure ===
  intact:         true
  checks.chain:   {"ok":true}
  checks.root:    {"ok":true}
  checks.handoff: {"ok":true,"detail":"... accounted for ..."}

=== pattern-mapreduce OK — graph grew at runtime; provenance sealed ===
```

Exit code is `0` when `report.intact === true && report.checks.handoff.ok === true`,
otherwise `1`.
