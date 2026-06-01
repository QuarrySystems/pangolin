#!/usr/bin/env node
// @quarry-systems/agora-mcp — bin entry point for the agora-mcp server.
//
// Resolves agora.config.{ts,js,mjs} from cwd (mirroring agora-cli's pattern),
// constructs an AgoraClient, and optionally constructs an OperationsApi from a
// named `orch` export. Calls runServer({ client, orch? }). The transport
// blocks on stdin/stdout until the parent process closes.

import type { AgoraClient } from '@quarry-systems/agora-client';
import type { OperationsApiDeps } from '@quarry-systems/agora-orchestrator';
import { OperationsApi } from '@quarry-systems/agora-orchestrator';
import { runServer } from './server.js';

async function resolveConfig(): Promise<{ client: AgoraClient; orch?: OperationsApi }> {
  // Resolve ./agora.config.{ts,js,mjs} relative to cwd, dynamic import, expect
  // a default export of an AgoraClient instance (or a named `client` export).
  // Also optionally resolve a named `orch` export providing { transport }.
  const { pathToFileURL } = await import('node:url');
  const { resolve } = await import('node:path');
  const { access } = await import('node:fs/promises');
  for (const filename of ['agora.config.ts', 'agora.config.js', 'agora.config.mjs']) {
    const path = resolve(process.cwd(), filename);
    try {
      await access(path);
    } catch {
      continue;
    }
    const mod = await import(pathToFileURL(path).href);
    const client = mod.default ?? mod.client;
    if (!client) {
      throw new Error(
        `agora-mcp: ${filename} must export an AgoraClient instance as default or named 'client'`,
      );
    }

    // Optionally resolve the orch surface. The `orch` export provides
    // { transport } — a SubmissionTransport & ControlChannel — from which
    // we construct an OperationsApi. Missing `orch` is not an error: orch
    // tools will return a clear not-configured isError at call time.
    let orch: OperationsApi | undefined;
    const orchCtx = mod.orch as { transport?: OperationsApiDeps['transport'] } | undefined;
    if (orchCtx && orchCtx.transport) {
      orch = new OperationsApi({ transport: orchCtx.transport });
    }

    return { client: client as AgoraClient, orch };
  }
  throw new Error(`agora-mcp: no agora.config.{ts,js,mjs} found in ${process.cwd()}`);
}

// Direct invocation: resolve the client (and optional orch) then call runServer.
// In a Node.js context, this module is invoked as the bin entry point.
resolveConfig()
  .then(({ client, orch }) => runServer({ client, orch }))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
