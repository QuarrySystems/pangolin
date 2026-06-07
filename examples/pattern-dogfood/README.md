# pattern-dogfood

Zero-credit in-memory demo of the gated DAG-plan circle-back (spec §9): the
dogfood loop that proves the `pipeline` pattern's `spawn-fix` gate works end-to-end.

No Docker. No API key. Just SQLite `:memory:` + a deterministic fake executor.

## How to run

```
# From repo root (first time only):
pnpm install

# Run the demo:
pnpm --filter pattern-dogfood-example start
```

## What you will see

```
=== BEFORE: submitted run ===
  items: implement, review, package

=== AFTER: graph status ===
  implement: done resultRef=agora://ns/artifact/impl/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaa…
  review: done verify.passed=false
  package: skipped
  review-fix-1: done resultRef=agora://ns/artifact/fix/sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbb…
  review~2: done
  package~2: done

=== run.extended entries ===
  kind=run.extended  causeItemId=review  actor=pattern:default

=== review-fix-1 manifest inputRefs ===
  work:     agora://ns/artifact/impl/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  findings: agora://ns/artifact/findings/sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc

=== package~2 provenance ===
  inputRefs.work matches review-fix-1 resultRef: true

=== verifyBundle report ===
  intact:           true
  claim:            tamper-detecting
  guarantee:        detect
  checks.chain:     {"ok":true}
  checks.root:      {"ok":true}
  checks.handoff:   {"ok":true,"detail":"3 input refs accounted for"}

=== pattern-dogfood OK — circle-back spawned; sealed history preserved; provenance intact ===
```

Exit code 0.

## The circle-back-as-spawn model

When `review` goes **done-but-red** (status `done`, `verify.passed === false`) the pipeline
pattern calls `extendRun`, appending three new items:

1. `review-fix-1` — the fix item; needs BOTH `work` (from `implement`'s result) and `findings`
   (the gate's diagnostic output, returned as a true gate `outputRefs.findings`)
2. `review~2` — a copy of the gate item that re-evaluates after the fix
3. `package~2` — a copy of the `package` item whose `needs.work` is remapped to
   `review-fix-1`'s `resultRef` (the fixed artifact)

The original items `review: done-but-red` and `package: skipped` are **preserved as sealed
history**. The run is never rewound. The new items are purely additive — a forward arc in the DAG.

### Engine red-gate cascade and data-edge exemption (§7)

When `review` is done-but-red, the dep-resolver's `§7 isBlockedBy` predicate treats it
as failed-like for CONTROL-FLOW dependents. Downstream `package` (pending, depends on `review`
with no `needs` binding to its outputs) is cascaded to `skipped` in the **same tick** that
`review` is reconciled. The pattern phase then sees a skipped descendant and the spawn directive
includes the full `[fix, gate~2, dependent~2]` set.

`review-fix-1`, however, is exempt: its `needs.findings` binding has `from: 'review'` and
`select.kind: 'output'`. The data-edge exemption in `isBlockedBy` (commit 9fb0ea7) recognises
this as a data consumer of the gate's own output — red does not invalidate the findings, it
IS the findings. The fix item readies normally and receives both `work` and `findings` refs
via the engine's needs-resolver at fire time (no manual manifest injection needed).

### A NEW forward arc — never a cycle

```
ORIGINAL BRANCH (sealed)                 RESPAWNED BRANCH (added forward)
implement ──→ review (done-but-red)      ┐
             ↓ cascade                   │  review-fix-1 (done)
           package (SKIPPED)             │       ↓
                                         └─→ review~2 (done-green)
                                                  ↓
                                             package~2 (done)
```

### Audited seam

Every spawn flows through `extendRun`, which writes a `run.extended` audit entry
recording:

- `causeItemId`: which gate item fired red (`review`)
- `actor`: `pattern:default` (the pattern layer, not the user)

This entry is included in the sealed audit chain. `verifyBundle` checks the full
provenance closure: `package~2`'s `inputs.inputRefs.work` must equal
`review-fix-1`'s `resultRef`, and `review-fix-1`'s `inputRefs.findings` must equal
the findings ref produced by the done-but-red gate — all checked across 3 handoff edges.

### Why zero credits needed

The fake executor runs entirely in-memory. `fire()` builds a `buildManifest` blob
and `reconcile()` returns a deterministic outcome keyed by item id — no Docker,
no LLM, no network. This makes the demo instantaneous and suitable for CI or
local development without any external dependencies.

## Related

- Spec: `docs/superpowers/specs/2026-06-05-agora-pattern-layer-design.md`
- Unit test (covered by): `packages/agora-orchestrator/test/pattern-dogfood.int.test.ts`
