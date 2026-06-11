# -systems/pangolin-mcp

An MCP server that wraps `PangolinClient` and exposes the run-time, orchestration-safe subset of its surface to AI tool callers. The server exposes exactly six tools — `pangolin_dispatch`, `pangolin_dispatch_describe`, `pangolin_dispatch_cancel`, `pangolin_capabilities_list`, `pangolin_subagents_list`, `pangolin_envs_list` — and nothing else. Privileged operations (`register`, `assign`) are deliberately absent: prompt injection on capability content is as dangerous as secret exfiltration on env, so the entire artifact-creation surface stays out of the AI loop.

## Install

```bash
pnpm add -systems/pangolin-mcp
```

## Basic usage

Register the server in your MCP client (Claude Code, Claude Desktop, etc.). The bin entry resolves `pangolin.config.{ts,js,mjs}` from its working directory, constructs an `PangolinClient`, and serves over stdio.

```json
{
  "mcpServers": {
    "pangolin": {
      "command": "npx",
      "args": ["-y", "-systems/pangolin-mcp"],
      "cwd": "/path/to/your/deploy/repo"
    }
  }
}
```

The MCP server inherits the privileges of whoever launched it — there is no separate auth between the orchestrator and `pangolin-mcp`. Locking down who can launch the server is the integrator's IAM concern.

## Spec

- [§4.6 The pangolin-mcp tool surface](../../docs/superpowers/specs/2026-05-21-pangolin-mvp-design.md#46-the-pangolin-mcp-tool-surface) — the six-tool allowlist this server enforces.
- [§7.7 Privileged operations are never reachable through an AI tool surface](../../docs/superpowers/specs/2026-05-21-pangolin-mvp-design.md#77-privileged-operations-are-never-reachable-through-an-ai-tool-surface) — the rationale for the omitted register/assign operations.

## Decisions

- [ADR-0005 — Privileged ops never AI-reachable](../../docs/decisions/0005-privileged-ops-never-ai-reachable.md): why this server omits `register` and `assign`.
- [ADR-0006 — pangolin-mcp auth: whoever launched](../../docs/decisions/0006-pangolin-mcp-auth-whoever-launched.md): the trust model for the stdio transport.
