# Lens: coverage — does the plan deliver the spec, exactly?

**Artifact:** `docs/superpowers/plans/2026-07-30-sync-provider-spi-dag.md` (plan)
**Parent spec:** `docs/superpowers/specs/2026-07-29-sync-provider-spi-design.md` (frozen)
**Downstream context given:** none — plan untracked, all 8 tasks `status: pending`,
no implementing code. A plan defect here can therefore reach an implementer.

## Charter: what I read

- `.claude/audit-charter.md` — enforcement map (`typecheck:test` opt-in; `pangolin-cli`
  has no `tsconfig.test.json`), recurring bug class "green tests, dead runnable
  artifact" (instance 2 is this very spec), verification gotchas.
- No `CLAUDE.md` / `AGENTS.md` in this repo (confirmed by the task brief and a
  root-level check).
- `docs-site/src/content/docs/reference/cli.md`, `.../reference/config.md`,
  `.../how-to/sync-capabilities-subagents.md` — the three docs targets of §10.
- ADR set present at `docs-site/src/content/docs/explanation/decisions/`; only
  ADR-0005 is spec-relevant and §10 correctly declines to touch it.

---

### Grounding table

| Assumption | Where in artifact | Verified at file:line | Status |
|---|---|---|---|
| `src/index.ts:110` is the sole real `CliContext` construction, passing two members, inside a `require.main` guard | plan `## Context` guard 2; `task-config-loader` AC | `packages/pangolin-cli/src/index.ts:109-110` | VERIFIED |
| `CliContext` has exactly two members today | `task-config-loader` impl block | `packages/pangolin-cli/src/index.ts:23-30` | VERIFIED |
| Two duplicated config loops exist in `pangolin-cli` | `task-config-loader` body | `src/index.ts:46-69`, `:71-94` | VERIFIED |
| Four user-facing error literals to preserve | `task-config-loader` AC | `src/index.ts:63,68,88,93` | VERIFIED |
| `providers/index.ts` today = `PROVIDERS` const + `resolveProvider` + `listProviderNames` + 3 type re-exports | `task-barrel` body | `src/providers/index.ts:11-29` | VERIFIED |
| Plan's `listProviderNames` is the existing body, unchanged (§4.4 requires "same body, same signature") | plan:131-133 | `src/providers/index.ts:25-27` | VERIFIED |
| `splitFrontmatter` is exportable from `../frontmatter.js` | `task-barrel` impl line | `src/frontmatter.ts:17` | VERIFIED |
| Both sync actions call `resolveProvider` synchronously today | `task-actions` body | `src/cmd-subagent.ts:122`, `src/cmd-capabilities.ts:57` | VERIFIED |
| `test/cmd-subagent.test.ts` `--provider made-up` fixture supplies only `getClient` | plan guard 1 | `packages/pangolin-cli/test/cmd-subagent.test.ts:126,129,131` | VERIFIED |
| `CHANGELOG.md:12` is the existing `### Breaking` heading | `task-changelog` AC | `CHANGELOG.md:12` | VERIFIED |
| The doc instructs editing `PROVIDERS` in `providers/index.ts` and names `resolveProvider(name)` | `task-docs` body | `docs-site/.../how-to/sync-capabilities-subagents.md:160-161`, `:171-172` | VERIFIED |
| A real-bin spawn pattern exists to mirror | `task-bin-spawn` body | `test/e2e/mcp-tool-surface.test.ts` (repo root, not inside a package) | VERIFIED |
| `package.json` has `main`/`types`, no `exports`, `dist` in `files` | `task-exports` impl | `packages/pangolin-cli/package.json:6-7,11-15` | VERIFIED |
| `cli.md` has a capabilities-`sync` row and a subagent-`sync` row to amend | `task-docs` AC | `docs-site/.../reference/cli.md:37`, `:49` | VERIFIED |
| No task owns §9's `--help` laziness row or the three Blast-radius rows | (absent) | see finding C1 (two searches) | NOT-FOUND |
| No task owns EU1 | (absent) | see finding C2 (two searches) | NOT-FOUND |
| No task owns §7's "pointer comment in all three loaders" | (absent) | see finding C4 (two searches) | NOT-FOUND |

---

### Requirement → task matrix

#### A. §9 testing table (27 rows, each treated as a discrete requirement)

