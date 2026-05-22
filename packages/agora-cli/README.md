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
agora subagent register --name code-reviewer --from ./subagents/code-reviewer.yaml
agora env register --name prod --secret CLAUDE_API_KEY=arn:...

# Or reconcile a full manifest
agora deploy --from agora-manifest.yaml

# Then dispatch
agora dispatch --subagent code-reviewer --env prod \
  --input '{"repoUrl":"https://github.com/my-org/repo"}' --target fargate-prod
agora dispatch describe <id>
agora dispatch cancel <id>
```

The CLI expects an `agora.config.ts` in the working directory exporting an `AgoraClient` as the default (or named `client`) export.

## Spec

- [§4.4 A worked Hello World](../../docs/superpowers/specs/2026-05-21-agora-mvp-design.md#44-a-worked-hello-world) — the end-to-end flow the CLI scripts.
- [§4.5 Deploy manifest (CLI-driven registration)](../../docs/superpowers/specs/2026-05-21-agora-mvp-design.md#45-deploy-manifest-cli-driven-registration) — the manifest format `agora deploy` reconciles.

## Decisions

- [ADR-0001 — Package scope](../../docs/decisions/0001-package-scope.md): the `@quarry-systems/agora-*` namespace this package publishes under.
- [ADR-0005 — Privileged ops never AI-reachable](../../docs/decisions/0005-privileged-ops-never-ai-reachable.md): why `register` and `assign` are CLI-only and not exposed via MCP.
