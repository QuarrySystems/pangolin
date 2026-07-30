# Lens: ambiguity + testability (round 2, full scope)

## Charter: read

- `.claude/audit-charter.md` — enforcement map (row 1 `src` typecheck, row 2 `typecheck:test`
  opt-in), recurring bug class "green tests, dead runnable artifact", verification gotchas.
- `docs-site/src/content/docs/reference/cli.md:33-49`, `.../reference/config.md:10-30`,
  `.../how-to/sync-capabilities-subagents.md` (target of §10),
  `.../explanation/decisions/0005-privileged-ops-never-ai-reachable.md`.
- No `CLAUDE.md` / `AGENTS.md` in this repo (confirmed by the task brief and by
  `find . -maxdepth 3 -iname "CLAUDE.md"` returning only the vault-root file outside the repo).

**No downstream context.** There is no plan consuming this spec, no landed code, and the spec
is untracked. Every finding below is therefore graded against the spec text alone; none can be
STALE.

**Note on this lens and UI:** the spec adds no UI and no template-bound surface, so the
DOM-level half of the lens has no subject. Its CLI analogue — behavior observable only through
commander wiring and the real `pangolin` bin, as opposed to a directly-called function — is
where I applied it (F2, F6, F9).

---

## Grounding table

| Assumption | Where in artifact | Verified at file:line | Verdict |
|---|---|---|---|
| A missing required `CliContext` member at the sole construction site ships with `typecheck` green | §4.5 "tsconfig.json sets `\"include\": [\"src/**/*\"]` … `typecheck` all green" | `packages/pangolin-cli/tsconfig.json:6` (`include: ["src/**/*"]`), `package.json:31` (`"typecheck": "tsc --noEmit"`), `src/index.ts:110` — :110 **is inside `src/`** | **CONTRADICTED** |
| `--dry-run` skips the client entirely | §4.2 | `cmd-subagent.ts:125`, `cmd-capabilities.ts:60` — both `opts.dryRun ? null : await ctx.getClient()` | VERIFIED |
| The throwing-fake idiom exists at `test/cmd-orch.test.ts:802-807` | §9 laziness row | `test/cmd-orch.test.ts:803-810` (`function throwingCtx()`, throw at `:807`) | VERIFIED (off by one at the boundaries) |
| `listProviderNames` has zero callers | §4.4 | Symbol grep `resolveProvider\|listProviderNames` across `packages/**/{src,test}` → only `src/providers/index.ts:25` and `dist/providers/index.d.ts:3`; second strategy: same grep repo-wide incl. `examples/`, `deploy/` → no additional hit | VERIFIED |
| `cmd-subagent.ts:21` / `cmd-capabilities.ts:22` are the provider imports | §3.2 | `cmd-subagent.ts:20` and `cmd-capabilities.ts:21` are the `resolveProvider` imports; `:21`/`:22` are the `runSync` imports | **CONTRADICTED** (off by one, both) |
| `source` (the config filename) is available where `resolveProvider`/`resolveProviderLazily` is called | §4.3, §4.4, §4.6 | No supply path: §4.5 seam is `() => Promise<SyncProvider[]>` (providers only); §7 `loadConfigModule` returns `{mod, filename}` but is private to the default loaders; §4.2's own call sketch passes **two** args to a **three**-param function | **CONTRADICTED** → F1 |
| `(dry-run) subagent <n>` is the printed form | §9 laziness row 3 | `sync.ts:28` — `` `(dry-run) ${opts.kind} ${item.name}` ``, `kind: 'subagent'` at `cmd-subagent.ts:127` | VERIFIED |
| A sync on the default dir in an empty temp cwd "still succeeds" | §9 rows 7, 12, 13 | `claude-code.ts:32` — bare `readdir(dir)`, throws ENOENT; existing tests always pass `--from` (`test/cmd-subagent.test.ts:94,116`; `test/cmd-capabilities.test.ts:38,62`) | fixture precondition UNSTATED (F7 clause, folded) |
| Built `dist/` is available when the `require.resolve` row runs | §9 exports row 2 | `.github/workflows/ci.yml:60-62` — a `Build` step immediately precedes `Test` | VERIFIED (CI); local runs remain build-order-dependent |
| Existing `capabilities sync` fixtures omit `getSyncProviders` | (absent — my own coverage check for F6) | `test/cmd-capabilities.test.ts:36,60` — ctx literals with `getClient` only | VERIFIED |
| A changelog target exists for §4.5's breaking-change requirement | §4.5 "must appear in the changelog" | `CHANGELOG.md:1-17` — root-level, lockstep, `### Breaking` convention at `:12` | VERIFIED (file exists; spec does not name it) |

