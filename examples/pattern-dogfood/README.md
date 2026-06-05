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
  implement:     done   (resultRef = fake sha256 impl artifact)
  review:        failed (gate fired red → spawned fix branch)
  package:       skipped
  review-fix-1:  done   (resultRef = fake sha256 fix artifact)
  review~2:      done   (re-gate passed)
  package~2:     done   (needs.work remapped to review-fix-1's ref)

=== run.extended entries ===
  kind=run.extended  causeItemId=review  actor=pattern:default

=== verifyBundle report ===
  intact:        true
  checks.chain:  {"ok":true}
  checks.root:   {"ok":true}
  checks.handoff: {"ok":true,"detail":"2 input refs accounted for"}

=== pattern-dogfood OK — circle-back spawned; sealed history preserved; provenance intact ===
```

Exit code 0.

## The circle-back-as-spawn model

When `review` goes red the pipeline pattern calls `extendRun`, appending three new items:

1. `review-fix-1` — the fix item (derived from `fixTemplate`; runs `implement`'s subject again)
2. `review~2` — a copy of the gate item that re-evaluates after the fix
3. `package~2` — a copy of the `package` item whose `needs.work` is remapped to
   `review-fix-1`'s `resultRef` (the fixed artifact)

### A NEW forward arc — never a cycle

The original items `review: failed` and `package: skipped` are **preserved as sealed history**.
The run is never rewound. The new items are purely additive — a forward arc in the DAG.

```
ORIGINAL BRANCH (sealed)          RESPAWNED BRANCH (added forward)
implement ──→ review (FAILED)      ┐
             ↓ skipped             │  review-fix-1 (done)
           package (SKIPPED)       │       ↓
                                   └─→ review~2 (done)
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
`review-fix-1`'s `resultRef`, which in turn must be sealed in the manifest blob
produced at fire time.

### Why zero credits needed

The fake executor runs entirely in-memory. `fire()` builds a `buildManifest` blob
and `reconcile()` returns a deterministic outcome keyed by item id — no Docker,
no LLM, no network. This makes the demo instantaneous and suitable for CI or
local development without any external dependencies.

## Related

- Spec: `docs/superpowers/specs/2026-06-05-agora-pattern-layer-design.md`
- Unit test (covered by): `packages/agora-orchestrator/test/pattern-dogfood.int.test.ts`
