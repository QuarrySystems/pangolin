## Lens: coherence
## Charter: `.claude/audit-charter.md` read in full (enforcement map, recurring bug classes,
verification gotchas). No `CLAUDE.md`/`AGENTS.md` exists in this repo (confirmed absent per
the audit brief). Charter content used only as background for grounding, not as the
comparison target — this lens compares the plan only against itself.

No downstream artifacts were supplied (plan is untracked, all tasks `status: pending`).
That is stated as given, not assumed.

### Central-contract enumeration (required by the assignment)

Every task that defines, consumes, tests, or documents `ConfigProviders` and/or
`getSyncProviders` — **8 of 8 tasks touch it directly or by explicit scoping-out** — compared
type-by-type:

| Task | Role | Exact text |
|---|---|---|
| `task-registry` (L115-120) | **defines** `ConfigProviders` | `interface ConfigProviders { providers: unknown; source: string; }` |
| `task-registry` (L181-192) | **defines** `resolveProviderLazily` | `(name: string, getExtra: () => Promise<ConfigProviders \| null>): Promise<SyncProvider>` |
| `task-config-loader` (L263) | **imports** `ConfigProviders` | `import type { ConfigProviders } from './providers/registry.js';` |
| `task-config-loader` (L265-270) | **defines** `CliContext.getSyncProviders` | `getSyncProviders: () => Promise<ConfigProviders \| null>;` — matches `resolveProviderLazily`'s `getExtra` param exactly |
| `task-config-loader` (L304-309) | **defines** `defaultGetSyncProviders` | returns `Promise<ConfigProviders \| null>`, body constructs `{ providers, source }` matching the interface shape |
| `task-actions` (L376) | **consumes** | `resolveProviderLazily(opts.provider, ctx.getSyncProviders)` — argument order and types match L181-184 exactly |
| `task-actions` (L384-386) | **tests** | fixture supplies `getSyncProviders: async () => null` matching the `ConfigProviders \| null` return type |
| `task-barrel` (L434-440) | **scopes out** | whole-file barrel deliberately omits `ConfigProviders` — correct, since spec's own placement table (not my lens, cited only for cross-check) puts it in `registry.ts`, never `index.ts` |
| `task-bin-spawn` (L483-519) | **exercises indirectly** | no direct type reference; spawns the real bin to pin `:110`'s wiring of `getSyncProviders` |
| `task-exports` | **does not touch** | subpath exports `SyncProvider`/`ClaudeCodeProvider`/etc., never `ConfigProviders` — consistent, registry stays internal |
| `task-docs` (L644-651) | **documents** the *user-facing* `syncProviders: SyncProvider[]` config export, never the internal `ConfigProviders` envelope — correctly scoped, no drift |
| `task-changelog` (L696) | **records** | `getSyncProviders: () => Promise<ConfigProviders \| null>` — byte-identical to `task-config-loader`'s L269 declaration |

**Result: all 8 tasks are mutually consistent on the central contract's exact type signatures.**
No task states a conflicting shape for `ConfigProviders`, no task gives `getSyncProviders` a
different signature, and the `providers: unknown` / `source: string` field types are never
narrowed or widened inconsistently across the set. This is the headline "no finding" of this
audit and is listed with its full working set per the assignment's grounding requirement.

Three narrower defects were found elsewhere in the document, detailed below.

### Grounding table

| Assumption | Where in artifact | Verified at file:line | Verdict |
|---|---|---|---|
| `ConfigProviders` shape identical across all producers/consumers | L115-120, L263, L269, L304-309, L696 | same doc | VERIFIED |
| `resolveProviderLazily` signature matches its sole call site | L181-184 vs L376 | same doc | VERIFIED |
| mermaid edges match `depends_on:` frontmatter, all 8 tasks | L20-26 vs L92,246,355,419,472,542,605,677 | same doc | VERIFIED |
| mermaid `files: … +N more` counts match each task's `files:` list length | L11-18 vs each task's frontmatter | same doc | VERIFIED |
| `CHANGELOG.md` is touched by exactly one task | grep `files:` across whole document | L679 is the only occurrence | VERIFIED |
| Task-count / parallelism prose ("leaves", "forks early") matches the DAG | L44-50 vs L20-26 | same doc | VERIFIED (loose wording, not a factual conflict) |

