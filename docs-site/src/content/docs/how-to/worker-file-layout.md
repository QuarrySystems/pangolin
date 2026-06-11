---
title: Put files where the worker finds them
description: Where capability files land in the workspace, and the `pangolin-setup.sh` single-slot rule.
---

A **capability** is a directory of files that Pangolin Scale overlays onto the worker's
workspace before the runtime adapter (Claude Code, etc.) starts. This guide
answers the question every capability author hits: *"I want my worker to have
X — where do I put it?"*

For the architectural model behind all this, see the MVP spec §6.3 (overlay
engine) and §5.8 (runtime adapter seam). This page is the cookbook.

## TL;DR — pick the right path

| You want the worker to have… | Put it at this path in your capability dir |
|---|---|
| A Claude Code skill | `.claude/skills/<skill-name>/SKILL.md` (+ any supporting files) |
| Claude Code settings overrides | `.claude/settings.json` |
| Claude Code plugin installs | `pangolin-plugins.json` |
| A shell setup step | `pangolin-setup.sh` (⚠️ only one per dispatch — see below) |
| Arbitrary files at known paths | Just put them at the path you want |

Register the directory once with the CLI:

```bash
pangolin capabilities register --name <name> --from ./path/to/capability-dir
```

Or auto-generate from an existing on-disk convention (`.claude/skills/`,
pokemon profiles, etc.) — see [Sync capabilities & subagents](/pangolin/how-to/sync-capabilities-subagents/).

## How Pangolin Scale decides which file wins

When a dispatch binds multiple capabilities, the worker overlays them in
declared order. Conflicts at the same path are resolved per merge rule:

- **Adapter-reserved paths** — the runtime adapter (e.g.,
  `ClaudeCodeRuntimeAdapter`) declares paths it owns and how to merge them.
  For Claude Code: `.claude/settings.json` deep-merges (`union` on arrays),
  `.claude/skills/**` is last-write-wins per file.
- **Pangolin Scale-defined manifest paths** — `pangolin-setup.sh` is last-write-wins,
  `pangolin-notifications.json` is array-union, `pangolin-channel.json` is
  last-write-wins.
- **Everything else** — last-write-wins on the file path.

The practical upshot: most things compose cleanly because each capability
writes to its own subpath. The exception is `pangolin-setup.sh` — see below.

## Recipe: ship a Claude Code skill

The skill must end up at `<workspace>/.claude/skills/<name>/SKILL.md` inside
the worker. The `ClaudeCodeRuntimeAdapter` reserves `.claude/skills/**`, and
the `claude` binary spawns with `cwd=workspace`, so a project-level skill at
that path is discovered natively — no setup script, no install step.

Your capability dir:

```
my-skill-cap/
└── .claude/
    └── skills/
        └── my-skill/
            ├── SKILL.md
            └── references/
                └── helpful.md
```

Register:

```bash
pangolin capabilities register --name my-skill --from ./my-skill-cap
```

Multiple capabilities can each ship their own skill — they land at different
`.claude/skills/<distinct-name>/` paths, no conflict. This is exactly what
`pangolin capabilities sync --provider claude-code` automates.

## Recipe: override Claude Code settings

`.claude/settings.json` is deep-merged with array-union, so each capability
can contribute the fragment it cares about:

```
cap-allow-jq/
└── .claude/
    └── settings.json
```

```json
{ "permissions": { "allow": ["Bash(jq:*)"] } }
```

Another capability adding `Bash(rg:*)` doesn't clobber yours — the arrays
union, the final settings.json has both.

## Recipe: install a tool in the worker

Put a `pangolin-setup.sh` at your capability dir's root:

```sh
#!/bin/sh
set -e
apt-get update && apt-get install -y jq
```

⚠️ **Single-slot constraint.** `pangolin-setup.sh` is last-write-wins on that
exact filename. If **two** of your bound capabilities each ship one, only
the last one in resolved order runs — the others silently disappear. Three
ways to work around this:

1. **One owning capability.** Pick the capability that's "primary" for the
   dispatch and put all setup logic there. The other capabilities deliver
   files only.
2. **Files at adapter-reserved paths** — preferred when applicable. If the
   runtime adapter knows about your path (`.claude/skills/`, `.claude/
   settings.json`, etc.), put the files there directly. The overlay engine
   handles merging per-file; no setup step needed.
3. **One subagent, one setup script** — the convention works fine when the
   subagent uses exactly one cap that needs install logic.

## Recipe: install Claude Code plugins

The Claude Code adapter looks for `pangolin-plugins.json` after overlay and
runs `claude plugins install <name>` for each entry. This file's merge rule
is `array-union`, so multiple capabilities can each contribute plugins
without overwriting each other:

```
my-plugin-cap/
└── pangolin-plugins.json
```

```json
[{ "name": "@org/some-plugin" }]
```

## Recipe: ship arbitrary files

Anything not at a reserved path is last-write-wins per file. If two
capabilities don't share file paths, they compose cleanly. Just put files
at the path you want:

```
fixtures-cap/
├── fixtures/
│   ├── sample-input.json
│   └── expected-output.json
```

Worker workspace will have `<workspace>/fixtures/sample-input.json` etc.

## What you can't do (yet)

- **Per-capability install scripts that compose.** See the single-slot
  constraint above. There's no `pangolin-setup-<name>.sh` mechanism today.
- **Skill enumeration from the AI surface.** `pangolin_capabilities_list` /
  `pangolin_subagents_list` MCP tools throw `NOT_IMPLEMENTED` — until the
  storage layer grows `listNames(prefix)`, the AI has to be told skill names
  out-of-band.
- **Auto-rebind subagents after a cap sync.** Subagent capability bindings
  freeze the capability `contentHash` at register time. If you re-sync caps
  (new content → new hash), you must also re-register the subagent to pick
  up the new hash. The CLI doesn't do this automatically yet.

## See also

- [Sync capabilities & subagents](/pangolin/how-to/sync-capabilities-subagents/) — auto-generate capabilities and
  subagents from `.claude/skills/`, `.claude/agents/`, pokemon profiles, etc.
- [Dispatch to a remote Docker daemon](/pangolin/how-to/remote-docker-dispatch/) — dispatch to a
  remote Docker daemon over SSH.
- MVP spec §6.3 — formal definition of the overlay/merge model.
- [ADR-0005](/pangolin/explanation/decisions/0005-privileged-ops-never-ai-reachable/) — why register/assign are not exposed on the MCP surface.