---

## Requirement inventory

36 atomic requirements. `R?` = more than one reading. `T?` = no stated observable, or the
plausible test is tautological / absence-only / mechanism-blind. Findings referenced by ID.

| # | Requirement (§) | Reading | Observable |
|---|---|---|---|
| R1 | `package.json` gains the exact `exports` map shown (§3.1) | single | §9 r17/r18 — r17 tautological (F9) |
| R2 | `main`/`types` stay for older resolvers (§3.1) | single | **T?** no row asserts they survive (F10) |
| R3 | Single `default` condition; do **not** add a `require`/`import` split (§3.1) | single | §9 r19 — **T?** mechanism unstated (F9) |
| R4 | New `providers/registry.ts` holds `PROVIDERS`, `findBuiltIn`, `resolveProvider`, `mergeProviders`, `validateSyncProviders` (§3.2) | **R?** vs §5/D6 (F3) | partial |
| R5 | `providers/index.ts` = the six SPI exports "and nothing else" (§3.2) | **R?** vs §4.4 (F3) | none |
| R6 | Both `cmd-*` imports repoint (§3.2) | single | compiler |
| R7 | `splitFrontmatter` exported — "if that rationale does not hold …, drop it" (§3.2) | **R?** discretionary vs §8's fixed "six exports" (F3) | none |
| R8 | `syncProviders` named export, `SyncProvider[]` (§4.1) | single | §9 r1 |
| R9 | Built-in first; config consulted only on a miss (§4.2) | single | §9 r5+r6 (subagent only — F6) |
| R10 | `--dry-run` performs no config I/O (§4.2) | single | §9 r7 |
| R11 | `mergeProviders(extra, source) → ReadonlyMap` (§4.3) | single | §9 r1-r4 |
| R12 | Built-ins seed the map; each entry keyed by its own `name` (§4.3) | single | §9 r1 |
| R13 | Three throw cases at merge time (§4.3) | single | §9 r2, r3, r8-r12 |
| R14 | Collision error names "both sides": name + config file + index (§4.3) | **R?** "both sides" then lists one side (F1) | **T?** tautological (F1) |
| R15 | `findBuiltIn(name): SyncProvider \| undefined` (§4.4) | single | §9 r5 |
| R16 | `resolveProvider(name, extra, source)` stays sync (§4.4) | **R?** arity vs §4.2 sketch (F1) | §9 r1 |
| R17 | Unknown-provider error enumerates config providers, built-ins first, insertion order (§4.4) | single | §9 r4 |
| R18 | `listProviderNames` left unchanged at `providers/index.ts:25` (§4.4) | **R?** vs R5 (F3) | none |
| R19 | `CliContext` gains **required** `getSyncProviders: () => Promise<SyncProvider[]>` (§4.5) | **R?** return type vs §4.3/§4.6 `readonly unknown[]` (F1) | compiler |
| R20 | `index.ts:110` must also pass `getSyncProviders: defaultGetSyncProviders` (§4.5) | single | **T?** §9 r13 cannot observe it (F2) |
| R21 | Changelog records this as a breaking context change on a minor bump (§4.5) | **R?** target file unnamed (F10) | **T?** no row, no CI gate |
| R22 | `--provider` help text stays generic (§4.5) | single | **T?** absence-only, no row (F10) |
| R23 | `resolveProviderLazily(name, getExtra, source)` in `registry.ts`, both actions use it (§4.6) | **R?** vs §4.2's inline sketch (F1, F6) | §9 r5-r7 (subagent only) |
| R24 | `undefined` short-circuits to `[]` **before** validation (§5.1) | single | §9 r9 — **T?** cannot distinguish from R25 (F5) |
| R25 | `null` **and** every other non-array value rejected, naming the config file (§5.2) | single | **T?** no row isolates `null` (F5); filename tautological (F1) |
| R26 | Entry rejected if not an object, or `name` not a non-empty string, or any of four members missing/wrong-typed; error names file **and** index (§5.3) | single | §9 r10-r12 — **T?** "not an object" unrowed (F5) |
| R27 | Both dir fields validated unconditionally (§5) | single | §9 r12 |
| R28 | `getSyncProviders` returns `[]` in three absent cases (§6) | single | §9 r9, r13 |
| R29 | `loadConfigModule` helper; copies 1+2 collapse, copy 3 stays (§7) | single | §9 r14 — **R?** "all three consumers" (F7) |
| R30 | The four existing error strings unchanged, thrown verbatim on `null` (§7) | single | §9 r15 (explicitly non-tautological — good) |
| R31 | Pointer comment in all three loaders; a line in `config.md` (§7) | single | **T?** review-only (acceptable) |
| R32 | SPI ships provisional, scoped to the subpath's six exports; docs state the `loadSubagents(dir)` reason (§8) | **R?** "six" vs R7 (F3) | review-only |
| R33 | The how-to becomes the authoring guide, five listed bullets (§10) | single | review-only |
| R34 | `config.md` gains `syncProviders` + the two-processes note (§10) | single | review-only |
| R35 | `cli.md:37,49` rows updated (§10) | **R?** no target state stated (F10) | none |
| R36 | No ADR (§10) | single | n/a |

