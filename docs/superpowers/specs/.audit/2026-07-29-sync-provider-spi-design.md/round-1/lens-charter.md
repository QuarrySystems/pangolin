## Lens: charter conformance

## Charter: read
- `docs-site/src/content/docs/explanation/decisions/0005-privileged-ops-never-ai-reachable.md` (ADR-0005)
- `docs-site/src/content/docs/explanation/decisions/0011-no-entrypoint-override-at-dispatch.md` (ADR-0011, checked for relevance — none)
- `docs-site/src/content/docs/explanation/decisions/0017-source-available-bsl.md` (ADR-0017, BUSL-1.1 licensing)
- `docs-site/src/content/docs/explanation/privilege-boundary.md`
- `docs-site/src/content/docs/explanation/architecture-overview.md`
- `docs-site/src/content/docs/reference/package-map.md`
- `docs-site/src/content/docs/reference/config.md`
- `docs-site/src/content/docs/reference/cli.md`
- `docs-site/src/content/docs/how-to/sync-capabilities-subagents.md` (the document this spec rewrites)
- No `CLAUDE.md`/`AGENTS.md`/`.claude/audit-charter.md` exists in this repo (confirmed by the auditor's brief); the docs-site tree above is the charter.
- No downstream plan or landed code consumes this spec (per the auditor's brief); all findings below are graded against the spec text itself, not a plan.

### Grounding table
| Assumption | Where in artifact | Verified at file:line | VERIFIED / CONTRADICTED / NOT-FOUND / UNVERIFIABLE |
|---|---|---|---|
| `pangolin-cli/package.json` declares `main`+`types`, no `exports` map | §1.3 | `packages/pangolin-cli/package.json:6-7` | VERIFIED |
| `PROVIDERS` map + `resolveProvider` closed registry | §1.2 | `packages/pangolin-cli/src/providers/index.ts:11-23` | VERIFIED |
| `providers/index.ts` barrel uses explicit named re-exports, not `export *` | §3 (implicit) | `packages/pangolin-cli/src/providers/index.ts:29` | VERIFIED — spec correctly adds new value exports explicitly rather than assuming `export *` |
| CLI root (`index.ts`) has bin-invocation side effects justifying subpath-not-root | §3 "Subpath rather than root re-export" | `packages/pangolin-cli/src/index.ts:1,32-44,109-116` | VERIFIED |
| `cmd-subagent.ts` / `cmd-capabilities.ts` sync-action line citations (§4.2, §4.3, §6) | §4.1-4.3, §6 | `packages/pangolin-cli/src/cmd-subagent.ts:118-135`, `cmd-capabilities.ts:53-70` | VERIFIED |
| ADR-0005 enforcement checks "exactly six run-time names" | §1.4 | `docs-site/…/decisions/0005-privileged-ops-never-ai-reachable.md:73-75` (text matches) vs. actual `packages/pangolin-mcp/src/tools.ts:41-50` (nine names) and `docs-site/…/explanation/privilege-boundary.md:45-59` (nine, current) | CONTRADICTED (see Findings) |
| No other of the 16 published packages declares an `exports` map | (directed check, not an explicit spec claim) | `packages/*/package.json` (all 16 read; only `main`/`types`/`files`, no package has `exports`) | VERIFIED |
| BUSL-1.1 grant permits third-party tooling built against the package | §1.4 (implicit — trust argument) | `docs-site/…/decisions/0017-source-available-bsl.md:53-55,103-110` | VERIFIED — no license conflict with the SPI's premise |
| No naming collision for `syncProviders`/`mergeProviders`/`validateSyncProviders`/`loadConfigModule` | D2, §4.2, §5, §7 | grep across `packages/**/*.ts` (two independent sweeps: symbol grep, and adjacent-domain scan of `pangolin-client`'s `ComputeProvider`/`CredentialProvider`/`StorageProvider`) | VERIFIED — no collision; `SyncProvider` fits the repo's existing `-Provider`-suffixed seam-naming convention |

### Findings

- **DEFERRED** · The spec's trust argument in §1.4 restates a now-stale ADR-0005 figure ("exactly six run-time names") as current-state evidence, when the actual enforcement and the current architecture doc both say nine.
  - Artifact text: "ADR-0005's enforcement is a CI check asserting the `pangolin-mcp` tool set equals exactly six run-time names (`:71-79`)."
  - Evidence: `docs-site/src/content/docs/explanation/decisions/0005-privileged-ops-never-ai-reachable.md:73-75` does say "six" — so the citation is accurate *to that file* — but `packages/pangolin-mcp/src/tools.ts:41-50` (`PANGOLIN_TOOL_NAMES`, "the exact nine tool names") shows the shipped surface has grown to nine (the three `pangolin_orchestrator_submit/status/watch` tools were added after ADR-0005 was written), and `docs-site/src/content/docs/explanation/privilege-boundary.md:45-59` already documents "exactly nine" with the current table. `docs-site/src/content/docs/reference/package-map.md:33-36` independently flags this exact same six-vs-nine drift for a different source (the README), confirming this is a known, already-documented staleness pattern in the repo, not a one-off.
  - Concrete failure: none for this spec's own decisions — the substantive claim ("sync stays CLI-only, providers never reach `pangolin-mcp`") holds regardless of six vs. nine, and no downstream plan or doc inherits the wrong number from this spec (§10's doc-update list doesn't restate the count). This is a stale-charter-doc citation, not a design defect.
  - Resolution: cite `privilege-boundary.md`'s nine-tool table (or `tools.ts:41-50` directly) instead of ADR-0005's stale count, or add a parenthetical noting ADR-0005 predates the three orchestrator tools.

- **DEFERRED** · Adding an `exports` map makes `pangolin-cli` the only one of the 16 published packages with one, and the spec doesn't flag that it's setting a new, repo-wide-unprecedented pattern.
  - Artifact text: "`packages/pangolin-cli/package.json` gains an `exports` map. `main` and `types` stay for older resolvers." (§3)
  - Evidence: all 16 packages' `package.json` (`packages/*/package.json`) declare identical `main: "dist/index.js"`, `types: "dist/index.d.ts"`, `files: ["dist", "README.md", "LICENSE"]` with no `exports` field anywhere in the repo (confirmed by reading all 16 plus a repo-wide grep for `"exports"` in `**/package.json`, zero matches outside this spec's own prose). No CI job checks `package.json` shape or `exports`-map parity across packages (`.github/workflows/ci.yml` has one job — lint+test+build — with no such gate), so this is not an enforced convention that would fail a build.
  - Concrete failure: none directly — the justification given (CLI root is the bin itself, with a shebang and a direct-invocation guard at `index.ts:1,109-116`) is real and distinguishes `pangolin-cli` from the 15 pure-library packages, none of which currently need a subpath (verified via `config.md`'s worked example, which imports everything it needs — including `SqliteScheduleStore` from `pangolin-orchestrator` — from each package's root). So the inconsistency is substantively justified, not accidental.
  - Resolution: optional — a one-line acknowledgment in §3 that this is the repo's first `exports` map would help a reviewer recognize the precedent being set, but nothing here blocks or contradicts a documented rule.

### Checked, no finding

- **Barrel/export convention.** `providers/index.ts` is an explicit-named-export barrel (not `export *`); the spec correctly proposes adding `ClaudeCodeProvider`, `StoaProvider`, and `splitFrontmatter` as new explicit named exports (§3) rather than assuming they'd become reachable automatically. This is the correct mechanical fix for this barrel style.
- **Named per-layer reference implementation.** Every "mirror this" instruction in the spec points at a specific file:line the composing code should imitate — `StoaProvider` composing `ClaudeCodeProvider` (`stoa.ts:36,79-81`), `resolveProvider`/`listProviderNames` gaining a trailing optional param (`providers/index.ts:16-23`), the `defaultGetClient`/`defaultGetOrchContext` pair as the pattern `loadConfigModule` collapses (`index.ts:46-94`) — none of the "follow the existing pattern" instructions are bare pointers to another spec or a vague "existing dialog"-style reference.
- **Privilege boundary (ADR-0005 substance).** The spec's claim that the SPI doesn't touch the boundary is correct on both ends: `pangolin-mcp`'s actual nine-tool surface (`tools.ts:41-50`) has no sync-related tool, and the two sync call sites (`cmd-subagent.ts:121-135`, `cmd-capabilities.ts:56-70`) remain CLI-only actions gated behind `client.subagent.register()` / `client.capabilities.register()` — deploy-time privileged calls per ADR-0005 — which the spec's D3 (hard-error on collision) explicitly protects.
- **Licensing (ADR-0017).** BUSL-1.1's Additional Use Grant permits third parties building tooling against the package (only reselling Pangolin itself as a hosted service is restricted) — no conflict with the SPI's premise that an out-of-tree npm package (`remora-pangolin-provider`) depends on `@quarry-systems/pangolin-cli/providers`.
- **Dependency graph.** The spec adds no new package dependencies and doesn't touch the `pangolin-core`-sink dependency graph documented in `package-map.md`.
- **Naming.** `SyncProvider` fits the repo's established `-Provider`-suffix seam-naming convention (`ComputeProvider`, `CredentialProvider`, `StorageProvider` in `pangolin-client`); `syncProviders`/`mergeProviders`/`validateSyncProviders`/`loadConfigModule` are all genuinely new identifiers (two independent greps: symbol search across `packages/**/*.ts`, and an adjacent-domain scan of the client's existing provider-map fields) with no collision or shadowing.
- **No in-repo deep import of `pangolin-cli` by package name.** Searched two ways — `grep '@quarry-systems/pangolin-cli/'` (zero hits) and a broader `pangolin-cli/` sweep across `packages examples deploy` (the only hits are relative-path source imports in `examples/manifest/test/deploy.test.ts`, which resolve via the filesystem, not the package `exports` field, and so are unaffected by adding one). The spec's "no in-repo consumer deep-imports pangolin-cli" claim (§3, "Known risk") holds.
- **Version/stability posture (D7).** `pangolin-cli` is genuinely at `0.4.0` (`package.json:3`), consistent with the spec's pre-1.0 provisional-SPI argument.

### Out of lens
- `docs-site/src/content/docs/reference/cli.md`'s `sync`/`--provider` rows (lines 37, 49) aren't in the spec's §10 doc-update list and would become incomplete once `--provider` can resolve config-registered names — plausibly a completeness/doc-coverage finding, not a boundary/charter one.
