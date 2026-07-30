## Lens: grounding
## Charter: `.claude/audit-charter.md` (enforcement map, recurring bug classes, verification gotchas); no CLAUDE.md/AGENTS.md exists in this repo. Also read the ADR set entry cited by the spec (0005), `privilege-boundary.md`, `package-map.md`, `config.md`, `cli.md`, and the how-to doc the spec rewrites.

This is round 2, full-scope grounding pass. Round 1's citation corrections (ADR-0005
six→nine, `types.ts:6-8`→`:5-6`, config count 4→7, `§8`→`§9` cross-refs, `§1.1`
capabilities→systemPrompt) were re-verified against source, not assumed correct. I
individually checked every `file:line` citation in the document — old and new — against
the cited file's actual content. Downstream context: none (no plan/code consumes this
spec, confirmed by the task brief).

### Grounding table

| Assumption | Where in artifact | Verified at file:line | Verdict |
|---|---|---|---|
| `SubagentDef` carries `promptTemplate`+`systemPrompt` | §1.1 | `providers/types.ts:19-31` | VERIFIED |
| `renderPrompt` Mustache-renders `promptTemplate`, else verbatim `systemPrompt` | §1.1 | `prompt-renderer.ts:26-34` | VERIFIED |
| `ClaudeCodeProvider.loadSubagents` hardcodes `systemPrompt: body` | §1.1 | `claude-code.ts:43` | VERIFIED |
| `StoaProvider` hardcodes the same field | §1.1 | `stoa.ts:70` | VERIFIED |
| `splitFrontmatter` rejects a leading-delimiter-less body | §1.1, §3.2 | `frontmatter.ts:15-21`, `:15`, `:19-21` | VERIFIED |
| `submit-concerns-probe.mjs` reads remora + hand-builds `promptTemplate` against pangolin-client directly | §1.1 | `deploy/serve-stack/client/submit-concerns-probe.mjs:21-29` | PARTIALLY — see finding |
| `PROVIDERS` is a closed module-level const, two entries | §1.2 | `providers/index.ts:11-14` | VERIFIED |
| `resolveProvider` reads only that map | §1.2 | `providers/index.ts:16-23` | VERIFIED |
| How-to doc instructs editing `PROVIDERS` map directly, quote verbatim | §1.2 | `sync-capabilities-subagents.md:136-171`, quoted text at :160-161 | VERIFIED |
| `index.ts` exports exactly 5 things at cited lines | §1.3 | `index.ts:23,32,46,71,99` | VERIFIED (all 5, no 6th export exists) |
| `package.json` declares `main`/`types`, no `exports` | §1.3 | `package.json:6-7` | VERIFIED |
| `dist` in `files`, no encapsulation today | §1.3 | `package.json:11-15` | VERIFIED |
| `StoaProvider` holds `ClaudeCodeProvider`, delegates `loadCapabilities` wholesale | §1.3 | `stoa.ts:36`, `:79-81` | VERIFIED |
| ~110 vs ~240 line estimate for Stoa with/without composition | §1.3 | `stoa.ts` (113 loc), `claude-code.ts` (178 loc) | VERIFIED (estimate checks out: 113 − 3 + ~126 reimplemented ≈ 236) |
| bin.ts's config-resolution loop, unconditional startup exit, `mod.default??mod.client`, `mod.orch` | §1.4 | `pangolin-mcp/src/bin.ts:14-49,53-58,29,41` | VERIFIED, all four sub-citations exact |
| ADR-0005 enforcement paragraph, "the six run-time tool names" | §1.4 | `0005-…ádr.md:71-79` | VERIFIED |
| `tools.ts` registers nine (`PANGOLIN_TOOL_NAMES`) | §1.4 | `tools.ts:41-50` | VERIFIED |
| `privilege-boundary.md` already reflects nine | §1.4 | `privilege-boundary.md:45-59` | VERIFIED |
| `providers/types.ts:40` `name` is `readonly` | §4.1 | `types.ts:40` | VERIFIED |
| offload-fanout config opens SQLite + registers exit hook despite IMPORT-SAFE comment | §4.2 | `offload-fanout/pangolin.config.mjs:63,66,61` | VERIFIED (`SqliteRunStateStore` ctor calls `new Database(path)` synchronously — `runstate/sqlite.ts:94`) |
| `defaultGetClient` is "the only config toucher today" | §4.2 | `index.ts:52-68` | CONTRADICTED — see finding |
| `cmd-subagent.ts:131` ends in `subagent.register()` | §4.3 | `cmd-subagent.ts:131` | VERIFIED |
| `cmd-capabilities.ts:66` ends in `capabilities.register()` | §4.3 | `cmd-capabilities.ts:66` | VERIFIED |
| `--provider` help string location | §4.5 | `cmd-subagent.ts:118`, `cmd-capabilities.ts:53` | VERIFIED |
| `--from` gating on the two dir fields | §4.2, §5 | `cmd-subagent.ts:123`, `cmd-capabilities.ts:58` | VERIFIED |
| `--dry-run` skips the client | §4.2 | `cmd-subagent.ts:125`, `cmd-capabilities.ts:60` | VERIFIED |
| unknown-provider error line, `listProviderNames` line + zero callers | §4.4 | `providers/index.ts:20,25`; `dist/providers/index.d.ts:3` | VERIFIED; zero-caller claim confirmed via two independent greps (`packages/**/src` scoped, whole-repo) |
| `cmd-subagent.ts:21` / `cmd-capabilities.ts:22` are the `resolveProvider` import lines needing a path change | §3.2 | actual: `cmd-subagent.ts:20`, `cmd-capabilities.ts:21` | CONTRADICTED (off by one) — see finding |
| `CliContext` spans `index.ts:23-30`, gains a third seam | §4.5 | `index.ts:23-30` | VERIFIED (2 members today) |
| `index.ts:110` is the sole real construction site | §4.5 | `index.ts:109-110` | VERIFIED |
| `test/bin-entry.test.ts:5-7` builds its own stub, never parses argv | §4.5 | `bin-entry.test.ts:5-7` | VERIFIED |
| No test in `test/e2e/` spawns the `pangolin` (cli) bin | §4.5 | `test/e2e/mcp-tool-surface.test.ts` (repo-root, spawns pangolin-**mcp**'s `dist/bin.js`, not pangolin-cli's) | VERIFIED |
| `pangolin-cli` `tsconfig.json` `include: src/**/*`, no `typecheck:test` | §4.5 | `tsconfig.json:7`, `package.json` scripts | VERIFIED |
| `sync.ts:25` is `runSync`, already factors the shared half | §4.6 | `sync.ts:25` | VERIFIED |
| Every config in the repo is `.mjs`, "seven of them" | §5 | `git ls-files \| grep pangolin.config` → **8** tracked files | CONTRADICTED — see finding |
| `getOrchContext` throws when `orch` export missing | §6 | `index.ts:86-90` | VERIFIED |
| Purity-contract comment | §5 | `providers/types.ts:5-6` | VERIFIED |
| Two dir fields non-optional on interface | §5 | `providers/types.ts:41-44` | VERIFIED |
| `SubagentDef` with neither prompt field throws | §5 | `subagent-register.ts:59-63` | VERIFIED |
| Names segment-checked | §5 | `pangolin-core/src/uri.ts:106` | VERIFIED |
| Bundles size-capped and credential-scanned | §5 | `capabilities-register.ts:39,71-80` | PARTIALLY — see finding (range stops just before the throw / scan call) |
| Hand-rolled idiom precedent | §5 | `manifest-parser.ts:33-90` | VERIFIED |
| Error-string literal locations (4 of them) | §7 | `index.ts:63,68,88,93` | VERIFIED, exact |
| Zero test-dir references to those literals; only doc pin | §7 | repo-wide grep, 3 hits: `config.md`, `index.ts`, `bin.ts`, none under `test/` | VERIFIED |
| `config.md:23` doc pin | §7 | `config.md:23` | VERIFIED |
| Three config-loader copies at cited ranges | §7 | `index.ts:46-69`, `index.ts:71-94`, `pangolin-mcp/src/bin.ts:14-49` | VERIFIED, all three ranges exact (function start through closing brace) |
| Sharing the loader would add an undocumented `mcp→cli` package-graph edge | §7 | `package-map.md` mermaid graph (`mcp --> client` only, no `mcp --> cli`) | VERIFIED |
| `package.json:3` version `0.4.0` | §8 | `package.json:3` | VERIFIED |
| `loadSubagents(dir)` double-meaning (claude-code vs stoa) | §8 | `claude-code.ts:31-32`, `stoa.ts:33`, `:39-40` | VERIFIED |
| `test/cmd-orch.test.ts:802-807` idiom | §9 | same | VERIFIED (pattern present; closing braces fall just past the cited range, immaterial) |
| tsc re-export emit shape `Object.defineProperty(exports,"X",{enumerable,get})` | §3.1 | not directly cited, but checked against `pangolin-orchestrator/dist/index.js:19-23` (real re-export compile output) | VERIFIED — matches the claimed shape exactly, strengthening confidence in the §3.1 argument |
| Stale deep-import comment casualty | §3.3 | `examples/manifest/test/deploy.test.ts:26` | VERIFIED |
| `manifest-parser.ts:70` accepts either prompt field | §11 | same | VERIFIED |
| `cmd-deploy.ts:56` passes `promptTemplate` through | §11 | same | VERIFIED |
| `claude-code.ts:66` bundle path template | §11 | same | VERIFIED |
| 16 packages total, pangolin-cli is the only one with an `exports` map (first in monorepo) | §3.1 | `find packages -maxdepth 1` → 16 dirs; grep for `"exports"` in every `package.json` → 0 hits | VERIFIED |
| EU1: root `package.json` `"node": ">=20"`, CI floats `node-version: '22'` | §9 | `package.json:9`, `.github/workflows/*.yml` | VERIFIED |