---

## Findings

### F1 · **BLOCKING** · `source` has no supply path at the call sites the spec specifies, so every "error names the config file" requirement is either unimplementable as written or tautologically tested

- Artifact text (§4.3): "`export function mergeProviders(extra: readonly unknown[], source: string): ReadonlyMap<string, SyncProvider>;` … `source` is the config filename, so the errors below can name it."
- Artifact text (§4.4): "`export function resolveProvider(name: string, extra: readonly unknown[], source: string): SyncProvider;`"
- Artifact text (§4.2), the call sketch that an implementer copies:
  ```ts
  const provider =
    findBuiltIn(opts.provider) ??
    resolveProvider(opts.provider, await ctx.getSyncProviders());
  ```
  — **two arguments to a three-parameter function.**
- Artifact text (§4.5): "`getSyncProviders: () => Promise<SyncProvider[]>;`"
- Evidence that no seam carries the filename:
  - §4.5's seam returns providers only; the resolved filename is not in its type.
  - §7's `loadConfigModule(): Promise<{ mod: Record<string, unknown>; filename: string } | null>` does
    hold `filename`, but it is described as private plumbing for `defaultGetClient` /
    `defaultGetOrchContext` / `defaultGetSyncProviders`, and `defaultGetSyncProviders` is specified
    to return `[]` / the array — the filename dies there.
  - The real call sites are `cmd-subagent.ts:122` and `cmd-capabilities.ts:57`; both have only
    `opts` and `ctx` in scope (`cmd-subagent.ts:121`, `cmd-capabilities.ts:56`). Neither can know
    whether `pangolin.config.ts`, `.js`, or `.mjs` was the file that resolved — that loop lives at
    `index.ts:52` / `index.ts:77` and, post-consolidation, inside `loadConfigModule`.
  - Two independent negative strategies for "no other mechanism is stated": (a) full-text read of
    §§4.2-4.6, §5, §7 for the token `source`/`filename` — the only occurrences are the three
    signatures and §7's helper return; (b) the spec's own §4.2 sketch omits the argument, which is
    the strongest available evidence that the author had nothing to pass either.
