#!/usr/bin/env node
// @quarry-systems/agora-mcp — bin entry point for the agora-mcp server.
//
// Resolves agora.config.{ts,js,mjs} from cwd (mirroring agora-cli's pattern),
// constructs an AgoraClient, and calls runServer({client}). The transport
// blocks on stdin/stdout until the parent process closes.

import type { AgoraClient } from '@quarry-systems/agora-client';
import { runServer } from './server.js';

async function defaultGetClient(): Promise<AgoraClient> {
  // Resolve ./agora.config.{ts,js,mjs} relative to cwd, dynamic import, expect
  // a default export of an AgoraClient instance (or a named `client` export).
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
    return client as AgoraClient;
  }
  throw new Error(`agora-mcp: no agora.config.{ts,js,mjs} found in ${process.cwd()}`);
}

// Direct invocation: resolve the client and call runServer.
// In a Node.js context, this module is invoked as the bin entry point.
defaultGetClient()
  .then((client) => runServer({ client }))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
