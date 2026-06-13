# -systems/pangolin-cli

The `pangolin` binary. A thin command-line front end over `PangolinClient` that resolves an `pangolin.config.{ts,js,mjs}` from the working directory, constructs the client, and dispatches to subcommands for capability/subagent/env registration, manifest-driven deploys, and dispatch operations. The CLI is the canonical privileged entry point: it runs from a human terminal or CI shell where secrets in the environment can be safely staged into the registry.

## Install

```bash
pnpm add -D -systems/pangolin-cli
```

## Basic usage

```bash
# Register artifacts ad-hoc
pangolin capabilities register --name git-write --from ./caps/git-write/
pangolin subagent register --name code-reviewer \
  --system-prompt "Review code carefully." --capability git-write
pangolin env register --name prod --secret CLAUDE_API_KEY=arn:...

# Or reconcile a full manifest
pangolin deploy --from pangolin-manifest.yaml

# Or bulk-import an existing Claude Code skill/agent tree
pangolin capabilities sync --provider claude-code
pangolin subagent sync --provider claude-code

# Then dispatch
pangolin dispatch run --target fargate-prod --subagent code-reviewer --env prod \
  --worker-image public.ecr.aws/quarry-systems/pangolin-worker@sha256:...
pangolin dispatch describe <id>
pangolin dispatch cancel <id>
```

The CLI expects an `pangolin.config.ts` in the working directory exporting an `PangolinClient` as the default (or named `client`) export.

## Guides

- [Getting started](https://quarrysystems.github.io/pangolin/tutorials/first-dispatch/) — zero-to-first-dispatch runbook including CLI wiring and `pangolin.config.mjs`.
- [Dispatch lifecycle](https://quarrysystems.github.io/pangolin/reference/dispatch-lifecycle/) — what each event in worker stdout means, and which step each `dispatch.failed.reason` maps to.
- [Capability recipes](https://quarrysystems.github.io/pangolin/how-to/worker-file-layout/) — where to put files so the worker picks them up (skills, settings, plugins, setup scripts), and the `pangolin-setup.sh` single-slot constraint that catches first-time authors.
- [Sync providers](https://quarrysystems.github.io/pangolin/how-to/sync-capabilities-subagents/) — `pangolin capabilities sync` / `pangolin subagent sync` reference, the `claude-code` and `stoa` providers shipped today, and how to author a new one.
- [needs_input](https://quarrysystems.github.io/pangolin/how-to/handle-needs-input/) — how a sub-agent pauses for clarification and how to resume it.
- [Writing a provider](https://quarrysystems.github.io/pangolin/how-to/write-a-provider/) — plug in a new compute backend, storage layer, credential source, or result sink.
- [Remote dispatch over SSH](https://quarrysystems.github.io/pangolin/how-to/remote-docker-dispatch/) — orchestrate from one machine, run workers on another's Docker daemon.

## Spec

- [§4.4 A worked Hello World](https://github.com/QuarrySystems/pangolin/blob/main/docs/superpowers/specs/2026-05-21-agora-mvp-design.md#44-a-worked-hello-world) — the end-to-end flow the CLI scripts.
- [§4.5 Deploy manifest (CLI-driven registration)](https://github.com/QuarrySystems/pangolin/blob/main/docs/superpowers/specs/2026-05-21-agora-mvp-design.md#45-deploy-manifest-cli-driven-registration) — the manifest format `pangolin deploy` reconciles.

## Decisions

- [ADR-0001 — Package scope](https://quarrysystems.github.io/pangolin/explanation/decisions/0001-package-scope/): the `@quarry-systems/pangolin-*` namespace this package publishes under.
- [ADR-0005 — Privileged ops never AI-reachable](https://quarrysystems.github.io/pangolin/explanation/decisions/0005-privileged-ops-never-ai-reachable/): why `register` and `assign` are CLI-only and not exposed via MCP.