### Findings

- **DEFERRED** · `task-actions`'s acceptance criteria assert a "positive" subagent-side test
  that no bullet or code block in the same task actually establishes.
  - Artifact text: "`capabilities sync --provider claude-code --from <dir> --dry-run`
    likewise, and its config-provider counterpart **does** invoke the seam — the capabilities
    side gets the same negative/positive pair as the subagent side, not just the negative."
    (L405-407)
  - Evidence: the only two subagent-side items in the same acceptance list are L400-402 (the
    widened `--provider made-up` test, which reaches the seam but never resolves to a
    config-supplied provider) and L403-404 (`--provider claude-code --dry-run` with a
    *throwing* `getSyncProviders` fake — a **negative**, proving built-ins skip config). Scope
    guard 1 in `## Context` independently states "`test/cmd-subagent.test.ts:129` … is the
    only test that reaches the new seam" (L61-64), confirming no pre-existing positive case
    exists to inherit. Neither the `## Implementation` block (L371-393, which shows only the
    widened-fixture negative test) nor any other bullet supplies a subagent-side case where a
    config-supplied name is resolved and registered successfully. So "the same … pair as the
    subagent side" describes something the subagent side does not, per this task's own text,
    have.
  - Concrete failure: an implementer trusting L405-407's comparison will conclude
    `cmd-subagent.test.ts` already carries the positive (config-provider-resolves) case and
    will not add one, leaving the `subagent sync` command's exercise of the central contract's
    primary success path — a config-registered provider being found and used — untested,
    while the capabilities side is. No automated gate (`pnpm -r test` etc.) will flag the
    asymmetry, since nothing declares it required by name.
  - Resolution: undecided as written — the author must either (a) add an explicit acceptance
    bullet for `cmd-subagent.test.ts`'s positive case (mirroring the capabilities-side wording
    at L405-406), or (b) correct L407 to state plainly that the positive pair is *new* for
    both files, not something the subagent side already has.

- **DEFERRED** · `task-changelog`'s acceptance criteria require `### Added` entries that
  neither its own task description nor its `## Implementation` block produce, and no other
  task's `files:` list touches `CHANGELOG.md` to supply them.
  - Artifact text: task body — "Record the `CliContext` breaking change under the existing
    `### Breaking` convention. … there is no implementation or test pair to anchor, only the
    record itself." (L686-688). `## Implementation` (L693-699) shows only a `### Breaking`
    block. Acceptance criteria — "The `syncProviders` config export and the `./providers`
    subpath are listed separately under `### Added` — they are additive, unlike the context
    change." (L708-709)
  - Evidence: a repo-wide grep of this document for `files:` (search 1) shows `CHANGELOG.md`
    appears only once, at L679, inside `task-changelog`'s own frontmatter — no other task can
    close this gap. A second search — reading every task's `## Implementation` block in full —
    confirms none of `task-exports`, `task-docs`, or any other task touches `CHANGELOG.md`.
    The task's own scoping sentence ("Record the `CliContext` breaking change …") frames the
    task narrowly around the Breaking entry alone, in tension with its own 4th acceptance
    bullet, which requires two more, unspecified `### Added` lines.
  - Concrete failure: given `model_hint: cheap` and `review_mode: merged` (L682-683) — the
    lowest-scrutiny combination on this task list — an implementer following the literal
    `## Implementation` content will produce a `CHANGELOG.md` missing the required `### Added`
    entries, failing its own 4th acceptance bullet, with no automated check to catch it
    ("Test file: none … verified by review", L711-712) and reduced review rigor to catch it
    manually.
  - Resolution: undecided as written — either widen `## Implementation` to include the two
    `### Added` lines verbatim (removing the ambiguity about their exact wording), or narrow
    the acceptance criteria to drop the requirement if it belongs to a different task.

