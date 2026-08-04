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

## Recipe: install a package manager so a dispatch can run its own gates

If you dispatch a verifier that must run `tsc`, a test suite, or a linter, the
workspace needs a toolchain. Three parts, and **each one alone leaves you with a
worker that cannot run the gate**. They fail in three different-looking ways,
which is why they are easy to get partly right:

**Part one — install into a writable prefix.** The worker runs as uid 1000 and
npm's global prefix is root-owned, so a bare `npm i -g` fails with `EACCES` in
about a second:

```sh
#!/bin/bash
set -e
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
mkdir -p "$NPM_CONFIG_PREFIX"
npm i -g pnpm --silent
```

**Part two — put it on `PATH` with an env bundle.** `pangolin-setup.sh` runs as a
separate process, so its own `export PATH` dies with it. Bind an env bundle
setting `PATH` to include `/home/pangolin/.npm-global/bin`. Without this the
binary is present but the agent gets `command not found`.

**Part three — ask for devDependencies explicitly.** The worker image sets
`NODE_ENV=production`, and that variable reaches your setup script. A plain
install therefore **skips every devDependency without failing** — it exits 0,
populates `node_modules`, and simply leaves out `tsc`, your test runner and your
linter:

```sh
pnpm install --frozen-lockfile --prod=false   # or: export NODE_ENV=development
```

:::caution[Part three fails silently]
Parts one and two announce themselves — an `EACCES` at setup, a `command not
found` at agent time. Part three does not. The install succeeds, and the failure
surfaces later as a missing binary or an unresolvable import, which looks like a
problem with your gate rather than with your install. If you are debugging a
dispatched verifier that "installed fine" but cannot find its tools, check this
first.
:::

**Budget.** The setup script is bounded by `PANGOLIN_SETUP_TIMEOUT_SECONDS`,
default **120 s**; exceeding it fails the dispatch with `worker-failed`. For
scale: installing pnpm itself takes ~2–3 s, and a cold, complete,
dev-inclusive `pnpm install` over a 1052-package lockfile was measured at
**14 s** in the worker image. Most projects have room; a very large tree or a
slow registry may not.

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

## Recipe: report what you installed (`.pangolin/deps.json`)

Optional. Write this file and Pangolin Scale records what dependency set your
dispatch ran against, in the audit export alongside `resultRef` and `verify`.

Exact path, inside the workspace:

```
.pangolin/deps.json
```

```json
{
  "ecosystem": "pnpm",
  "lockfileHash": "sha256:…",
  "resolvedSetDigest": "sha256:…",
  "verified": true,
  "verifier": "pnpm install --verify-store-integrity",
  "packageCount": 1432
}
```

**Pangolin Scale only hashes it.** Every field above is yours; none is parsed,
validated, or interpreted — the same treatment `executorManifest` gets. Write
whatever your ecosystem makes sense of, in any key order (the hash is
canonicalised, so re-serialising the same content does not read as a change).
The example is a suggestion, not a schema. This is why it works unchanged for
pip, cargo, nuget and go.

It is read **twice** — once after your setup script, once after the agent
finishes — and both hashes are sealed:

```json
"deps": { "atSetup": "sha256:…", "atFinish": "sha256:…", "tier": "recorded" }
```

Two entries rather than one because an agent may add a package mid-run. When the
two differ, the dispatch changed its own dependency set — the case a single
setup-time seal would describe exactly wrongly.

**It can never fail your dispatch.** Absent, malformed, unreadable, or over
64 KiB are all treated the same as "not offered": no `deps` key is sealed, the
run proceeds, and the worker logs `deps.evidence.unusable`. Both reads must
succeed for the field to appear, so a file created for the first time *during*
the run is not reported — the guarantee is that changes to an existing sentinel
are visible.

See [the threat model](/pangolin/explanation/threat-model/) for what `tier: "recorded"`
does and does not claim.

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