### Findings

- **DEFERRED** · §5's config-file count and enumeration are wrong: it says "seven," names six locations, and the actual repo has eight tracked `pangolin.config.mjs` files.
  - Artifact text: "Every config in the repo is `.mjs` — seven of them, including `examples/offload-minio/`, `examples/offload-fanout/`, `examples/handoff-dag/`, `examples/demo-claims-appeals/`, `examples/demo-claims-appeals-minio/`, and `deploy/serve-stack/`."
  - Evidence: `git ls-files | grep -i "pangolin\.config\."` (cross-checked against an independent `find . -iname "pangolin.config.*"` sweep, excluding the `.claude/worktrees/` copy) returns 8 tracked files: the six named, plus `examples/dogfood-gated/pangolin.config.mjs` (67 lines, tracked, clean) and `deploy/serve-stack/client/pangolin.config.mjs` (127 lines, tracked, clean, textually distinct from `deploy/serve-stack/pangolin.config.mjs` — confirmed via `diff`, it is "the laptop kit," a separate config, not a duplicate).
  - Concrete failure: none for implementation — the design conclusion ("plain `.mjs`, no typechecking, so `mergeProviders` must validate shape") holds regardless of whether the count is 7 or 8. This is a factual inaccuracy about current repo state in a spec whose own stated discipline is "every factual claim about current behavior carries a file:line citation," and it is the same class of miscount (stale artifact-count) the round-1 audit already had to correct twice in this document (ADR-0005 six→nine, loader-copy count 4→7).
  - Resolution: recount and either say "eight" and add the two omitted files to the list, or drop the exact count and say "every config in the repo is `.mjs`" without a number.

