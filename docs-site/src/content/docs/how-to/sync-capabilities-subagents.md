---
title: Sync capabilities & subagents
description: Use `pangolin capabilities sync` / `pangolin subagent sync`; the `claude-code` and `stoa` providers.
---

The `pangolin capabilities sync` and `pangolin subagent sync` commands bulk-register
content from an existing on-disk convention — Claude Code's skill/agent
layout, stoa's pokemon profile layout, etc. — without writing capability or
subagent definitions by hand.

A **sync provider** is a small adapter that knows one tool's on-disk
convention and produces Pangolin Scale-native shapes (`SubagentDef`, `CapabilityBundle`).
Each provider is selected with `--provider <name>`.

## Quick start

```bash
# Walk .claude/skills/ recursively for SKILL.md markers; register each as
# a capability that places files at .claude/skills/<name>/ in the worker.
pangolin capabilities sync --provider claude-code

# Walk .claude/agents/*.md and register each as a pangolin subagent.
# systemPrompt = markdown body, model = frontmatter `model` if present.
pangolin subagent sync --provider claude-code

# Stoa pokemon profiles: reads .claude/skills/<pokemon>/_pokemon.json plus
# the matching .claude/agents/<pokemon_id>.md, registers each pokemon as
# one subagent with its full move list pre-bound as capabilities.
pangolin subagent sync --provider stoa
```

All sync commands support:

- `--from <dir>` — override the provider's default scan directory.
- `--dry-run` — parse and print what *would* be registered; no writes.

## Providers shipped today

### `claude-code`

**Capabilities source:** walks the `--from` directory recursively looking
for `SKILL.md` markers. The containing directory of each marker is treated
as one skill (name = directory basename). Walk stops descending once a
`SKILL.md` is found — nested `SKILL.md`s inside an outer skill's
`references/` or `scripts/` directories do **not** double-register as
siblings. Dotfile directories (`.git`, `.cache`) are skipped.

- **Default `--from`:** `.claude/skills/` (project-local)
- **Bundle layout:** files placed at `.claude/skills/<name>/<rel-path>` —
  the path the `ClaudeCodeRuntimeAdapter` reserves, so the worker's claude
  binary discovers them natively. No setup script is generated.
- **Layout-agnostic:** flat (`<root>/<skill>/SKILL.md`), nested
  (`<root>/<group>/<skill>/SKILL.md`), or deeper all work — the SKILL.md
  walk handles them uniformly.
- **Same-name dedup:** if two skill dirs share a name and their content is
  byte-identical, only one bundle is registered (silent). If content differs,
  a warning is emitted and the last-seen wins.

**Subagents source:** walks the `--from` directory for `*.md` files.
Parses YAML frontmatter + markdown body. Maps:

- frontmatter `name` (fallback to filename stem) → subagent name
- frontmatter `model` → subagent model (if present)
- markdown body → `systemPrompt`
- frontmatter `description`, `tools`, `color` → **ignored** (no Pangolin Scale
  equivalents)

Capabilities are **not bound** by this sync — Claude Code agent files don't
have a binding model for skills. Use the inline `--capability` flag at
`register` time, or use the `stoa` provider if you have a pokemon convention.

- **Default `--from`:** `.claude/agents/` (project-local)

### `stoa`

Adds profile↔move binding on top of the SKILL.md walk. Designed for the
pokemon convention:

```
.claude/agents/profile-<pokemon>.md       ← agent system prompt
.claude/skills/<pokemon>/_pokemon.json    ← profile manifest (moves list)
.claude/skills/<pokemon>/<move>/SKILL.md  ← each move is a skill
```

**Capabilities source:** delegates to the `claude-code` provider's SKILL.md
walk. Identical bundle output. Default `--from` is `.claude/skills/`.

**Subagents source:** walks `<repoRoot>/.claude/skills/<pokemon>/_pokemon.json`
files. For each, reads:

- `pokemon_id` from the JSON → subagent name (e.g. `profile-abra`)
- `moves` array from the JSON → subagent's `capabilities` list
- The corresponding `<repoRoot>/.claude/agents/<pokemon_id>.md` for prompt
  + model (via frontmatter + body)

Missing agent files emit a warning and skip the pokemon. Manifests without
a string `pokemon_id` are skipped with a warning. Pokemon directories without
a `_pokemon.json` are ignored entirely (so plain `.claude/skills/foo/SKILL.md`
content can coexist with pokemon profiles in the same tree).

- **Default `--from`:** `.` (repo root, because it needs both
  `.claude/agents/` and `.claude/skills/`)

## Including multiple source dirs

Today `--from` is single-valued. To pull from multiple roots, run the
command per source:

```bash
pangolin capabilities sync --provider claude-code --from ~/.claude/skills
pangolin capabilities sync --provider claude-code --from .claude/skills
```

The dedup-by-content logic handles overlap within a single sync run silently
when bundles are byte-identical. Across separate sync invocations, dedup is
implicit at the storage layer (same content → same `contentHash` → one
registration in storage).

## The cap-sync-invalidates-subagent gotcha

Subagent capability bindings freeze the capability's `contentHash` at
register time, for reproducibility (validate-once, dispatch-many). When you
re-sync capabilities and their content changes, you get new hashes — but
existing subagents still point at the old hashes.

Recovery is mechanical: re-run the subagent sync after a capability sync.

```bash
pangolin capabilities sync --provider claude-code   # new cap hashes
pangolin subagent sync --provider stoa              # rebinds to new hashes
```

The order matters. Caps must exist before subagents reference them. There's
no `pangolin sync` combined command today; you run each manually.

## Authoring a new sync provider

A provider is a class implementing `SyncProvider` (`packages/pangolin-cli/src/
providers/types.ts`):

```typescript
export interface SyncProvider {
  readonly name: string;                  // identifier for --provider
  readonly defaultSubagentDir: string;    // default scan dir
  readonly defaultCapabilityDir: string;
  loadSubagents(dir: string): Promise<SubagentDef[]>;
  loadCapabilities(dir: string): Promise<CapabilityBundle[]>;
}
```

A provider is a pure data adapter — it reads filesystem and returns
Pangolin Scale-native shapes. It does NOT call the `PangolinClient` or perform
registration. The `cmd-*` files orchestrate by taking provider output and
feeding it to the client.

When composing on top of an existing provider, prefer composition over
inheritance. The `stoa` provider holds a `ClaudeCodeProvider` instance and
delegates `loadCapabilities` to it.

To register a provider, add an entry to the `PROVIDERS` map in
`packages/pangolin-cli/src/providers/index.ts`:

```typescript
const PROVIDERS: ReadonlyMap<string, SyncProvider> = new Map<string, SyncProvider>([
  ['claude-code', new ClaudeCodeProvider()],
  ['stoa',        new StoaProvider()],
  ['my-tool',     new MyToolProvider()],
]);
```

That's the only registry touchpoint — both sync commands resolve providers
through `resolveProvider(name)` from the same map.

## See also

- [Put files where the worker finds them](/pangolin/how-to/worker-file-layout/) — where to put files for
  the worker to pick them up; what `pangolin capabilities sync` automates.
- [ADR-0005](/pangolin/explanation/decisions/0005-privileged-ops-never-ai-reachable/) — register/assign are not exposed on the MCP tool surface, which
  is why sync runs from the CLI (and the per-launch `pangolin.config.{ts,js,mjs}`)
  rather than from a dispatched worker.