- **DEFERRED** · `task-bin-spawn`'s acceptance criteria describe a behavior (a clear message
  on missing `dist/index.js`) that the task's own `## Implementation` code does not contain
  and cannot satisfy as written.
  - Artifact text: "Depends on `dist/` being current — the test asserts a clear message if
    `dist/index.js` is absent rather than failing with a bare ENOENT." (L533-534)
  - Evidence: `## Implementation` (L483-519) shows both `it(...)` blocks calling
    `run(process.execPath, [join(__dirname, '../dist/index.js'), …], …)` directly, with no
    existence check, no `try/catch`, and no custom error message anywhere in the shown code.
    If `dist/index.js` is absent, `execFile` (wrapped as `run`) would reject with Node's
    default `ENOENT` error — exactly the "bare ENOENT" the acceptance criterion says must be
    avoided. Compared against `task-exports`'s parallel caveat ("`pnpm -r build` runs before
    this test in CI, so `dist/` is current," L597) — which makes no claim about the *test
    itself* detecting staleness — `task-bin-spawn`'s bullet is the only one in the document
    asserting the test itself must produce a distinguishing message, and it is the only one
    whose shown code doesn't support that claim.
  - Concrete failure: an implementer copying the shown code produces a test that fails this
    specific acceptance bullet; if reviewed loosely (this task carries no `model_hint`/
    `review_mode` override, so it inherits the plan-level `standard` default at L4-6, somewhat
    mitigating the risk relative to `task-changelog` above), the gap either blocks sign-off on
    an otherwise-correct implementation or ships with a confusing bare-ENOENT failure the
    first time someone runs the suite before `pnpm -r build`.
  - Resolution: undecided as written — either add the existence-check snippet to
    `## Implementation` (e.g., a `beforeAll`/guard using `access()` before spawning), or drop
    the "clear message" requirement from the acceptance criteria and rely on the CI-ordering
    assumption alone, matching `task-exports`'s framing.

### Checked, no finding

- The central `ConfigProviders` / `getSyncProviders` contract: type-identical across all 8
  tasks that touch it (full enumeration and comparison above). No two tasks disagree on field
  names, field types, or function signatures.
- Mermaid `depends_on` edges (L20-26) against every task's `depends_on:` frontmatter — exact
  match, all 8 tasks, both directions (no edge in the diagram missing from frontmatter, no
  frontmatter edge missing from the diagram).
- Mermaid `files: … +N more` annotations (L11-18) against each task's `files:` list length —
  exact arithmetic match for all 8 tasks.
- `files:` frontmatter against the paths named in each task's `## Implementation` code-block
  headers — checked for all 8 tasks; every path in a code-block comment corresponds to an
  entry in that task's `files:` list, and files without a shown snippet (e.g.
  `cmd-capabilities.ts`, `cli.md`) are consistently described in prose/acceptance criteria
  instead, matching this document's general illustrative-snippet convention (seen uniformly
  across `task-registry`, `task-config-loader`, `task-actions`, `task-exports`) rather than a
  contradiction.
- Naming consistency across the five related-but-distinct identifiers in this domain —
  `PROVIDERS` (built-in map, task-registry only), `ConfigProviders.providers` (raw unvalidated
  field), `syncProviders` (the user's config export name, task-config-loader/task-docs),
  `getSyncProviders` (the `CliContext` seam, task-config-loader/task-actions/task-changelog),
  and `extra`/`getExtra` (the registry's internal parameter names for the same raw value,
  task-registry only) — no task swaps or conflates any of these five.
- Scope-guard arithmetic: "44 construction sites across 12 test files" (L54-55) against "the
  suite's only built-in miss … fixes that file and, defensively, `test/cmd-capabilities.test.ts`
  … the other ten test files are out of scope" (L61-65) — 12 − 2 = 10, consistent, and matches
  `task-actions`'s own acceptance bullet "`grep -c \"getSyncProviders\"` … counts exactly the
  two files … the other ten … are untouched" (L408-410).
- Per-task `model_hint`/`quality_reviewer_hint`/`review_mode` overrides (`task-registry`:
  `opus`/`opus`; `task-changelog`: `cheap`/`merged`/`is_wiring_task`) against the plan-level
  defaults (L4-6) — both overrides carry explicit in-task rationale, not unexplained
  divergence.

### Out of lens

- `task-exports`'s `## Implementation` test snippet (L580) references an undefined `pkgRoot`
  identifier with no binding shown anywhere in the task — plausibly an ambiguity/grounding
  finding on illustrative-code completeness, not a coherence contradiction between two stated
  facts.
