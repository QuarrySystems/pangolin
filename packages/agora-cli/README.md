# @quarry-systems/agora-cli

The `agora` binary. A thin command-line front end over `AgoraClient` that resolves an `agora.config.{ts,js,mjs}` from the working directory, constructs the client, and dispatches to subcommands for capability/subagent/env registration, manifest-driven deploys, and dispatch operations. The CLI is the canonical privileged entry point: it runs from a human terminal or CI shell where secrets in the environment can be safely staged into the registry.

## Install

```bash
pnpm add -D @quarry-systems/agora-cli
```

## Basic usage

```bash
# Register artifacts ad-hoc
agora capabilities register --name git-write --from ./caps/git-write/
agora subagent register --name code-reviewer \
  --system-prompt "Review code carefully." --capability git-write
agora env register --name prod --secret CLAUDE_API_KEY=arn:...

# Or reconcile a full manifest
agora deploy --from agora-manifest.yaml

# Or bulk-import an existing Claude Code skill/agent tree
agora capabilities sync --provider claude-code
agora subagent sync --provider claude-code

# Then dispatch
agora dispatch run --target fargate-prod --subagent code-reviewer --env prod \
  --worker-image public.ecr.aws/quarry-systems/agora-worker@sha256:...
agora dispatch describe <id>
agora dispatch cancel <id>
```

The CLI expects an `agora.config.ts` in the working directory exporting an `AgoraClient` as the default (or named `client`) export.

## Guides

- [Getting started](../../docs/getting-started.md) — zero-to-first-dispatch runbook including CLI wiring and `agora.config.mjs`.
- [Dispatch lifecycle](../../docs/dispatch-lifecycle.md) — what each event in worker stdout means, and which step each `dispatch.failed.reason` maps to.
- [Capability recipes](../../docs/capability-recipes.md) — where to put files so the worker picks them up (skills, settings, plugins, setup scripts), and the `agora-setup.sh` single-slot constraint that catches first-time authors.
- [Sync providers](../../docs/sync-providers.md) — `agora capabilities sync` / `agora subagent sync` reference, the `claude-code` and `stoa` providers shipped today, and how to author a new one.
- [needs_input](../../docs/needs-input.md) — how a sub-agent pauses for clarification and how to resume it.
- [Writing a provider](../../docs/writing-a-provider.md) — plug in a new compute backend, storage layer, credential source, or result sink.
- [Remote dispatch over SSH](../../docs/remote-dispatch-windows.md) — orchestrate from one machine, run workers on another's Docker daemon.

## Spec

- [§4.4 A worked Hello World](../../docs/superpowers/specs/2026-05-21-agora-mvp-design.md#44-a-worked-hello-world) — the end-to-end flow the CLI scripts.
- [§4.5 Deploy manifest (CLI-driven registration)](../../docs/superpowers/specs/2026-05-21-agora-mvp-design.md#45-deploy-manifest-cli-driven-registration) — the manifest format `agora deploy` reconciles.

## Decisions

- [ADR-0001 — Package scope](../../docs/decisions/0001-package-scope.md): the `@quarry-systems/agora-*` namespace this package publishes under.
- [ADR-0005 — Privileged ops never AI-reachable](../../docs/decisions/0005-privileged-ops-never-ai-reachable.md): why `register` and `assign` are CLI-only and not exposed via MCP.