- Concrete failure: the implementer must invent the plumbing. The cheapest invention — a literal at
  the call site, e.g. `resolveProviderLazily(opts.provider, ctx.getSyncProviders, 'pangolin.config.mjs')`
  — makes `mergeProviders` emit a filename that is a *guess*. In a repo using `pangolin.config.js`
  (a legal, supported leg per `index.ts:52` and `config.md:18-20`), the collision error and every
  §5 validation error name a file that does not exist, sending the user to the wrong place. That is
  strictly worse than naming nothing.
- Testability consequence, which is why this is my lens and not only design's: three §9 rows —
  "collision with a built-in throws, and the message contains the name, the **config filename**, and
  the entry index", "non-array export rejected, **naming the config file**", "entry missing
  `loadSubagents` rejected, naming the index" — are all satisfiable by a unit test that calls
  `mergeProviders([...], 'pangolin.config.mjs')` and asserts the message contains
  `'pangolin.config.mjs'`. **That asserts a constant against the same constant the test just typed**
  and proves nothing about provenance. There is no row anywhere in §9 in which a *real config file's
  name* reaches a *real error message*, so the requirement the `source` parameter exists to serve is
  never observed end to end.
- Secondary reading defect on the same seam: §4.5 types the seam `Promise<SyncProvider[]>` while
  §4.3/§4.6 type the same values `readonly unknown[]`. Under §5 these values are unvalidated until
  `mergeProviders` runs, so `SyncProvider[]` is a false assertion at the seam — and one the compiler
  will not challenge, because the values come from a dynamic `import()` and because `pangolin-cli`
  has no `tsconfig.test.json` (`.claude/audit-charter.md:22-39`), so no test fixture is type-checked
  against it either. A reader can legitimately conclude validation happens in the loader, which
  contradicts D6.
- Resolution: undecidable as written — the author must choose between
  **(A)** widening the seam, e.g. `getSyncProviders: () => Promise<{ providers: readonly unknown[]; source: string }>`
  (also fixing the type contradiction, and letting §9 gain one row where a fixture named
  `pangolin.config.js` produces an error containing `pangolin.config.js`), or
  **(B)** dropping `source` from the signatures and specifying a provenance-free error wording —
  in which case §4.3's "the config file" and §5's "naming the config file" and the three §9 rows
  must all be reworded. Whichever is chosen, §4.2's two-argument sketch must be corrected to match
  §4.4/§4.6.

### F2 · **DEFERRED** · The §9 wiring row was written to close B2 but cannot observe `index.ts:110`; its stated justification is contradicted by the repo's own typecheck scope

- Artifact text (§9): "Wiring (§4.5) | drive `buildProgram({ getClient: defaultGetClient, getOrchContext: defaultGetOrchContext, getSyncProviders: defaultGetSyncProviders })` through `parseAsync` in a temp cwd — **catches an unwired `index.ts:110`, which no current test can**"
- Artifact text (§4.5): "nothing currently catches its omission … so a missing member would ship as a runtime `TypeError` with `test`, `lint`, and `typecheck` all green."
- Evidence:
  - The described test **constructs its own three-member context literal**. `index.ts:110` constructs
    a different literal, inside `if (typeof require !== 'undefined' && require.main === module)`
    (`index.ts:109`), which never executes under `vitest`. A test that builds an equivalent context
    passes identically whether or not `:110` was edited. This is verbatim the charter's recurring bug
    class — `.claude/audit-charter.md:51-58`, "the entrypoint or wiring line that real invocation goes
    through is constructed differently by tests than by production" — and B2 is *itself* listed there
    as instance 2 (`:63-68`).
  - The row's justification is also wrong in the other direction: `tsconfig.json:6` is
    `"include": ["src/**/*"]` and `package.json:31` is `"typecheck": "tsc --noEmit"`. `src/index.ts:110`
    is in `src`. A **required** member (§4.5: "The member is **required**, not optional") missing from
    the object literal at `:110` is TS2345 and fails both `pnpm -r typecheck`
    (`.claude/audit-charter.md:21` → CI failure) and `pnpm -r build`. The `include: src/**/*` fact the
    spec cites is about **test** files, which is a different claim than the one it is used to support.
  - The row also states no argv and no assertion. Driven with `defaultGetClient` in an empty temp cwd,
    any real subcommand throws `pangolin-cli: no pangolin.config.{ts,js,mjs} found` (`index.ts:68`)
    unless argv is a `--dry-run` sync, and a `--dry-run` sync on the default dir throws ENOENT at
    `claude-code.ts:32` unless the row also stipulates `--from` or a `.claude/agents` fixture — the
    existing sync tests all pass `--from` (`test/cmd-subagent.test.ts:94,116`).