| # | §9 row | Owning task | Verdict |
|---|---|---|---|
| 1 | Merge: config provider resolves by name | `task-registry` (AC "paired positive companion … resolves to the config provider") | COVERED |
| 2 | Merge: built-in collision throws, names + index | `task-registry` (AC bullet 5) | COVERED |
| 3 | Merge: duplicate names throw | `task-registry` (AC bullet 5) | COVERED |
| 4 | Merge: unknown-provider error enumerates built-ins **and** config names, built-ins first | `task-registry` (AC bullet 6) | COVERED |
| 5 | **Merge—`source`**: a fixture *literally named* `pangolin.config.js` produces an error whose text contains it | split: `task-config-loader` (real `.js` fixture → `source`) + `task-registry` (error text from a *typed literal*) | **PARTIAL** — see C3 |
| 6 | Laziness: `--provider claude-code` with a throwing `getSyncProviders` fake | `task-actions` (AC bullet 3) | COVERED |
| 7 | Laziness: `--provider remora` **does** call it, resolves to the config provider | `task-registry` (unit level) + `task-actions` AC bullet 4 ("the same negative/positive pair as the subagent side") | COVERED (subagent-level pair only implicit) |
| 8 | Laziness: same pair for `capabilities sync` | `task-actions` (AC bullet 4, explicit) | COVERED |
| 9 | Laziness: `--help` succeeds **and** does not call a throwing fake | **none** | **UNOWNED** — C1 |
| 10 | Blast radius: import-hostile config present, built-in `--dry-run` **succeeds** and prints `(dry-run) subagent <n>` | **none** | **UNOWNED** — C1 |
| 11 | Blast radius: same config, **non**-dry-run built-in **fails** | **none** | **UNOWNED** — C1 |
| 12 | Blast radius: same config, typo'd name surfaces the *import* error, not `unknown --provider` | **none** | **UNOWNED** — C1 |
| 13 | Validation: `undefined` export → `[]`, not an error | `task-config-loader` (AC bullet 3) | COVERED |
| 14 | Validation: `null` export **rejected** (pairs with 13) | `task-registry` (AC bullet 3) | COVERED |
| 15 | Validation: non-array rejected, naming the file | `task-registry` (AC bullet 3) | COVERED |
| 16 | Validation: `[null]` entry → indexed error, not raw `TypeError` | `task-registry` (AC bullet 4) | COVERED |
| 17 | Validation: entry missing `loadSubagents`, naming the index | `task-registry` (AC bullet 4) | COVERED |
| 18 | Validation: non-string `name` | `task-registry` (AC bullet 4) | COVERED |
| 19 | Validation: missing `defaultSubagentDir` | `task-registry` (AC bullet 4) | COVERED |
| 20 | Absent config: seam returns `null` **and** built-in `--dry-run` still succeeds | `task-config-loader` (AC bullet 1) + `task-bin-spawn` (empty tmpdir cwd, `--dry-run` exits 0) | COVERED (both halves) |
| 21 | Fixtures: `cmd-subagent.test.ts` still asserts `unknown --provider 'made-up'` after widening | `task-actions` (AC bullet 2) | COVERED |
| 22 | Wiring: real bin spawn executing `index.ts:110` | `task-bin-spawn` | COVERED |
| 23 | Loader: precedence order for each of the three `defaultGet*` | `task-config-loader` (AC bullet 6) | COVERED |
| 24 | Loader: four error literals asserted against values written into the test | `task-config-loader` (AC bullet 5, verbatim literals) | COVERED |
| 25 | Exports: `package.json` declares `"."` and `"./providers"` | `task-exports` (AC bullet 1) | COVERED |
| 26 | Exports: both specifiers resolve against built `dist/` **in a node subprocess** | `task-exports` (AC bullet 2) | COVERED |
| 27 | Exports: real `.mjs` spawned by node named-imports `ClaudeCodeProvider` | `task-exports` (AC bullet 3) | COVERED |

**Tally: 22 covered, 4 unowned (9, 10, 11, 12), 1 partial (5).**

#### B. Non-§9 spec requirements

