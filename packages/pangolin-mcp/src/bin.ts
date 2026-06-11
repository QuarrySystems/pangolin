#!/usr/bin/env node
// @quarry-systems/pangolin-mcp — bin entry point for the pangolin-mcp server.
//
// Resolves pangolin.config.{ts,js,mjs} from cwd (mirroring pangolin-cli's pattern),
// constructs an PangolinClient, and optionally constructs an OperationsApi from a
// named `orch` export. Calls runServer({ client, orch? }). The transport
// blocks on stdin/stdout until the parent process closes.

import type { PangolinClient } from '@quarry-systems/pangolin-client';
import type { OperationsApiDeps } from '@quarry-systems/pangolin-orchestrator';
import { OperationsApi } from '@quarry-systems/pangolin-orchestrator';
import { runServer } from './server.js';

async function resolveConfig(): Promise<{ client: PangolinClient; orch?: OperationsApi }> {
  // Resolve ./pangolin.config.{ts,js,mjs} relative to cwd, dynamic import, expect
  // a default export of an PangolinClient instance (or a named `client` export).
  // Also optionally resolve a named `orch` export providing { transport }.
  const { pathToFileURL } = await import('node:url');
  const { resolve } = await import('node:path');
  const { access } = await import('node:fs/promises');
  for (const filename of ['pangolin.config.ts', 'pangolin.config.js', 'pangolin.config.mjs']) {
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
        `pangolin-mcp: ${filename} must export an PangolinClient instance as default or named 'client'`,
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

    return { client: client as PangolinClient, orch };
  }
  throw new Error(`pangolin-mcp: no pangolin.config.{ts,js,mjs} found in ${process.cwd()}`);
}

// Direct invocation: resolve the client (and optional orch) then call runServer.
// In a Node.js context, this module is invoked as the bin entry point.
resolveConfig()
  .then(({ client, orch }) => runServer({ client, orch }))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