- Concrete failure: none at runtime — the compiler catches the actual omission, which is why this is
  DEFERRED rather than BLOCKING. The failure is documentary: a false detection claim in the artifact
  that a future reader (or a future optional-member variant of this change, where the compiler goes
  silent) will rely on.
- Resolution: either (a) restate the row honestly — "the compiler catches an unwired `:110` because
  the member is required; this row instead pins that `defaultGetSyncProviders` is *usable* as the
  wired value" — and give it argv + an assertion + a fixture; or (b) make it a real bin spawn on the
  `test/e2e/mcp-tool-surface.test.ts:26-39` pattern (`node dist/index.js` as a child in a temp cwd),
  which is the only construction that observes `:110`. Correct §4.5's premise either way.

### F3 · **DEFERRED** · §3.2's barrel-split table is inconsistent with §4.4, §5/D6, and §8 — three exports are unplaced or double-placed

Three separate readings, one table:

1. **`listProviderNames` is in neither column.** §3.2 assigns `registry.ts` five members and
   `index.ts` six, and `listProviderNames` appears in neither list — yet §4.4 says it "is **left
   unchanged**" and cites its current home, `providers/index.ts:25`, while simultaneously saying it
   "is not part of the published SPI barrel (§3.2)". Under §3.2 the barrel *is* `providers/index.ts`
   and contains "**the published SPI, and nothing else**". The two statements cannot both hold.
   Readings: (a) it moves to `registry.ts` with its body unchanged — then "left unchanged" and the
   `:25` citation mislead; (b) it stays at `providers/index.ts:25` — then it is published, contra
   §3.2 and §8. Verified it currently lives at `src/providers/index.ts:25` with zero callers
   (grounding table).
2. **`validateSyncProviders` is listed as a distinct member of `registry.ts`** while D6 and §5 say
   "Validation lives **inside `mergeProviders`** (D6) rather than in a separate pass." Round 1
   resolved "validator had no call site" by folding it in; the table still names the folded-away
   function. Readings: (a) an unexported local helper called by `mergeProviders`; (b) a separate
   exported function, which reopens the round-1 finding. No §9 row names it, so neither reading is
   pinned by a test.