| Spec requirement | Owning task | Verdict |
|---|---|---|
| §3.1 `exports` map; `main`/`types` retained; no `require`/`import` condition split | `task-exports` | COVERED |
| §3.2 `registry.ts` holds `PROVIDERS`, `findBuiltIn`, `resolveProvider`, `resolveProviderLazily`, `mergeProviders`, `listProviderNames`, `ConfigProviders` | `task-registry` (all seven present in the impl block) | COVERED |
| §3.2 barrel = 3 types + 2 classes + `splitFrontmatter`, and *nothing else* | `task-barrel` (whole-set `Object.keys` equality) | COVERED |
| §3.2 shape check module-private, no second entry point | `task-registry` (AC last bullet) | COVERED |
| §3.2 `cmd-subagent.ts:20` / `cmd-capabilities.ts:21` import path change | `task-actions` (AC bullet 1) | COVERED |
| §4.2 both actions use `resolveProviderLazily`; built-in first | `task-actions` | COVERED |
| §4.3 merge semantics, three error cases, `source` names the resolved file, collision names both sides + index | `task-registry` | COVERED |
| §4.4 `findBuiltIn` / `resolveProvider` signatures; deterministic enumeration; `listProviderNames` moved unchanged | `task-registry` | COVERED |
| §4.5 `CliContext` third seam; `ConfigProviders` with `providers: unknown` | `task-config-loader` | COVERED |
| §4.5 wire `defaultGetSyncProviders` at `index.ts:110` | `task-config-loader` (AC last bullet) | COVERED |
| §4.5 member **required**; optional/`?.` repair prohibited | plan guard 2 + `task-actions` AC bullet 2 | COVERED |
| §4.5 widen `cmd-subagent.test.ts` **and** `cmd-capabilities.test.ts` | `task-actions` (`files:` lists both) | COVERED |
| §4.5 breaking-change entry under `### Breaking` | `task-changelog` | COVERED |
| §4.5 **static help text stays generic** | none (row 9 was its only pin) | **UNOWNED** — folded into C1 |
| §4.6 `resolveProviderLazily(name, getExtra)` in `registry.ts`, no `src/index.ts` dep | `task-registry` | COVERED |
| §5 validation inside `mergeProviders`; order `undefined`→`[]`, non-array reject, per-entry checks; dir fields validated unconditionally | `task-registry` + `task-config-loader` | COVERED |
| §6 the three D7 cases | `task-config-loader` (AC bullets 1-3) | COVERED |
| §7 `loadConfigModule` helper; copies 1+2 collapse; copy 3 stays; error strings unchanged | `task-config-loader` + plan guard 3 | COVERED |
| §7 "a **pointer comment in all three loaders**" | none | **UNOWNED** — C4 |
| §7 `config.md` line: two processes import this file | `task-docs` | COVERED |
| §8 provisional note, scoped to the subpath, `loadSubagents(dir)` as the named reason | `task-docs` (AC bullet 4) | COVERED |
| §9 EU1 "must be given an owning task when the plan is written" | none | **UNOWNED** — C2 |
| §10 authoring guide: write against the subpath; register via `syncProviders`; composition guidance retained | `task-docs` | COVERED (composition block at `:156-158` is outside the replaced range and survives) |
| §10 import safety: real `dependency`, survives pruned prod install, no module-scope throw, `pangolin-mcp` named as the reason | `task-docs` (AC bullet 2, all three parts) | COVERED |
| §10 must not repeat the credential-scan claim | `task-docs` (AC bullet 3) | COVERED |
| §10 "the in-tree `PROVIDERS` path stays documented" | `task-docs` (AC bullet 1) | **PARTIAL** — C5 |
| §10 `config.md` gains `syncProviders` | `task-docs` | COVERED |
| §10 `cli.md:37,49` both rows amended (config-supplied names; no built-in override) | `task-docs` (AC bullet 6) | COVERED |
| §10 no ADR; ADR-0005 stale count **not** fixed | correctly no task | COVERED |
| §11 out-of-scope list (9 items) | correctly no tasks; guard 3 restates the `pangolin-mcp` exclusion | COVERED |

**Over-build / orphaned scope: none found.** Every task deliverable traces to a
spec section (see the "Checked, no finding" section for the two candidates I
examined and dismissed).

---

### Findings

