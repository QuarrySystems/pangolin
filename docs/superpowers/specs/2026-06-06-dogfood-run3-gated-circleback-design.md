# Dogfood run 3 — live gated circle-back (`examples/dogfood-gated`) — design

**Date:** 2026-06-06
**Status:** approved (brainstorm session, post #51/#52 merge)
**Lineage:** run 1 (#36) proved independent fan-out; run 2 (#51) proved the typed-product handoff on a real dependent chain; run 3 proves the **pattern layer's gated circle-back live** — gate red → audited respawn → fix-consumes-findings → remapped downstream — with real Claude workers on agora's own tree, and (new since #52) every dispatch sealing model + cost. The offline proof exists (`examples/pattern-dogfood`, `pattern-dogfood.int.test.ts`); run 3 is the same arc with money on.

## 1. Decisions (locked in brainstorm)

| # | Decision | Choice |
|---|---|---|
| R1 | Subject work | **Docs page, gate fact-checks with code access.** Directly attacks run 2's proven failure class (5 invented claim-classes from partial context); the gate is the process answer to that class, exercised live. |
| R2 | Gate signal | **Done-but-red + findings.** Gate always completes, writes structured findings to `outputs/findings`, and the verify command flips `verify.passed=false` exactly when findings are non-empty — the precise `respawnLineage` eligibility state (`done` + `verify.passed===false` + `outputRefs.findings`). A failed-gate path (no outputRefs, gateReason-only) is deliberately not used. |
| R3 | Models | **subject=`standard`, gate=`max`, fix=`standard`** — first live use of the #52 level vocabulary; three sealed model ids in one bundle. The verifier gets the strongest model, mirroring how reviews run in-session. |
| R4 | Topic | **`docs-site/src/content/docs/explanation/execution-patterns.md`** — a real gap (no pattern-layer explanation page exists since #45/#47), maximally meta (the page documents the machinery executing the run), and mergeable after Tier-0 review. |
| R5 | Shape | **Approach A: new `examples/dogfood-gated`, full 3-node arc** (subject → gate → downstream). The downstream node is required: on red it is skipped and respawned with `needs.work` remapped to the fix's patch — the remap half of the circle-back only exists with a 3rd node. |
| R6 | Red insurance | **Strict gate bar + one rerun fallback.** The gate's findings bar: any claim not literally supported by the seeded source is a finding, suggestion-severity included (our real review standard — not a planted defect). If the run still comes back green, the driver exits 0 honestly (`GATE GREEN — no circle-back exercised`) and we rerun ONCE with the second real docs gap (block-pipeline runner page) as the subject. No engineered failure. |

## 2. The plan

Three items, queue `default`, `pipeline` pattern with one gate:

```
write-page   (dispatch, subagent page-writer,   model standard)
    └→ fact-check  (dispatch, subagent fact-checker, model max;  needs.work = write-page patch)
           └→ announce  (dispatch, subagent announcer, model standard; needs.work = write-page patch)
```

- **`write-page`** — creates the execution-patterns explanation page. Seeded with a deliberately **partial** view (the run-2 epistemic position): the pattern-layer spec (`docs/superpowers/specs/2026-06-05-agora-pattern-layer-design.md`), `examples/pattern-dogfood/README.md`, and one style-reference page (`docs-site/src/content/docs/explanation/how-offload-runs.md`). NOT the source code.
- **`fact-check`** — the gate. Subject's patch materialized at `inputs/work`, git-applied pre-agent (run-2's proven capability shape, key `work`). Seeded with the **source the page's claims are about**: `packages/agora-orchestrator/src/patterns/*.ts`, `src/contracts/pattern.ts`, the orchestrator pattern-phase code, and the extendRun surface (exact file list verified at plan time against the landed tree). Agent fact-checks every claim against source under the R6 strict bar; findings go to `outputs/findings` as a JSON array of `{ claim, reality, evidence }` (evidence = file + brief quote/line ref); writes nothing when clean.
- **`announce`** — applies the page patch (`needs.work`), adds a `CHANGELOG.md` entry announcing the page. On a red gate this item is skipped, then respawned as `announce~2` with `needs.work` remapped to the fix's `resultRef`.

**Pattern config** (queue-level, per #45's landed `QueueConfig.pattern`; exact shape read from `packages/agora-orchestrator/src/contracts/pattern.ts` + `patterns/pipeline.ts` at plan time): gate id `fact-check`, `subject: write-page`, `maxFixAttempts: 1`, `fixTemplate` = a `dispatch` item (subagent `page-fixer`, model `standard`) whose instructions are "apply every finding to the page; change nothing else." The pattern layer auto-binds the fix's `needs.work` (subject patch) and `needs.findings` (gate output) — the harness writes neither by hand; that auto-binding being exercised live is part of the point.

## 3. Registry surfaces

- **Subagents** (all carry `model:` — sealed as requested per #52):
  - `page-writer` (`standard`) — prompt scaffold from run 2; capabilities: `docs-seeds`.
  - `fact-checker` (`max`) — capabilities: `source-seeds`, `apply-work-patch`. Prompt carries the gate contract verbatim: the strict bar (R6), the findings JSON schema, "write `outputs/findings` ONLY if there is at least one finding; create no other files."
  - `page-fixer` (`standard`) — capabilities: `docs-seeds`, `apply-work-patch`. Prompt: read `inputs/findings`, correct the page per each finding, change nothing else.
  - `announcer` (`standard`) — capabilities: `announce-seeds` (CHANGELOG.md baseline), `apply-work-patch`.
- **Capabilities:** `docs-seeds` / `source-seeds` / `announce-seeds` (seed-file bundles per §2), and `apply-work-patch` (`agora-setup.sh`: `git init -q && git apply inputs/work`).
- **Gate verify:** the #37 worker-self-verify seam, command `test ! -s outputs/findings` (true when the file is absent or empty → green; findings present → exit 1 → `verify.passed=false`). Exact verify-config surface (per-dispatch vs subagent-level) read from the landed #37 code at plan time.

## 4. Driver and acceptance

Same local stack as run 2 (`LocalDockerProvider` + local storage/secret/mailbox + `serve` loop + `OperationsApi`), worker image locally built `ghcr.io/quarrysystems/agora-worker:main` (GHCR anonymous pull is still unauthorized — ops item, unchanged). Fresh per-run temp dirs; SQLite `:memory:`.

After the run reaches terminal state, the driver downloads every item's patch to `examples/dogfood-gated/patches/`, assembles the bundle, and exits non-zero unless ALL of:

1. **Provenance over the grown graph:** `verifyBundle` → `intact: true` AND `checks.handoff.ok === true` — closure across pattern-spawned items, live for the first time.
2. **Red path (when the gate fires):** a `run.extended` audit entry with `causeItemId: fact-check` and pattern actor; fix item `done`; gate copy (`fact-check~2`) `done` AND green (`verify.passed !== false`); `announce~2` `done` with consumed `inputRefs.work === ` fix's `resultRef` (the remap, asserted by ref equality from the sealed manifests).
3. **Green path (honest):** `announce` `done`; driver prints `GATE GREEN — no circle-back exercised` and exits 0. Rerun protocol (R6): one manual re-invocation with the block-pipeline-runner page as subject (the harness takes the topic/seed config from `plan.json` + a seeds manifest so attempt 2 is a config change, not a code change).
4. **Evidence rows (#52, first live):** every dispatch manifest seals a non-empty `model.id` equal to the requested level; every sentinel carries `usage` with ≥1 actual model id; the driver prints a per-item table `item | requested | actual model(s) | costUsd | turns` and a run-total cost line. This is the first sealed bundle that names the model and the spend on real work.

A failed ITEM does not by itself fail the harness (Tier-0 posture: patches are reviewed by the human); the four criteria above are the contract.

## 5. Envelope

- **Timeout:** 15 min (red arc = up to 5 mostly-sequential dispatches: subject → gate → fix → gate~2 → announce~2; concurrency 2 largely idle on a chain).
- **Cost order:** run 2's two dispatches ≈ low single-digit dollars; five dispatches incl. two `max` reviews ≈ $5–15 expected. `maxFixAttempts: 1` bounds the loop; the rerun fallback at most doubles it.
- **After the run:** Tier-0 review of `patches/`; intended real merge of the corrected page + CHANGELOG entry via the run-2 two-commit convention (raw worker output verbatim, then human review corrections), plus the run-3 journal/channel closeout.

## 6. Out of scope (named triggers)

| Deferred | Trigger |
|---|---|
| Toolchain-capable image / code-subject gates (tsc/test as gate signal) | First code-subject gated run |
| map-reduce or multi-gate patterns live | A later run with a fan-out-shaped need |
| `imageDigest` pinning | Own PR (already queued from run 2) |
| `serve` on an always-on host | Its own friction (manual kickoff still cheap) |
| GHCR package visibility | Ops, GitHub UI |