3. **`splitFrontmatter` is discretionary in §3.2** ("If that rationale does not hold at
   implementation time, drop it") but fixed in §8 ("D9 scopes to the `./providers` subpath
   specifically — the **six exports** listed in §3.2"). If the implementer exercises the licence, the
   count is five and §8 is wrong.

- Concrete failure: for (1) reading (b), a zero-caller function is published on the new subpath and
  the "narrow because removal is breaking" argument in §3.2 is defeated by the very first commit; for
  (2) reading (b), a validator can again exist without a mandatory call site. Neither is a runtime
  break, hence DEFERRED.
- Resolution: add `listProviderNames` to the `registry.ts` row (and change §4.4's "left unchanged" to
  "moved unchanged"), state whether `validateSyncProviders` is an unexported local, and make §8 say
  "the exports listed in §3.2" rather than "six".

### F4 · **DEFERRED** · The two `null` cases that the natural implementation gets wrong have no distinguishing row

- Artifact text (§5): "1. `undefined` … short-circuits to `[]` before validation (D7). It is not
  treated as a malformed value. 2. `null` **and every other non-array value are rejected**, naming
  the config file. 3. Each entry is rejected if it is **not an object**, or if …"
- Artifact text (§9): "Validation | non-array export rejected, naming the config file" and
  "Validation | `undefined` export yields `[]` (not a validation error)".
- Evidence / failure mode: the idiomatic first draft of this check is
  `if (!extra) return [];` followed by `if (!Array.isArray(extra)) throw …`. That implementation
  **passes both rows** — `undefined → []` holds, and a non-array *truthy* fixture (`{}`, `'x'`, `7`)
  is still rejected — while silently violating §5 step 2 for `null`. Likewise no row supplies a
  non-object *entry* (`[null]`, `['remora']`), and the idiomatic per-entry check reads
  `entry.name`/`entry.loadSubagents` first, so `[null]` yields `TypeError: Cannot read properties of
  null` instead of the specified indexed error. §5 step 3 explicitly requires "rejected if it is not
  an object"; §9 has rows only for a *missing member* and a *non-string name*, both of which require
  the entry to already be an object.
  This matters because §5's `undefined`-vs-`null` split is precisely what round-1 JR2 resolved — the
  resolution landed in prose and did not land in the test table.
- Concrete failure: `export const syncProviders = null` in a `.mjs` config yields `[]` instead of a
  config error, so `--provider remora` reports `unknown --provider 'remora' (known: claude-code,
  stoa)` — a diagnostic that points away from the actual mistake. `export const syncProviders =
  [null]` crashes with a raw `TypeError` instead of the specified "config file + index" message.
- Resolution: add two rows — "`null` export rejected (**not** `[]`) — the row that separates D7's
  `undefined` case from §5.2" and "a non-object array entry (`null`, string) is rejected naming its
  index, not a `TypeError`".

### F5 · **DEFERRED** · `capabilities sync` has zero rows; the config-provider path is pinned on one of the two call sites

- Artifact text (§9): all three Laziness rows plus the Absent-config row are phrased around
  `subagent` (row 7 asserts the literal `(dry-run) subagent <n>`); no row mentions
  `capabilities sync`.
- Evidence: there are two independent action call sites — `cmd-subagent.ts:122` and
  `cmd-capabilities.ts:57` — and §4.2 presents the resolve as an **inline two-liner** while §4.6
  presents it as a shared `resolveProviderLazily`. An implementer who follows §4.2's sketch has two
  places to get right.
  Partial mitigation I verified, which is why this is DEFERRED and not BLOCKING: the existing
  fixtures at `test/cmd-capabilities.test.ts:36` and `:60` construct `{ getClient }` contexts with
  **no** `getSyncProviders`, so an *eager* call in the capabilities action would throw
  `ctx.getSyncProviders is not a function` and turn those suites red — laziness is incidentally
  pinned. That mitigation evaporates the moment someone tidies the fixtures to match the widened
  `CliContext` (nothing forces them to, since `pangolin-cli` has no `tsconfig.test.json` —
  `.claude/audit-charter.md:31`).
- What remains genuinely unpinned: that the **config path is wired into the capabilities action at
  all**. `pangolin capabilities sync --provider remora` failing with `unknown --provider 'remora'`
  is consistent with all 19 rows and every existing test.
- Resolution: add one row — "`capabilities sync --provider remora` resolves the config provider and
  calls its `loadCapabilities`" — or state explicitly that both actions must call
  `resolveProviderLazily` and that the row is deliberately provider-agnostic.

### F6 · **DEFERRED** · The three Exports rows do not state their execution mechanism, and one of them is the mechanism-blind case the spec itself warns about

- Artifact text (§9): "Exports | `package.json` `exports` declares both `\".\"` and `\"./providers\"`" ·
  "Exports | `require.resolve(...)` … both resolve against **built `dist/`**, not vitest-transformed
  sources" · "Exports | a real `.mjs` file named-imports `ClaudeCodeProvider` from the subpath and
  instantiates it — pins the CJS-lexer interop of §3.1".
- Artifact text (§3.1): "**Do not add a `require`/`import` condition split.** This was verified by
  reproducing tsc's emit shape and importing it from `.mjs`; §9 pins it against real build output."
- Evidence: the third row is the only guard on §3.1's load-bearing interop instruction, and its
  outcome depends entirely on an unstated choice. If the fixture is loaded with
  `await import(pathToFileURL(fixture))` from inside a vitest test, vite's module runner transforms
  it and the `cjs-module-lexer` path — the actual attribute under test — is never exercised: a spy
  blind to the mechanism. Only `spawn('node', [fixture])` (or `execFileSync`) observes it. The
  pattern exists in-repo at `test/e2e/mcp-tool-surface.test.ts:26-39` (real child-process bin spawn),
  and the charter names this exact hazard (`.claude/audit-charter.md:88-91`: "all green — does not
  establish that the shipped binary or example runs"). The spec's closing paragraph says "a
  vitest-only assertion would not observe the shipped resolution path at all" — it diagnoses the
  hazard without turning it into a stated requirement of the row.
  Row 1 is separately a constant-vs-constant assertion: it reads the `exports` keys out of
  `package.json` and compares them to the keys the implementer typed into `package.json`. It has
  lock value, but it proves no resolution behavior and is subsumed by row 2.
  Row 2's precondition is verified sound in CI (`.github/workflows/ci.yml:60-62` builds immediately
  before test) but is order-dependent locally.
- Concrete failure: the interop claim ships unpinned; an out-of-tree `.mjs` consumer gets
  `SyntaxError: The requested module … does not provide an export named 'ClaudeCodeProvider'`, which
  is total failure of D1, while §9 is green.
- Resolution: state the mechanism in the row — "spawn `node <fixture>.mjs` as a child process from a
  temp dir; assert stdout, not an in-process import" — and mark row 1 as a lock rather than a
  behavior test.

### F7 · **DEFERRED** · "across all three consumers" in the Loader row has two readings that differ by a whole package

- Artifact text (§9): "Loader | `.js` and `.mjs` resolve in precedence order **across all three
  consumers** (see EU1 for `.ts`)".
- Evidence: the immediately preceding section, §7, is built on a table of "**Three copies** of the
  same resolution loop" whose third entry is `packages/pangolin-mcp/src/bin.ts:14-49` — a different
  package, verified at `packages/pangolin-mcp/src/bin.ts:21` (the same filename triple) and
  `:48`. But §7 also establishes that copies 1 and 2 collapse into `loadConfigModule`, whose
  consumers are `defaultGetClient`, `defaultGetOrchContext`, and `defaultGetSyncProviders` — also
  three, all in `pangolin-cli`. Reading A costs one test file in `pangolin-cli`; reading B additionally
  requires a test in `packages/pangolin-mcp` against a loader §7 explicitly decided **not** to touch,
  and D10 says that copy stays. The word "consumers" leans A, the adjacency of §7's "three copies"
  table leans B.
- Concrete failure: the `pangolin-mcp` leg is either tested twice or not at all, and a reviewer
  cannot tell which the spec asked for.
- Resolution: name them — "across `defaultGetClient`, `defaultGetOrchContext`, and
  `defaultGetSyncProviders`" (and say explicitly whether `pangolin-mcp`'s copy is in or out).

### F8 · **DEFERRED** · Four requirements state no observable end state

- **R35 / §10** — "`docs-site/src/content/docs/reference/cli.md:37,49` — the `sync` and `--provider`
  rows **become incomplete** once `--provider` resolves config-supplied names." That is a diagnosis,
  not an instruction: it names no target text and no acceptance condition. Both rows exist and were
  read (`cli.md:37` capabilities `sync`, `cli.md:49` subagent `sync`); neither mentions where
  provider names come from, so "complete" is undefined. Two readings: rewrite the rows to describe
  config-supplied resolution, or merely add a pointer to the how-to.
- **R21 / §4.5** — "it must appear in the changelog as a breaking context change, not as an additive
  one." The target file is never named. There is exactly one, `CHANGELOG.md` (root, lockstep, with a
  `### Breaking` heading convention at `:12`), and no per-package changelog — so the requirement is
  satisfiable, but a reader cannot tell that from the spec, and nothing in the enforcement map
  (`.claude/audit-charter.md:19-25`) gates it.
