## Lens: grounding
## Charter: read docs-site ADR set (0001-0020, esp. ADR-0003, ADR-0005), privilege-boundary.md,
architecture-overview.md, package-map.md, reference/config.md, reference/cli.md, and
docs-site/.../how-to/sync-capabilities-subagents.md (the doc this spec rewrites). No
CLAUDE.md/AGENTS.md/.claude/audit-charter.md exists in this repo, as stated in the task.
No downstream plan consumes this spec (confirmed: spec is untracked, no commits landed,
no plan references it) — findings below are graded on their own merits, not against a
downstream statement.

This spec is unusually dense with `file:line` citations (~45 distinct code/doc citations
across §1-§11). Each was opened and checked individually against the repo. The large
majority verify exactly; two citation-level issues are reported below. No claim was found
where the spec asserts new work is needed but the work already happens on the cited path.

### Grounding table
| Assumption | Where in artifact | Verified at file:line | VERIFIED / CONTRADICTED / NOT-FOUND / UNVERIFIABLE |
|---|---|---|---|
| `SubagentDef` carries `promptTemplate` + `capabilities` | §1.1 `types.ts:19-31` | packages/pangolin-cli/src/providers/types.ts:19-31 | VERIFIED |
| `renderPrompt` Mustache-renders `promptTemplate` else returns `systemPrompt` verbatim | §1.1 `prompt-renderer.ts:26-34` | packages/pangolin-runtime-claude-code/src/prompt-renderer.ts:26-34 | VERIFIED |
| `ClaudeCodeProvider.loadSubagents` hardcodes `{name, systemPrompt: body}` | §1.1 `claude-code.ts:43` | packages/pangolin-cli/src/providers/claude-code.ts:43 | VERIFIED |
| `StoaProvider` hardcodes the same field | §1.1 `stoa.ts:70` | packages/pangolin-cli/src/providers/stoa.ts:70 | VERIFIED |
| `PROVIDERS` closed map, two entries | §1.2 `providers/index.ts:11-14` | packages/pangolin-cli/src/providers/index.ts:11-14 | VERIFIED |
| `resolveProvider` reads only that map | §1.2 `:16-23` | packages/pangolin-cli/src/providers/index.ts:16-23 | VERIFIED |
| how-to doc instructs editing `PROVIDERS` map directly | §1.2 `sync-capabilities-subagents.md:136-171`, quoted | docs-site/.../how-to/sync-capabilities-subagents.md:160-161 | VERIFIED (quote exact; cited range 136-171 is 1 line short of the section's true end at 172 — immaterial) |
| `index.ts` exports exactly 5 things at the given lines | §1.3 `:23,:32,:46,:71,:99` | packages/pangolin-cli/src/index.ts:23,32,46,71,99 | VERIFIED — confirmed exactly 5 `export` statements in the file |
| `package.json` has `main`/`types`, no `exports` | §1.3 `:6-7` | packages/pangolin-cli/package.json:6-7 | VERIFIED; no `exports` key present anywhere in the file |
| `dist` is in `files` | §1.3 `package.json:11-15` | packages/pangolin-cli/package.json:11-15 | VERIFIED |
| `SyncProvider` type exported at `providers/index.ts:29` | §1.3 table | packages/pangolin-cli/src/providers/index.ts:29 | VERIFIED |
| `ClaudeCodeProvider`/`StoaProvider` never exported as values | §1.3 table | grep across packages/pangolin-cli/src, providers/index.ts | VERIFIED (2 search strategies: read providers/index.ts directly; grepped for value-export patterns — only `export type {...}` present) |
| StoaProvider holds a ClaudeCodeProvider, delegates `loadCapabilities` wholesale | §1.3 `stoa.ts:36`, `:79-81` | packages/pangolin-cli/src/providers/stoa.ts:36,79-81 | VERIFIED |
| Reimplementing requires the SKILL.md walk at `claude-code.ts:50-72` + helpers `:90-177` | §1.3 | packages/pangolin-cli/src/providers/claude-code.ts:50-72,90-177 | VERIFIED |
| `pangolin.config` executes arbitrary code, constructs `PangolinClient` incl. secret stores | §1.4 `index.ts:59-66` | packages/pangolin-cli/src/index.ts:59-66; corroborated by deploy/serve-stack/pangolin.config.mjs:29,195 (`AwsSecretStore`) | VERIFIED |
| ADR-0005 enforcement description, quoted "exactly six run-time tool names" | §1.4 `0005-....md:71-79` | docs-site/.../decisions/0005-privileged-ops-never-ai-reachable.md:71-79 | VERIFIED as an accurate quote of the ADR — but see Finding 2: the ADR text itself is stale against current code |
| `name` already `readonly` on `SyncProvider` | §4.1 `providers/types.ts:40` | packages/pangolin-cli/src/providers/types.ts:40 | VERIFIED |
| `sync` ends in `subagent.register()` / `capabilities.register()` | §4.2 `cmd-subagent.ts:131`, `cmd-capabilities.ts:66` | packages/pangolin-cli/src/cmd-subagent.ts:131; cmd-capabilities.ts:66 | VERIFIED |
| Sync actions span the cited ranges | §4.3 `cmd-subagent.ts:121-135`, `cmd-capabilities.ts:56-70` | same files | VERIFIED (exact action-block boundaries) |
| `runSync` at `sync.ts:25` | §4.3 | packages/pangolin-cli/src/sync.ts:25 | VERIFIED |
| `--provider` help strings | §4.3 `cmd-subagent.ts:118`, `cmd-capabilities.ts:53` | same files | VERIFIED |
| Unknown-provider error at `providers/index.ts:20` | §4.3 | packages/pangolin-cli/src/providers/index.ts:20 | VERIFIED |
| `CliContext` has exactly two seams today | §4.3 `index.ts:23-30` | packages/pangolin-cli/src/index.ts:23-30 | VERIFIED |
| Dir fields read only when `--from` absent | §5 `cmd-subagent.ts:123`, `cmd-capabilities.ts:58` | same files | VERIFIED |
| Dir fields non-optional on interface | §5 `providers/types.ts:41-44` | packages/pangolin-cli/src/providers/types.ts:41-44 | VERIFIED |
| Purity-contract quote location | §5 `providers/types.ts:6-8` | packages/pangolin-cli/src/providers/types.ts:5-6 | CONTRADICTED (off by one line) — see Finding 1 |
| `getOrchContext` throws on missing `orch` export | §6 `index.ts:86-90` | packages/pangolin-cli/src/index.ts:86-90 | VERIFIED |
| `--dry-run` skips the client | §6 `cmd-subagent.ts:125`, `cmd-capabilities.ts:60` | same files | VERIFIED |
| `defaultGetClient`/`defaultGetOrchContext` near-duplicate ranges | §7 `index.ts:46-69`, `:71-94` | packages/pangolin-cli/src/index.ts:46-69,71-94 | VERIFIED |
| `pangolin-cli` at `0.4.0` | §8 `package.json:3` | packages/pangolin-cli/package.json:3 | VERIFIED |
| `dir` overload: ClaudeCodeProvider treats as containing dir | §8 `claude-code.ts:31-32` | packages/pangolin-cli/src/providers/claude-code.ts:31-32 | VERIFIED |
| `dir` overload: StoaProvider treats as repo root, `defaultSubagentDir='.'`, rebuilds paths | §8 `stoa.ts:33`, `:39-40` | packages/pangolin-cli/src/providers/stoa.ts:33,39-40 | VERIFIED |
| Manifest path accepts either prompt field | §11 `manifest-parser.ts:70` | packages/pangolin-cli/src/manifest-parser.ts:70 | VERIFIED |
| `cmd-deploy.ts` passes `promptTemplate` through | §11 `cmd-deploy.ts:56` | packages/pangolin-cli/src/cmd-deploy.ts:56 | VERIFIED |
| Capability bundle path already parameterized | §11 `claude-code.ts:66` | packages/pangolin-cli/src/providers/claude-code.ts:66 | VERIFIED |
| ADR-0003 exists, covers runtime adapter seam | §11 | docs-site/.../decisions/0003-runtime-adapter-seam-at-mvp.md | VERIFIED (file exists, title matches) |
| No in-repo consumer deep-imports `pangolin-cli` | §3 | grepped packages/**, test/** for `pangolin-cli/dist`, `pangolin-cli/providers`, `@quarry-systems/pangolin-cli` | VERIFIED (2 search strategies: cross-package grep, cross-`test/` grep; only a comment in examples/manifest/test/deploy.test.ts:26 *discusses* the deep-import path and explicitly says it isn't used) |
| `config.md` already documents `default`/`client` and `orch` exports (so `syncProviders` slots in beside them) | §10 | docs-site/.../reference/config.md:29-30 | VERIFIED |
| No naming collision for new identifiers (`mergeProviders`, `validateSyncProviders`, `loadConfigModule`) | §4.2, §5, §7 | grepped packages/** | VERIFIED absent (no prior art, no collision) |

### Findings

- **DEFERRED** · ADR-0005 is quoted accurately but the quoted passage is itself stale against shipped code (six vs. nine allowlisted MCP tool names)
  - Artifact text: "ADR-0005's enforcement is a CI check asserting the `pangolin-mcp` tool set equals exactly six run-time names (`:71-79`)."
  - Evidence: The quote is a faithful citation of `docs-site/src/content/docs/explanation/decisions/0005-privileged-ops-never-ai-reachable.md:71-79`, which does say "equals exactly the six run-time tool names from §4.6." But the actual enforced allowlist has grown: `packages/pangolin-mcp/src/tools.ts` registers nine tool names (`pangolin_dispatch`, `pangolin_dispatch_describe`, `pangolin_dispatch_cancel`, `pangolin_capabilities_list`, `pangolin_subagents_list`, `pangolin_envs_list`, `pangolin_orchestrator_submit`, `pangolin_orchestrator_status`, `pangolin_orchestrator_watch`), and `packages/pangolin-mcp/test/tool-allowlist.test.ts:11-22` explicitly asserts "exposes exactly the nine run-time tools (six original + three orch)". The ADR's prose was not updated when the three `orch` tools were added.
  - Concrete failure: None for this spec's own decisions — the SPI change in this spec does not touch `pangolin-mcp` at all, so "sync remains CLI-only, providers never become reachable from `pangolin-mcp`" survives the six-vs-nine correction unchanged. This is a pre-existing doc/code drift in ADR-0005, not introduced by and not consequential to this spec.
  - Resolution: Not this spec's obligation to fix ADR-0005. If precision is wanted, either drop the specific count ("a closed CI allowlist of run-time tool names") or update the number to nine and cite `packages/pangolin-mcp/test/tool-allowlist.test.ts:11-22` alongside the ADR.

- **DEFERRED** · Citation off by one line: the purity-contract quote is on `types.ts:5-6`, not `:6-8`
  - Artifact text (§5): 'The purity contract in `providers/types.ts:6-8` ("they read filesystem, they do NOT call the PangolinClient")'
  - Evidence: `packages/pangolin-cli/src/providers/types.ts:5` reads `// Providers are pure data adapters: they read filesystem, they do NOT call` and line 6 reads `// the PangolinClient or do registration. The cmd-* files orchestrate by taking`. The quoted fragment "they read filesystem, they do NOT call the PangolinClient" spans lines 5-6, not 6-8. Lines 7-8 are unrelated ("provider output and feeding it to client.subagent.register() / client.capabilities.register().").
  - Concrete failure: None — the underlying claim (a documented-but-review-only purity convention, unenforceable for third-party code) is fully correct; only the pinpoint citation is off.
  - Resolution: Change citation to `providers/types.ts:5-6`.

### Checked, no finding

Roughly 40 additional `file:line` citations across §1-§11 (registry closure, export surface, `CliContext` shape, sync-action wiring, `runSync`, dry-run/config-absent behavior, the `defaultGetClient`/`defaultGetOrchContext` duplication basis for D8, the `dir`-parameter overload basis for D7, the manifest/deploy out-of-scope justification, the capability-bundle-path out-of-scope justification, and the doc's existing `default`/`client`/`orch` export table) were each opened and match the spec's description exactly, including line ranges. No case was found where the spec claims new work is needed on a path that already does that work — e.g., D8's "config-resolution copies" claim is correct: no `loadConfigModule`-equivalent helper exists yet, confirmed by grep, so consolidating is genuinely new work rather than duplicating an existing helper. No naming collisions exist for the new identifiers the spec introduces (`mergeProviders`, `validateSyncProviders`, `loadConfigModule`, `getSyncProviders`, `syncProviders`) — grepped and confirmed absent. All three value exports proposed for the new `./providers` subpath (`ClaudeCodeProvider`, `StoaProvider`, `splitFrontmatter`) already exist as real exported values in their source modules, so re-exporting them is mechanically sound (not a "provided but not exported" trap). The claim "no in-repo consumer deep-imports pangolin-cli" holds under two independent search strategies.

### Out of lens

(none)
