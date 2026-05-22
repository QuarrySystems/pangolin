// @quarry-systems/agora-mcp — stdio transport bootstrap.
//
// Constructs an MCP `Server` (low-level SDK, tools-only surface) and wires it
// to a `StdioServerTransport`. Tool handlers come from `./tools.js`
// (`registerAgoraTools`), which owns the run-time tool catalog enforced by
// the CI allowlist check in `task-ci-mcp-tool-allowlist`.
//
// Authentication model (§4.6, ADR-016 §10.1): "whoever launched the server."
// There is no per-call auth and no per-orchestrator ACL on this surface — the
// server inherits the privileges of the process that started it. The caller
// (typically a Claude Code instance or other MCP orchestrator) is trusted
// because it forked us; deploy-time privileged operations (register/assign)
// are excluded from the tool surface entirely rather than gated by ACLs.
//
// Tools-only: we advertise `capabilities: { tools: {} }` and register no
// prompts, resources, sampling, or other capability bundles.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { AgoraClient } from '@quarry-systems/agora-client';
import { registerAgoraTools } from './tools.js';

/**
 * Options accepted by `runServer`. Only `client` is required; `name` and
 * `version` default to `'agora-mcp'` and `'0.1.0'` respectively and are
 * exposed as overrides primarily for tests and for embedders that want to
 * re-skin the server identity advertised in the MCP `initialize` handshake.
 */
export interface RunServerOpts {
  /** AgoraClient instance the tools wrap. */
  client: AgoraClient;
  /** Override the server name; defaults to `'agora-mcp'`. */
  name?: string;
  /** Override the server version; defaults to the package version. */
  version?: string;
}

/**
 * Construct the MCP `Server`, register the six run-time agora tools, and
 * connect it to a `StdioServerTransport`. Resolves once the transport is
 * ready (i.e., listening on stdin/stdout); the returned promise does NOT
 * await server shutdown — long-running lifetime is owned by the transport
 * and the host process, not by this call.
 */
export async function runServer(opts: RunServerOpts): Promise<void> {
  const server = new Server(
    { name: opts.name ?? 'agora-mcp', version: opts.version ?? '0.1.0' },
    { capabilities: { tools: {} } },
  );
  registerAgoraTools(server, opts.client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
