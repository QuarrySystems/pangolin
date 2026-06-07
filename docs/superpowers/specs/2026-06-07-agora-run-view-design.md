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

### 2.1 `StatusItem` additive fields (orchestrator, `serve/driver.ts` `getStatus`)

The status surface today carries `id`/`status`/`resultRef`/`verify` (shape pinned at implementation time against the landed `getStatus`). It gains two **additive** fields:

- `depends_on: string[]` — the resolved edges (post `normalizeRun` auto-union), so spawned items can be placed in the tree without naming heuristics.
- `manifestRef?: string` — already on items in the audit bundle; exposing it during the run enables the live evidence read (`parseAgoraUri(manifestRef).name` → `buildDispatchRecordUri(ns, dispatchId, 'output.json')` → `storage.get` → `.usage`).

Both are additive — existing consumers (`isTerminalStatusBody`, the dogfood drivers, `--json` watchers) ignore unknown keys. The `--json` byte-compat pin covers the *record envelope*, not field absence: the new fields appear in `--json` output too, documented in the CHANGELOG (status is an unversioned operational surface; additive keys are within its contract).

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

Ghost derivation: for each item declaring `inputs.gate.onRed === 'spawn-fix'`, synthesize dotted `<base>-fix-1`, `<gate>~2`, and copies of its transitively-dependent items (`~2`), exactly mirroring `respawnLineage`'s naming. When `status` is present: ghosts whose real counterparts exist become real nodes; ghosts under a green-resolved gate are dropped; ghosts under a still-pending/running gate remain dotted. (One generation of ghosts only — `maxFixAttempts: 1` is the supported semantics per run-3 spec §8.)

### 2.3 Layout selection (V5)

- `pipeline` → **chain**: items in plan order on a vertical spine; gate node marked `⛩`; ghost arc indented under the gate; respawn generations as forward arcs below the original (sealed history never moves).
- `map-reduce` → **fan**: splitter node, indented fan of map items (collapsed to `× N` past a width threshold), reducer node.
- none / `static-dag` → **tree**: parent-above-child by `depends_on` (diamonds duplicate the child reference with a `↩ see <id>` marker rather than drawing cross-links).

### 2.4 The renderer (`renderRunView` — pure)

`renderRunView(view: RunView, opts: { color: boolean; unicode: boolean; width?: number }): string[]`. Status glyphs: `·` pending/ready, `⟳` running, `✔` done (green verify or none), `✖` failed or done-but-red, `⊘` skipped, `┊` ghost. Per-node evidence suffix when present: `— <level>→<model> · $<cost> · <turns>t`. Footer: item counts by status, running cost total, run state (`running` / `sealed` / `settled`). ASCII mode substitutes `[.] [>] [ok] [x] [-] [:]`. The renderer never touches the terminal — callers own cursor control.

### 2.5 Frame loop (CLI watch + driver)

A small shared `frameLoop` helper (CLI-side is fine — it's terminal plumbing, not rendering): for each `api.watch` record, rebuild the view, render, and (a) default: ANSI cursor-up + clear previous frame height, print; (b) `--no-clear`: print a new frame only when lines differ from the previous frame. On terminal state: print the final frame, then (watch verb) fetch + print the standard verify-row summary via the existing `renderVerification` path when an audit export exists (best-effort; absent export → note and exit per run state).

## 3. CLI surfaces (`agora-cli`)

- **`agora orch render <plan.json>`** — loads the plan, resolves the queue's pattern from the config context's orchestrator wiring where available; falls back to the pattern named by a `--pattern <name>` flag (the plan file does not name its pattern — queue config does; the flag covers render-without-config). Prints the pre-run view (ghosts dotted). No store, no Docker, no key.
- **`agora orch watch <run-id>`** — DEFAULT: the live view via the frame loop. `--json`: the previous raw `JSON.stringify(rec)` stream, byte-identical (pinned). Flags: `--interval <ms>` (passes through to `api.watch`), `--no-color`, `--no-clear`, `--ascii`. Evidence reads are best-effort and never fail the watch.

## 4. Driver adoption (`examples/dogfood-gated`)

The driver's watch loop (the ~50-block spam) is replaced by `buildRunView`/`renderRunView` + the frame helper with `--no-clear` semantics (driver output is a log, not a TTY session). The driver's plan/pattern/status/evidence inputs are all already in scope. Its terminal evidence table and the four §4 acceptance rows are UNCHANGED (they are the assertion surface; the view is presentation).

## 5. Testing (offline, zero credits)

- **Renderer goldens** (pixel-exact line arrays): pipeline pre-run with ghost arc; red materialization mid-run; green collapse; bounded-red termination (`~2` red, descendants skipped); map-reduce fan (incl. collapsed `× N`); generic tree; diamond `↩` marker; ASCII and no-color variants; evidence suffix present/absent.
- **View-model unit tests**: ghost synthesis mirrors `respawnLineage` naming; generation parsing; ghost→real reconciliation; green collapse; layout selection per pattern.
- **Live sequence test**: drive `buildRunView` through a scripted status progression (reuse the pattern-harness fixtures' shapes) asserting frame-over-frame node transitions.
- **CLI tests** (per `cmd-*.test.ts` conventions): render verb output; watch `--json` format pin (one raw JSON record line per poll — the pre-change stream shape, modulo the additive body keys); flag plumbing.
- **StatusItem additive pin**: `getStatus` carries `depends_on` + `manifestRef`; existing consumers unaffected (run the dogfood int tests untouched).

## 6. Documentation (same PR)

- `docs-site/reference/cli.md`: the `render` verb; `watch`'s new default + `--json` escape hatch + flags.
- `docs-site/explanation/execution-patterns.md`: one cross-link ("watch a pattern run live").
- `CHANGELOG.md`: entry covering the view, the watch default change (with `--json` migration note), and the additive StatusItem fields.

## 7. Out of scope (named triggers)

| Deferred | Trigger |
|---|---|
| Web UI / browser view | First non-terminal consumer |
| Mermaid/dot export | First docs-generation consumer |
| Push/streaming updates (vs polling) | v2 per the existing polling decision |
| Custom layout for a 4th pattern | The 4th pattern landing |
| Multi-generation ghost arcs | Multi-round respawn chaining landing (run-3 spec §8 trigger) |
| `agora orch render` of a LIVE run id (render-from-store) | First operator request; `watch` covers the live case |