- **DEFERRED** · §3.2's two new import-path citations are each off by one line, both landing on the `runSync` import instead of the `resolveProvider` import that the barrel split actually requires moving.
  - Artifact text: "`cmd-subagent.ts:21` and `cmd-capabilities.ts:22` change their import path accordingly."
  - Evidence: `cmd-subagent.ts:20` is `import { resolveProvider } from './providers/index.js';`, and `cmd-subagent.ts:21` is `import { runSync } from './sync.js';` (unaffected by the registry split). Symmetrically, `cmd-capabilities.ts:21` is the `resolveProvider` import and `cmd-capabilities.ts:22` is the `runSync` import.
  - Concrete failure: none — the underlying claim (both files' provider import needs a path change once `providers/registry.ts` exists) survives; a reader following the citation lands one line off, on an unrelated import.
  - Resolution: cite `cmd-subagent.ts:20` and `cmd-capabilities.ts:21`.

- **DEFERRED** · §4.2's claim that `defaultGetClient` is "the only config toucher today" is contradicted by the code and by the spec's own §7.
  - Artifact text: "`defaultGetClient` is the only config toucher today (`index.ts:52-68`)"
  - Evidence: `defaultGetOrchContext` (`index.ts:71-94`) runs the identical filename-probe/dynamic-import loop against the same `pangolin.config.{ts,js,mjs}` — it is a second config toucher in the same file. The spec's own §7 table lists it as "Copy 2" of "three copies of the same resolution loop [that] exist today."
  - Concrete failure: none — the paragraph's actual conclusion (sync commands only ever call `getClient`, never `getOrchContext`, so `--dry-run` sync stays config-I/O-free) is true on the narrower, correct premise ("the only config toucher **the sync commands invoke**"), not the broader one actually written.
  - Resolution: scope the sentence to the sync-command call path, e.g. "the only config toucher the sync commands invoke is `defaultGetClient`" — or cite §7's own three-copy table instead of asserting exclusivity.

- **DEFERRED** · Two secondary citations are under-inclusive for the compound claims they support (minor, listed together as they're the same category of imprecision).
  - `pangolin-client/src/capabilities-register.ts:39,71-80` is cited for "bundles are size-capped and credential-scanned" (§5), but the range stops at line 80 (`if (totalSize > FIFTY_MIB) {`) — one line short of the `throw` (81) and short of the actual credential-scan call (84-88), which is not covered at all.
  - `deploy/serve-stack/client/submit-concerns-probe.mjs:21-29` is cited for "reads `remora/agents/dag-implementer.md` and hand-builds a `promptTemplate` against `pangolin-client` directly" (§1.1), but the promptTemplate construction is at lines 30-35 and the `client.subagent.register({ ..., promptTemplate, ... })` call proving "against pangolin-client directly" is at lines 19 (import) and 65-69 — none inside the cited 21-29 range.
  - Concrete failure: none — both underlying claims are true when the fuller file is read; a reader who trusts the exact cited range only would miss the load-bearing lines.
  - Resolution: widen both ranges (`capabilities-register.ts:74-88`; `submit-concerns-probe.mjs:19-35` plus a pointer to `:65-69`).

### Checked, no finding

The overwhelming majority of this spec's citations (60+ individually checked, including every citation newly added or rewritten in this revision per the task's callouts — §1.1, §1.4, §3.2, §4.2, §5, §7) are exact: file exists, line range matches, quoted text matches verbatim. Notably solid:

- All five `index.ts` root-export citations (`:23,32,46,71,99`) and the `CliContext` range (`:23-30`).
- All three config-loader-copy citations in §7 (`index.ts:46-69`, `:71-94`, `pangolin-mcp/src/bin.ts:14-49`) — each range starts exactly at the function declaration and ends exactly at its closing brace.
- The four error-string-literal line citations (`index.ts:63,68,88,93`) — exact, and the "zero test-dir references" negative claim independently verified via repo-wide grep (3 hits total, all non-test).
- §1.4's bin.ts / ADR-0005 / privilege-boundary.md citations (six sub-citations) — every one exact, including the ADR's literal "six" and the doc's literal "nine."
- §3.1's tsc re-export-emit claim was cross-checked against real compiled output (`pangolin-orchestrator/dist/index.js`, which does `export { X } from './y.js'` genuinely) rather than taken on faith — the `Object.defineProperty(exports, "X", { enumerable: true, get: ... })` shape is exactly what's there. This strengthens rather than weakens confidence in the §3.1 argument.
- The package-map.md cross-check (16 packages, none with an `exports` map, no `mcp→cli` graph edge) fully supports §3.1's and §7's claims.
- `listProviderNames`'s zero-caller claim (§4.4) — confirmed via two independent search strategies (scoped `packages/**/src` grep, whole-repo grep).
- The offload-fanout SQLite/exit-hook citations (§4.2) — independently confirmed against `SqliteRunStateStore`'s constructor (`runstate/sqlite.ts:94`, synchronous `new Database(path)`), which grounds the "IMPORT-SAFE is a comment, not a mechanism" argument concretely rather than just plausibly.
- Every `SubagentDef`/`SyncProvider` shape citation in `providers/types.ts` (lines 5-6, 19-31, 40, 41-44).
- The `--dry-run`/help-text/register-call-site citations across `cmd-subagent.ts` and `cmd-capabilities.ts` (§4.2-§4.6, §5).

### Out of lens

- None.