- **BLOCKING** · Four of §9's 27 rows have no owning task — the `--help` laziness
  guard and all three Blast-radius rows — leaving D4's headline property
  unverified against a real config on disk.
  - Artifact text: (absent). The nearest text is `task-actions`' AC
    "`subagent sync --provider claude-code --from <dir> --dry-run` succeeds with a
    `getSyncProviders` **fake** that throws if invoked", and `task-bin-spawn`'s
    spawn into `await mkdtemp(join(tmpdir(), 'pangolin-bin-'))` — a directory that
    contains no config at all.
  - Spec text unowned:
    - §9 row: "`--help` succeeds **and** does not call a throwing `getSyncProviders`
      fake — guards against a later change that enumerates providers in help text
      and reintroduces eager loading on every invocation" (paired with §4.5 "Static
      help text stays generic").
    - §9 row: "present but import-hostile config: `--provider claude-code --dry-run`
      **succeeds** and prints `(dry-run) subagent <n>`".
    - §9 row: "same config, **non**-dry-run built-in **fails** — the other half of
      the table in §4.2, currently untested".
    - §9 row: "same config, a typo'd name (`--provider claude-cod`) surfaces the
      import error, not `unknown --provider` — pins the accepted cost".
  - Evidence (negative claim, two independent searches):
    1. Keyword grep over the whole plan for `help|blast|hostile|module scope|throws on import`
       returns exactly two hits: plan:253 (`…into one helper`) and plan:639 (the
       *documentation* prose "must not throw at module scope"). Neither is a test
       deliverable.
    2. Structural sweep: I enumerated every task's `files:` block
       (plan:94-95, 248-249, 357-360, 421-422, 474, 544-545, 607-609, 679) and every
       acceptance-criteria bullet in all eight tasks. No task creates or names a
       config fixture that throws on import; no AC asserts a non-dry-run failure, a
       typo'd-name-against-a-real-config outcome, or any `--help` behavior.
  - Concrete failure: the plan's only laziness evidence is an *injected fake*. A
    fake proves the `ctx.getSyncProviders` seam is not called; it cannot prove that
    the process performed no config I/O, because `defaultGetSyncProviders` and
    `defaultGetClient` are both replaced in those tests. `task-bin-spawn` runs the
    real bin but in an empty tmpdir, so it cannot distinguish "config not imported"
    from "no config existed to import" — grounded at
    `packages/pangolin-cli/src/cmd-subagent.ts:125`, where `getClient()` is already
    skipped under `--dry-run`, so nothing in the plan ever puts a loadable-but-hostile
    config in front of the built binary. Result: **D4 — the single decision the whole
    lazy design rests on — ships with no end-to-end verification.** A later change
    that eagerly imports the config in `buildProgram`, in the action prologue, or in
    a `--provider` help-text enumeration passes every test this plan defines, green.
    Rows 11 and 12 additionally encode the *accepted costs* §4.2 negotiated; with no
    owner, the plan ships a behavior contract nothing pins.
  - Resolution: give the four rows an owner. Natural home is `task-bin-spawn`
    (it already has a tmpdir-cwd spawn harness — add a `pangolin.config.mjs` that
    throws at module scope, then assert the three §4.2 table outcomes), plus one
    `--help` case in `task-actions` alongside the existing fake-based rows. If the
    author instead judges a row unnecessary, the spec is frozen — that requires a
    stated deviation in the plan, not silent omission.

- **DEFERRED** · EU1 has no owning task, which is the one thing §9 explicitly told
  the plan author to fix.
  - Artifact text: `task-config-loader` AC — "Resolution order `.ts` → `.js` → `.mjs`
    holds for all three `defaultGet*` functions (`.ts` leg per the spec's EU1 caveat
    — assert `.js` before `.mjs` at minimum)."
  - Spec text: "**This unknown has no owning task, because no plan exists yet.** It
    must be given one when the plan is written, or resolved inline before §9's Loader
    row is finalized. An empirical unknown with no owner is how a known gap becomes a
    shipped assumption."
  - Evidence (two searches): (1) grep for `EU1|Node 20|>=20|ERR_UNKNOWN_FILE_EXTENSION|probe`
    across the plan hits only plan:345 (the caveat above) and plan:574-580 (a local
    variable named `probe` in the exports test); (2) reading all eight task headers,
    no task carries a probe/empirical deliverable and none touches Node-version
    surface. The plan finalized the Loader row (plan:344-345) while doing neither of
    the two things the spec permitted.
  - Concrete failure: the `.ts` leg stays in `CONFIG_FILENAMES` (plan:272) and stays
    documented at `docs-site/src/content/docs/reference/config.md:18`, while
    `task-docs` — the only task touching that file — has no criterion about it. CI
    pins Node 22, so an implementer who writes the `.ts` precedence assertion the AC's
    first clause invites gets a green run that fails for any user on the declared
    `>=20` floor. The AC's hedge ("`.js` before `.mjs` at minimum") makes that
    outcome implementer-dependent rather than decided.
  - Resolution: add a probe task (`node -e "import('file:///<abs>/pangolin.config.ts')…"`
    on Node 20.x, per §9) or state inline in `task-config-loader` that the `.ts` leg
    is deliberately unasserted and why — and, if the probe says it fails, give
    `task-docs` the `config.md:18` correction.

