# @quarry-systems/agora-mcp

An MCP server that wraps `AgoraClient` and exposes the run-time, orchestration-safe subset of its surface to AI tool callers. The server exposes exactly six tools — `agora_dispatch`, `agora_dispatch_describe`, `agora_dispatch_cancel`, `agora_capabilities_list`, `agora_subagents_list`, `agora_envs_list` — and nothing else. Privileged operations (`register`, `assign`) are deliberately absent: prompt injection on capability content is as dangerous as secret exfiltration on env, so the entire artifact-creation surface stays out of the AI loop.

## Install

```bash
pnpm add @quarry-systems/agora-mcp
```

## Basic usage

Register the server in your MCP client (Claude Code, Claude Desktop, etc.). The bin entry resolves `agora.config.{ts,js,mjs}` from its working directory, constructs an `AgoraClient`, and serves over stdio.

```json
{
  "mcpServers": {
    "agora": {
      "command": "npx",
      "args": ["-y", "@quarry-systems/agora-mcp"],
      "cwd": "/path/to/your/deploy/repo"
    }
  }
}
```

The MCP server inherits the privileges of whoever launched it — there is no separate auth between the orchestrator and `agora-mcp`. Locking down who can launch the server is the integrator's IAM concern.

## Spec

- [§4.6 The agora-mcp tool surface](../../docs/superpowers/specs/2026-05-21-agora-mvp-design.md#46-the-agora-mcp-tool-surface) — the six-tool allowlist this server enforces.
- [§7.7 Privileged operations are never reachable through an AI tool surface](../../docs/superpowers/specs/2026-05-21-agora-mvp-design.md#77-privileged-operations-are-never-reachable-through-an-ai-tool-surface) — the rationale for the omitted register/assign operations.

## Decisions

- [ADR-0005 — Privileged ops never AI-reachable](../../docs/decisions/0005-privileged-ops-never-ai-reachable.md): why this server omits `register` and `assign`.
- [ADR-0006 — agora-mcp auth: whoever launched](../../docs/decisions/0006-agora-mcp-auth-whoever-launched.md): the trust model for the stdio transport.