- **R22 / §4.5** — "**Static help text stays generic.**" This is a diff property with no row. The
  only test anyone would write ("`--help` does not list config providers") passes on any crash and on
  a no-op. Its positive-with-control form is worth stating: `--help` succeeds *and* does not call a
  throwing `getSyncProviders` fake — which also pins the more valuable property, that `--help` never
  imports the config.
- **R2 / §3.1** — "`main` and `types` stay for older resolvers." No row. §9's row 17 asserts the
  `exports` keys only, so a later edit that drops `main` while keeping `exports` is green.
- Concrete failure: each is a requirement a reviewer must adjudicate by taste. R22 is the one with
  live risk, because a "helpful" implementer enumerating providers in the help string would
  re-introduce eager config loading on **every** invocation — exactly the property D4 exists to
  protect — and no row in §9 would notice.
- Resolution: give R35 a target sentence; name `CHANGELOG.md` in R21; add one row for R22 in the
  positive-with-control form above; fold R2 into the row-17 lock.

---

## Checked, no finding

- **The laziness pair is constructed correctly.** §9 rows 5 and 6 are a throwing-fake negative plus
  an explicit positive companion, and the spec says why ("without this, the row above passes on a
  no-op"). The throwing-fake idiom it cites is real (`test/cmd-orch.test.ts:803-810`). This is the
  exact shape my lens exists to demand and it is already here — do not touch it.
- **Row 15 (loader error strings) pre-empts the tautology.** "asserted against values written into
  the test, not imported from source" is the right instruction, and the four literals are where the
  spec says (`index.ts:63,68,88,93`). Note only that `:68` and `:93` are byte-identical strings, so
  "four literals" is three distinct texts driven through two functions — harmless.
- **Row 4 (unknown-provider enumeration) is fully determinate.** §4.4 pins the order ("Map insertion
  order, built-ins first"), so the assertion has one correct expected string rather than a set.
- **R27 (unconditional dir validation) is unambiguous and rowed**, and §5 gives the reason
  (`cmd-subagent.ts:123`, `cmd-capabilities.ts:58` read the fields only when `--from` is absent —
  both verified).
- **R17/§4.4's `listProviderNames` zero-caller claim is true** (two search strategies, grounding
  table) — the ambiguity in F3 is about *placement*, not about that claim.
- **D3/D4 interaction is stated, not left implicit.** §4.2's "Consequence for D3, accepted
  deliberately" removes what would otherwise be a silent behavior change; row 5 covers it positively.
- **No UI, no template-bound surface, no two-way binding** — the DOM half of this lens has no
  subject in this artifact. Its CLI analogue (behavior reachable only through commander/the real bin)
  is covered by F2, F5, F6.

## Out of lens

- §3.2's import-path citations are off by one: the `resolveProvider` imports are at
  `cmd-subagent.ts:20` and `cmd-capabilities.ts:21`, not `:21`/`:22` (those are the `runSync`
  imports). Grounding lens.
- §4.5's "`tsconfig.json` sets `include: [\"src/**/*\"]` … so a missing member would ship with
  `typecheck` green" is a false inference about `src/index.ts:110` (see F2 evidence); it may
  invalidate round 1's B2 premise as well. Grounding/charter lens.
- §9's cited idiom range `test/cmd-orch.test.ts:802-807` is `:803-810` in the file. Grounding lens.