- **DEFERRED** · §9's `source` row is split across two tasks and the join is
  unpinned; the plan's registry test is the exact tautology that row exists to forbid.
  - Artifact text: `task-registry` test block — `expect(() => mergeProviders([{ name: 'remora' }], 'pangolin.config.js')).toThrow(/pangolin\.config\.js: …/)`,
    titled "names the real resolved config file, not a hardcoded .mjs".
  - Spec text: "**a fixture literally named `pangolin.config.js` (not `.mjs`) produces
    an error whose text contains `pangolin.config.js`.** Without this row every
    filename assertion is a constant compared to the constant the test typed, and a
    hardcoded `'pangolin.config.mjs'` passes them all."
  - Evidence: `task-config-loader` AC bullet 4 owns the real-fixture half ("a fixture
    cwd containing only `pangolin.config.js` yields `source: 'pangolin.config.js'`");
    `task-registry` owns the error-text half but sources the filename from a literal
    the test itself types. No AC in any task requires a single test in which a real
    on-disk `.js` fixture produces an *error message* containing that filename —
    verified by reading all eight AC lists and by grepping the plan for
    `pangolin.config.js` (hits: plan:201, 203, 336, 337 — the two halves, never joined).
  - Concrete failure: the uncovered part is the plumbing `config.source →
    resolveProvider(…, source)` at plan:191. An implementer who hardcodes a filename
    inside `resolveProviderLazily` instead of forwarding `config.source` passes both
    halves. Low residual risk because the plan's impl block shows the correct line —
    but the regression is undetectable afterwards, which is precisely the property
    the spec called out as load-bearing.
  - Resolution: name the join in one AC — the `.js`-fixture loader test should drive
    `resolveProviderLazily` with an unknown name through the *real*
    `defaultGetSyncProviders` and assert `pangolin.config.js` appears in the thrown text.

- **DEFERRED** · §7's "pointer comment in all three loaders" has no owner, and
  scope guard 3 forecloses the `pangolin-mcp` half of it.
  - Artifact text: guard 3 — "**`pangolin-mcp` is out of scope.** …Do not refactor
    it." `task-config-loader`'s `files:` are `src/index.ts` and the test only.
  - Spec text (§7): "The honest fix is a pointer comment in all three loaders and a
    line in `config.md` noting that two processes import this file."
  - Evidence (two searches): (1) grep `pointer comment` across the plan → zero hits;
    (2) `packages/pangolin-mcp/**` appears in no task's `files:` block (enumerated
    above) and in the plan only under guard 3 and in `task-docs` prose. The
    `config.md` half **is** owned by `task-docs`; the comment half is not. Ground
    truth for the surviving copy: `packages/pangolin-mcp/src/bin.ts` still holds an
    independent resolution loop.
  - Concrete failure: §7's rationale for letting copy 3 diverge was that a pointer
    comment would keep the three loaders discoverable from one another. Ship without
    it and the next person to change the filename triple in `pangolin-cli` has nothing
    pointing at `pangolin-mcp/src/bin.ts`, which is how copy 3 silently drifts out of
    precedence-order agreement with copies 1 and 2.
  - Resolution: either add the comment to the consolidated `loadConfigModule` (and
    accept a comment-only edit to `pangolin-mcp/src/bin.ts`, which is not a refactor),
    or state in the plan that the spec's pointer-comment clause is deliberately
    dropped, with the reason.

