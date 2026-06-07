# Pattern-aware CLI run view — `agora orch render` + live `watch` — design

**Date:** 2026-06-07
**Status:** approved (brainstorm session, post run-3 / #55)
**Motivation:** the run-3 live runs exposed the gap twice. (1) The most dramatic moment the product has — a gate going red, the downstream skipped, a forward arc *materializing* via audited respawn — renders today as ~50 repeated flat status blocks (`agora orch watch` is even worse: raw `JSON.stringify` per poll, `cmd-orch.ts:54-59`). (2) Attempt 2's stale-lineage engine bug was diagnosed by squinting at flat lines (`fix-2: running` beside `fact-check~3: running`); a tree view showing `fact-check~3` hanging off `fix-1` would have made it instantly visible. Demo motion after this lands: **render** (the expected run, ghosts dotted) → **watch** (the ghost materializes live, dollars ticking) → **verify** (the sealed proof, already shipped in #55).

## 1. Decisions (locked in brainstorm)

| # | Decision | Choice |
|---|---|---|
| V1 | Style | **Unicode box-drawing + ANSI color, with fallbacks.** Glyphs per status; redraw-in-place; `--no-color` (and auto when not a TTY, matching `renderVerification`'s convention) and `--no-clear` (append a frame only when it differs — CI-log/asciinema friendly). Pure-ASCII mode rides the same flag surface (`--ascii`). |
| V2 | Watch default | **The live view becomes `agora orch watch`'s DEFAULT output.** `--json` restores the previous raw record stream — same format (one `JSON.stringify(rec)` line per poll; pinned by test); record bodies additionally carry the additive §2.1 keys, which is within the status surface's additive contract. |
| V3 | Live evidence | **Model + cost per item, live.** As an item reconciles, the watcher best-effort fetches its sentinel (#52 read recipe via the config context's `orch.storage`) and fills `model · $cost · turns` on the node line; running cost total in the footer; `(not captured)` tolerated per item. |
| V4 | Ghost arcs | **Both surfaces.** `render` shows a declared gate's potential respawn lineage dotted; `watch` ALSO shows the ghosts until the gate resolves — green collapses them, red materializes them into real nodes. |
| V5 | Not-a-DAG (user note) | **The view is PATTERN-AWARE, not generically "a DAG."** Layout is selected by the queue's pattern: `pipeline` → chain layout with gate + ghost arc; `map-reduce` → splitter → fan → reducer layout; absent/`static-dag` → generic dependency tree. The pattern is layout knowledge, not just engine behavior. |
| V6 | Placement | **View model + renderer live in the orchestrator beside `audit/render.ts`** (it already owns rendering); CLI verbs and the dogfood-gated driver are thin consumers. A CLI-local renderer was rejected: driver adoption would duplicate it across packages (SoC/DRY). |

## 2. Data model and flow

### 2.1 `StatusItem` — real shape + ONE additive field (audit-pinned)

`getStatus` (orchestrator.ts:296-309) already publishes `{ id, runId, status, blockedBy: string[], resultRef?, manifestRef?, verify? }` — **`manifestRef` already ships** (the dogfood-gated driver consumes it). The only addition is:

- `depends_on: string[]` — the resolved edges (post `normalizeRun` auto-union), `i.depends_on.map(deNs)` in the same map that already builds `blockedBy` (which is the *filtered non-done* dep list and therefore cannot drive a stable tree layout — that's why the full list is needed). Mechanical and additive.

Audit-verified consumer sweep: `isTerminalStatusBody` (status-only), both dogfood drivers and the cross-process test type structural subsets, no test asserts a whole-object key set — additive key safe everywhere. The new key appears in `--json` output too (status is an unversioned operational surface; additive keys are within its contract — CHANGELOG notes it).

### 2.2 The view model (`buildRunView` — pure)

```ts
buildRunView(args: {
  plan: Run;                       // as submitted (pattern.plan() applied by the builder)
  pattern?: Pattern;               // the queue's pattern (for chaining + layout key)
  status?: StatusItem[];           // absent = pre-run (render verb)
  evidence?: Map<string, RuntimeUsage>;  // best-effort, watcher-supplied
}): RunView
```

`RunView` = `{ layout: 'chain' | 'fan' | 'tree'; nodes: RunViewNode[]; edges; generations; footer }` where a `RunViewNode` carries `id`, `kind: 'real' | 'ghost'`, `status?`, `verify?`, `usage?`, `generation` (0 = submitted; N = `~N+1` respawn wave, parsed via the same attempt convention as `respawnLineage`), and `gate?: { maxFixAttempts }`.

`buildRunView` applies `pattern.plan()` THEN `normalizeRun` to the plan (mirroring `submitRun`'s order, orchestrator.ts:110-113) — without this the pre-run edges miss both the pipeline auto-chain and the needs auto-union. `pattern.plan()` may throw on malformed config — `render` surfaces it the way `orch validate` does. Generation parsing reuses the exported `parseAttempt`; layouts key on the exported `Pattern.id`.

Ghost derivation (audit-pinned to mirror `respawnLineage` + the §53 skip semantics exactly): for each item declaring `inputs.gate.onRed === 'spawn-fix'`, synthesize dotted `<base>-fix-1`, `<gate>~2`, and `~2` copies of the gate's would-be-skipped descendants — computed as a BFS from the gate that seeds only **non-exempt** direct edges (a consumer whose `needs` binds the gate with `select.kind === 'output'` is data-edge-exempt per dep-resolver.ts:12-25 and runs rather than skips — it and its exclusive descendants get NO ghost copy), then marks every dependent of a marked item (multi-parent items skip if ANY parent is marked). Ghost edges follow `respawnLineage`'s substitution: lineage-internal edges remap to the `~2`/fix ids; edges to non-lineage upstreams keep the ORIGINAL ids. When `status` is present: ghosts whose real counterparts exist become real nodes; ghosts under a green-resolved gate are dropped; ghosts under an unresolved gate stay dotted; mid-run frames may briefly show ghosts whose real copies haven't spawned yet (the lineage converges over ticks) — the same reconciliation absorbs it. One generation of ghosts only — `maxFixAttempts: 1` is the supported semantics per run-3 spec §8.

### 2.3 Layout selection (V5)

- `pipeline` → **chain**: items in plan order on a vertical spine; gate node marked `▣` (audit: NOT `⛩` — U+26E9 is East-Asian-Wide + emoji-property, tofu/width-drift on Windows consoles and fatal to pixel-exact goldens); ghost arc indented under the gate; respawn generations as forward arcs below the original (sealed history never moves).
- `map-reduce` → **fan**: splitter node, indented fan of map items (collapsed to `× N` past a width threshold), reducer node.
- none / `static-dag` → **tree**: parent-above-child by `depends_on` (diamonds duplicate the child reference with a `↩ see <id>` marker rather than drawing cross-links).

### 2.4 The renderer (`renderRunView` — pure)

`renderRunView(view: RunView, opts: { color: boolean; unicode: boolean; width?: number }): string[]`. Status glyphs (audit: match `audit/render.ts`'s established narrow non-emoji set — `✓`/`✗`, manual ANSI map, no chalk): `·` pending/ready, `⟳` running, `✓` done (green verify or none), `✗` failed or done-but-red, `⊘` skipped, `┊` ghost. Per-node evidence suffix when present: `— <level>→<model> · $<cost> · <turns>t`. Footer: item counts by status, running cost total, run state (`running` / `sealed` / `settled`). ASCII mode substitutes `[.] [>] [ok] [x] [-] [:]`. The renderer never touches the terminal — callers own cursor control. Deliberate divergence from `renderVerification` (returns one joined string): this renderer returns `string[]` because the frame loop needs the line count for cursor-up — recorded so reviewers don't "fix" it. Module placement: `src/view/{build.ts,render.ts}` (a run view is not audit), exported from the package barrel.

### 2.5 Frame loop (CLI watch + driver)

Split per the audit (the driver must not import agora-cli): the **pure frame-dedup** helper (previous lines vs next lines → emit-or-skip) lives in the orchestrator view module beside the renderer; only the **TTY plumbing** (ANSI cursor-up + clear-height + reprint) is CLI-side. The view loop MUST guard `rec.kind === 'status'` before treating `body` as `StatusItem[]` — `api.watch` yields the latest record each poll (duplicates included; the frame-dedup absorbs those) and the `status()` fallback can yield a non-status record before the first status publishes. On terminal state: print the final frame, then (watch verb) fetch + print the standard verify-row summary via `api.audit` + `renderVerification` with a **short bounded retry** (the audit export publishes after the terminal status record, same driver iteration or a tick later — the dogfood driver's 15×1s pattern); export never appears → note it and exit per run state.

## 3. CLI surfaces (`agora-cli`)

- **`agora orch render <plan.json> [--pattern <pipeline|map-reduce|static-dag>]`** — loads the plan and prints the pre-run view (ghosts dotted). **`--pattern` is the v1 path** (audit: `OrchContext` carries NO queue/pattern wiring — the queue→pattern map lives inside the orchestrator constructor behind the opaque `runService`; the named flag values resolve to the real exported `pipeline`/`mapReduce`/`staticDag` Pattern objects). Omitted flag → generic tree layout, no ghosts. `render` must NOT call `getOrchContext` (it throws without a config file) — no store, no Docker, no key, no config.
- **`agora orch watch <run-id>`** — DEFAULT: the live view via the frame loop. `--json`: the previous raw stream — one `JSON.stringify(rec)` line per poll, format-pinned (the stream legitimately repeats identical lines, one per poll). Flags: `--interval <ms>` (pass-through to `api.watch`'s existing `intervalMs`; the verb currently has no flags at all), `--no-color`, `--no-clear`, `--ascii`. Evidence reads are best-effort and never fail the watch. Watch derives the pattern for layout from... nothing it has — so the live view uses the generic tree layout UNLESS `--pattern` is given (same flag as render); the chain/fan layouts are a presentation nicety, the tree is always correct.

## 4. Driver adoption (`examples/dogfood-gated`)

The driver's watch loop (the ~50-block spam) is replaced by `buildRunView`/`renderRunView` + the frame helper with `--no-clear` semantics (driver output is a log, not a TTY session). The driver's plan/pattern/status/evidence inputs are all already in scope. Its terminal evidence table and the four §4 acceptance rows are UNCHANGED (they are the assertion surface; the view is presentation).

## 5. Testing (offline, zero credits)

- **Renderer goldens** (pixel-exact line arrays): pipeline pre-run with ghost arc; red materialization mid-run; green collapse; bounded-red termination (`~2` red, descendants skipped); map-reduce fan **mid-run** (audit: the fan size is runtime-determined — `plan()` does not expand it; the pre-run fan renders a `× ?` placeholder) incl. collapsed `× N`; generic tree; diamond `↩` marker; data-edge-exempt consumer correctly UN-ghosted; ASCII and no-color variants; evidence suffix present/absent.
- **View-model unit tests**: ghost synthesis mirrors `respawnLineage` naming; generation parsing; ghost→real reconciliation; green collapse; layout selection per pattern.
- **Live sequence test**: drive `buildRunView` through a scripted status progression (reuse the pattern-harness fixtures' shapes) asserting frame-over-frame node transitions.
- **Evidence recipe**: namespace comes FROM the manifestRef itself — `parseAgoraUri(manifestRef)` returns `{ namespace, name: dispatchId }` → `buildDispatchRecordUri(namespace, dispatchId, 'output.json')` → `storage.get` → `.usage`. No config coupling (an improvement over the dogfood driver's hardcoded-namespace `readUsage`). Requires adding `@quarry-systems/agora-core` to agora-cli's dependencies (audit: currently absent).
- **CLI tests** (per `cmd-*.test.ts` conventions): render verb output; watch `--json` format pin (one raw JSON record line per poll — the pre-change stream shape, modulo the additive body keys); flag plumbing.
- **StatusItem additive pin**: `getStatus` carries `depends_on` + `manifestRef`; existing consumers unaffected (run the dogfood int tests untouched).

## 6. Documentation (same PR)

- `docs-site/src/content/docs/reference/cli.md`: the `render` verb; `watch`'s new default + `--json` escape hatch + flags.
- `docs-site/src/content/docs/explanation/execution-patterns.md`: one cross-link ("watch a pattern run live").
- `CHANGELOG.md`: entry covering the view, the watch default change (with `--json` migration note), and the additive `depends_on` StatusItem field.

## 7. Out of scope (named triggers)

| Deferred | Trigger |
|---|---|
| Web UI / browser view | First non-terminal consumer |
| Mermaid/dot export | First docs-generation consumer |
| Push/streaming updates (vs polling) | v2 per the existing polling decision |
| Custom layout for a 4th pattern | The 4th pattern landing |
| Multi-generation ghost arcs | Multi-round respawn chaining landing (run-3 spec §8 trigger) |
| `agora orch render` of a LIVE run id (render-from-store) | First operator request; `watch` covers the live case |
| `OrchContext.patterns?` (config-supplied queue→pattern map so render/watch auto-detect layout) | First config that actually wires patterns; `--pattern` covers v1 |
