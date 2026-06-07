# Dogfood run 3 — live gated circle-back (`examples/dogfood-gated`) — design

**Date:** 2026-06-06
**Status:** approved (brainstorm session, post #51/#52 merge); amended same day after a code-grounded audit — including the discovery of a real engine gap (§7) that the offline demo masked
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
| R7 | Engine pre-PR (audit BLOCKER resolution) | **A red gate must block its dependents.** In the landed engine, done-but-red satisfies readiness, so the downstream runs against unreviewed work and is never `skipped` — making findings-by-provenance and the downstream skip+remap **mutually exclusive** (the offline demo masked this by using a *failed* gate, which loses findings). Run 3 is preceded by a scoped engine PR (§7): a dependency that is `done` + `verify.passed === false` + declares `inputs.gate.onRed` counts as failed-like for readiness AND the skip cascade. Scoped to declared gates; the global "verify is report-only" contract holds everywhere else. |

## 2. The plan

Three items, queue `default`, `pipeline` pattern with one gate:

```
write-page   (dispatch, subagent page-writer,   model standard)
    └→ fact-check  (dispatch, subagent fact-checker, model max;  needs.work = write-page patch)
           └→ announce  (dispatch, subagent announcer, model standard; needs.work = write-page patch)
```

- **`write-page`** — creates the execution-patterns explanation page. Seeded with a deliberately **partial** view (the run-2 epistemic position): the pattern-layer spec (`docs/superpowers/specs/2026-06-05-agora-pattern-layer-design.md`), `examples/pattern-dogfood/README.md`, and one style-reference page (`docs-site/src/content/docs/explanation/how-offload-runs.md`). NOT the source code.
- **`fact-check`** — the gate. Subject's patch materialized at `inputs/work`, git-applied pre-agent (run-2's proven capability shape, key `work`). Seeded with the **source the page's claims are about**: `packages/agora-orchestrator/src/patterns/*.ts`, `src/contracts/pattern.ts`, the orchestrator pattern-phase code, and the extendRun surface (exact file list verified at plan time against the landed tree). Agent fact-checks every claim against source under the R6 strict bar; findings go to `outputs/findings` as a JSON array of `{ claim, reality, evidence }` (evidence = file + brief quote/line ref); writes nothing when clean.
- **`announce`** — applies the page patch (`needs.work`), adds a `CHANGELOG.md` entry announcing the page (Keep-a-Changelog format: under `## [Unreleased]` / `### Added`, a bold-titled bullet naming the spec path — this contract goes in the announcer's prompt verbatim). On a red gate this item is **skipped (requires the §7 engine PR)**, then respawned as `announce~2` with `needs.work` remapped to the fix's `resultRef`.

**resourceLocks (run-2 convention — lock what you edit):** `write-page` → the page path; `announce` → `["CHANGELOG.md"]`; `fact-check` → `[]` (edits nothing in-repo; findings live in `outputs/`); fixTemplate → the page path.

**Pattern config (audit-pinned):** the queue passes the **Pattern object itself** — `queues: { default: { concurrency: 2, pattern: pipeline } }` (`orchestrator.ts:18`; `pipeline` exported from the orchestrator barrel). The gate policy is NOT queue-level: it lives on the gate item's reserved `inputs.gate` key (`contracts/pattern.ts:34-40`). Literal gate item:

```json
{ "id": "fact-check", "executor": "dispatch",
  "inputs": { "subagent": "fact-checker", "workerInput": { "instructions": "…" },
    "gate": { "onRed": "spawn-fix", "subject": "write-page", "maxFixAttempts": 1,
      "fixTemplate": { "executor": "dispatch",
        "inputs": { "subagent": "page-fixer", "workerInput": { "instructions": "…" } },
        "resourceLocks": ["docs-site/src/content/docs/explanation/execution-patterns.md"] } } },
  "needs": { "work": { "from": "write-page", "select": { "kind": "patch" } } },
  "depends_on": [], "resourceLocks": [] }
```

Plan item order `[write-page, fact-check, announce]` with `depends_on: []` — `pipeline.plan()` chains each item to the previous (`patterns/pipeline.ts:11-18`), and `normalizeRun` auto-unions the `needs` edges. The fix item's id will be **`fact-check-fix-1`** (`respawn.ts:160`) — the driver's assertions use it. The pattern layer auto-binds the fix's `needs.work` (subject patch) and `needs.findings` (gate output) — the harness writes neither by hand (`SpawnTemplate` has no `needs` field at all; everything else the fix needs arrives via its capabilities).

## 3. Registry surfaces

- **Subagents** (all carry `model:` — sealed as requested per #52):
  - `page-writer` (`standard`) — prompt scaffold from run 2; capabilities: `docs-seeds`.
  - `fact-checker` (`max`) — capabilities: `source-seeds`, `apply-work-patch`; **subagent-level verify** (the #37 seam — `subagent.register({ ..., verify: { command: 'test ! -s outputs/findings' } })`, `subagent-register.ts:34-43`; command runs `shell:true`, cwd = workspace; report-only — never changes exit status, which is exactly what makes done-but-red reachable). Prompt carries the gate contract verbatim: the strict bar (R6), the findings JSON schema, and: "write findings to **exactly `outputs/findings` — no file extension, at the outputs/ root** (the provenance binding looks up `outputRefs['findings']` literally; `findings.json` would silently break it); write the file ONLY if there is at least one finding; create no other files."
  - `page-fixer` (`standard`) — capabilities: `docs-seeds` ONLY — **deliberately NOT `apply-work-patch`** (audit finding: setup scripts run pre-baseline, so a setup-applied subject patch would make the fix's escaped patch a *delta against the applied page*, and both downstream setup-applies — `fact-check~2` and `announce~2`, whose workspaces do not contain the page — would die at `git apply`). Prompt: `inputs/work` (the page-creating patch) and `inputs/findings` are data inputs; **write the corrected page from scratch** so the fix's patch is a cumulative new-file patch that applies cleanly downstream. Red-arc merge protocol for the human afterward: apply the FIX's patch + announce~2's patch (never write-page's + the fix's — both create the same file).
  - `announcer` (`standard`) — capabilities: `announce-seeds` (CHANGELOG.md baseline), `apply-work-patch`.
- **Capabilities:** `docs-seeds` / `source-seeds` / `announce-seeds` (seed-file bundles per §2), and `apply-work-patch` (`agora-setup.sh`: `git init -q && git apply inputs/work`).
- **Gate verify semantics:** `test ! -s outputs/findings` — true when the file is absent or empty → green; findings present → exit 1 → `verify.passed=false` sealed in the sentinel → `readSentinel` attaches it → tick persists to `ItemState.verify` (`executors/dispatch.ts:149-152`, `engine/tick.ts:56-57`) — the literal `respawnLineage` eligibility state.

## 4. Driver and acceptance

Same local stack as run 2 (`LocalDockerProvider` + local storage/secret/mailbox + `serve` loop + `OperationsApi`), self-contained driver per the repo's per-example convention (audit: all three live drivers duplicate this boilerplate; no shared helper exists — follow convention). Worker image: **MUST be rebuilt from this branch** — #52's `--model`/level mapping and the sentinel `usage` block are worker-side; the run-2-era local image silently ignores both (README mandates `docker build -f docker/agora-worker/Dockerfile -t ghcr.io/quarrysystems/agora-worker:main .`; the all-sentinels-lack-usage failure in criterion 4 doubles as the stale-image preflight). GHCR anonymous pull still unauthorized — ops item, unchanged. Fresh per-run temp dirs; SQLite `:memory:`.

After the run reaches terminal state, the driver downloads every item's patch to `examples/dogfood-gated/patches/`, assembles the bundle, and exits non-zero unless ALL of:

1. **Provenance over the grown graph:** `verifyBundle` → `intact: true` AND `checks.handoff.ok === true` — closure across pattern-spawned items, live for the first time.
2. **Red path (when the gate fires — requires §7):** a `run.extended` audit entry with `kind === 'run.extended'`, **`itemId === 'fact-check'`** (the cause rides the `itemId` field — there is no `causeItemId`; `orchestrator.ts:157-163`) and **`actor === 'pattern:default'`** (`pattern:${queue}`); fix item `fact-check-fix-1` `done`; gate copy `fact-check~2` `done` AND green (`verify.passed !== false`); `announce~2` `done` with `bundle.manifests[itemId='announce~2'].inputRefs.work === bundle.items[id='fact-check-fix-1'].resultRef` (the remap, by ref equality — both surfaces confirmed in the bundle).
3. **Green path (honest):** `announce` `done`; driver prints `GATE GREEN — no circle-back exercised` and exits 0. Rerun protocol (R6): one manual re-invocation with the block-pipeline-runner page as subject (the harness takes the topic/seed config from `plan.json` + a seeds manifest so attempt 2 is a config change, not a code change).
4. **Evidence rows (#52, first live):** every dispatch manifest seals a non-empty `model.id` equal to the requested level (the manifest seals the level string verbatim; level→alias resolution is worker-side). Sentinel `usage` is **best-effort by contract** — the driver prints the per-item table `item | requested | actual model(s) | costUsd | turns` + run-total cost, marks missing usage as `(not captured)`, and FAILS only if ALL sentinels lack usage (which indicates a stale pre-#52 worker image, not flake). Sentinel read recipe (audit-pinned, no new store dependency): `dispatchId = parseAgoraUri(item.manifestRef).name` → `client.storage.get(buildDispatchRecordUri(ns, dispatchId, 'output.json'))` → `JSON.parse(...).usage`.

A failed ITEM does not by itself fail the harness (Tier-0 posture: patches are reviewed by the human); the four criteria above are the contract.

## 5. Envelope

- **Timeout:** 15 min (red arc = up to 5 mostly-sequential dispatches: subject → gate → fix → gate~2 → announce~2; concurrency 2 largely idle on a chain).
- **Cost order:** run 2's two dispatches ≈ low single-digit dollars; five dispatches incl. two `max` reviews ≈ $5–15 expected. `maxFixAttempts: 1` bounds the loop; the rerun fallback at most doubles it.
- **After the run:** Tier-0 review of `patches/`; intended real merge of the corrected page + CHANGELOG entry via the run-2 two-commit convention (raw worker output verbatim, then human review corrections), plus the run-3 journal/channel closeout.

## 6. Merge follow-ups (human, at merge time — outside worker file scope)

- Add `{ slug: 'explanation/execution-patterns' }` to the manual Explanation sidebar in `docs-site/astro.config.mjs:55-66`.
- **Pre-existing bug found by the audit:** run 2's `explanation/typed-product-handoff.md` was never added to that sidebar — fix in the same touch.
- Red-arc patch application order: the FIX's patch (cumulative page) + announce~2's patch; write-page's raw patch stays unapplied history in `patches/`.

## 7. Engine pre-PR — a red gate blocks its dependents (R7; lands before the harness)

**The gap (audit finding 8):** `computeNewlyReady` treats a `done` dep as satisfied and `computeSkipped` cascades only from `failed`/`skipped`/`cancelled` (`engine/dep-resolver.ts:4-22`). A done-but-red gate is `done`, so its dependents fire against unreviewed work in the same tick (pattern phase runs after), are never `skipped`, and `buildLineage` (skipped-descendants only) never copies them — `announce~2` is unreachable. The offline demo masked this with a *failed* gate, which loses `outputRefs.findings` (no sentinel on non-zero exit) and degrades the fix to a generic `gateReason` string. Findings-by-provenance and downstream skip+remap were mutually exclusive.

**The change (scoped, gate-aware):** in dep-resolution, a dependency counts as **failed-like** (blocks readiness; triggers the skip cascade) when `status === 'done'` AND `verify?.passed === false` AND the item declares `inputs.gate.onRed === 'spawn-fix'`. Everything else is untouched — the global "verify is report-only" contract (`worker/src/verify.ts`) holds for every non-gate item; a red verify on a normal item still does not gate. Gate copies carry `inputs` (and therefore `inputs.gate`) through `toWorkItemFields`, so `fact-check~2` red blocks `announce~2` identically.

**Data-edge exemption (discovered during implementation — the offline-proof upgrade caught it):** the blunt predicate blocks the gate's OWN fix item: `respawnLineage` binds `needs.findings = { from: gate, select: { kind: 'output', path: 'findings' } }`, `normalizeRun` auto-unions the gate into the fix's `depends_on`, and the red gate then skips the fix it just spawned — collapsing the respawned lineage. The principled scope: a red gate blocks **control-flow dependents** (items that would consume the subject's unreviewed work) but NOT **data consumers of the gate's own outputs** — a dependent is exempt from the failed-like treatment of dep `g` when it declares some `needs[*]` binding with `from === g.id` and `select.kind === 'output'` (the gate's outputs — findings — are exactly what red *means*; red does not invalidate them). Edge audit: fix (needs.findings from gate, kind output) → exempt, runs ✓; original `announce` (depends_on gate, no needs-from-gate) → blocked, skipped ✓; `fact-check~2` (depends on fix, not the red gate) and `announce~2` (depends on `fact-check~2`) → unaffected ✓. The predicate therefore evaluates per (dependent, dependency) pair, not per dependency alone.

**Termination:** red gate → dependents skipped → pattern phase spawns `[fix, gate~2, ...skipped copies]`. If `gate~2` is also red, attempt 2 > `maxFixAttempts: 1` → no further respawn → its skipped descendants stay skipped → all items terminal → run seals. Bounded by construction.

**Scope of the PR:** `engine/dep-resolver.ts` (the failed-like predicate — sole behavior change) + unit tests (red-gate blocks / red-non-gate does not / green gate passes / gate-copy inherits) + tick-level int test + **upgrade the offline proof**: `examples/pattern-dogfood` and `pattern-dogfood.int.test.ts` switch the gate from `failed` to done-but-red-with-findings so the offline demo finally exercises the same arc as run 3 (findings-by-provenance AND skip+remap together — closing the gap that let this hide). Engine diff is deliberately minimal and gate-scoped; the pattern-layer headline ("engine untouched") is amended honestly: the engine gains one gate-aware predicate, pulled by the first live gated run.

## 8. Out of scope (named triggers)

| Deferred | Trigger |
|---|---|
| Toolchain-capable image / code-subject gates (tsc/test as gate signal) | First code-subject gated run |
| map-reduce or multi-gate patterns live | A later run with a fan-out-shaped need |
| `imageDigest` pinning | Own PR (already queued from run 2) |
| `serve` on an always-on host | Its own friction (manual kickoff still cheap) |
| GHCR package visibility | Ops, GitHub UI |
| Generalizing failed-like gating beyond `onRed: 'spawn-fix'` (e.g. verify-gates on non-pattern items) | A consumer that wants red-verify to block without a fix loop |