- **DEFERRED** · §10's "the in-tree `PROVIDERS` path stays documented" is only half
  owned: no criterion requires updating the path and resolver name that this change
  invalidates.
  - Artifact text: `task-docs` AC bullet 1 — "The `sync-capabilities-subagents.md`
    instruction to edit the in-tree `PROVIDERS` map is replaced for out-of-tree
    readers; the in-tree path remains documented for pangolin's own providers." The
    task's Implementation block replaces only "the 'To register a provider' block".
  - Evidence: today the doc says "add an entry to the `PROVIDERS` map in
    `packages/pangolin-cli/src/providers/index.ts`"
    (`docs-site/src/content/docs/how-to/sync-capabilities-subagents.md:160-161`) and
    "both sync commands resolve providers through `resolveProvider(name)` from the
    same map" (`:171-172`). After `task-registry` + `task-barrel`, `PROVIDERS` lives
    in `providers/registry.ts` (plan:122-125) and `providers/index.ts` is four export
    lines (plan:436-439); after `task-actions` the actions call `resolveProviderLazily`
    (plan:376). No AC in `task-docs` mentions `registry.ts` or the new resolver name.
  - Concrete failure: the "in-tree path" the guide retains will name a file that no
    longer contains the map and a resolver signature that no longer exists — the same
    class of defect (§1.2 "instructs the impossible") that §10 exists to remove, just
    relocated. `pnpm --filter docs-site build` does not detect it: prose and code
    fences are not link-checked.
  - Resolution: add an AC — the retained in-tree paragraph names
    `packages/pangolin-cli/src/providers/registry.ts` and `resolveProviderLazily`.

---

### Checked, no finding

- **All 8 tasks trace to a spec section.** No orphaned scope. Mapping:
  `task-registry`→§3.2/§4.3/§4.4/§4.6/§5, `task-config-loader`→§4.5/§6/§7,
  `task-actions`→§3.2/§4.2/§4.5, `task-barrel`→§3.2, `task-bin-spawn`→§9 wiring row,
  `task-exports`→§3.1, `task-docs`→§8/§10, `task-changelog`→§4.5.
- **Over-build candidates examined and dismissed.** (a) `task-changelog`'s fourth AC
  requires `### Added` entries for the `syncProviders` export and the `./providers`
  subpath, which §4.5 does not mandate — but they document surface this change
  actually ships, so it is completion, not drift. (b) `task-bin-spawn`'s "asserts a
  clear message if `dist/index.js` is absent" and `task-exports`' "importing a
  registry internal from the subpath fails" are test hygiene derived from §3.2's
  visibility table, not new behavior.
- **The two-surface requirements I traced to both ends.** §4.5's fixture widening
  covers `cmd-subagent.test.ts` *and* `cmd-capabilities.test.ts` (both in
  `task-actions`' `files:`). §9's Laziness pair is required on the subagent side
  *and* the capabilities side (`task-actions` AC bullets 3-4). §9's Absent-config row
  has both halves owned — the seam returning `null` (`task-config-loader`) and the
  built-in `--dry-run` still succeeding (`task-bin-spawn`, whose cwd is a fresh
  tmpdir). §3.1's exports map is checked from both ends: declaration (`package.json`)
  and consumption (an out-of-process `.mjs` named import).
- **`task-registry` silently corrects a spec inconsistency in the right direction.**
  §7 writes the loader return as `{ providers: mod.syncProviders ?? [], … }`, whose
  `??` would coerce `null` to `[]` and make §5 step 2 / §9 row 14 unsatisfiable. The
  plan uses `raw === undefined ? [] : raw` (plan:308), preserving `null` for
  `mergeProviders` to reject. Coverage of rows 13 and 14 survives because of this.
- **`listProviderNames` moves unchanged** as §4.4 requires — plan:131-133 is
  byte-equivalent to `src/providers/index.ts:25-27`.
- **§11's nine out-of-scope items have no tasks**, correctly, and guard 3 restates
  the `pangolin-mcp` exclusion. ADR-0005's stale six-vs-nine count is correctly left
  untouched.
- **Row 7's subagent-side positive companion** is owned only by implication
  (`task-actions` AC bullet 4 says capabilities gets "the same negative/positive pair
  as the subagent side", which presupposes the subagent pair). Combined with
  `task-registry`'s explicit unit-level positive, I judge this covered rather than
  under-built.

### Out of lens

- `task-bin-spawn` places a bin-spawn test at `packages/pangolin-cli/test/bin-spawn.test.ts`,
  while the pattern it cites lives at repo-root `test/e2e/mcp-tool-surface.test.ts`;
  whether the package's vitest glob and CI ordering make `dist/` current before that
  file runs is a mechanics question.
- The plan's `## Context` cites spec rev `5827b0c9702c`, and the spec's own audit
  record closes with "Round 3 is due — this entry's `rev` is stale by construction."
