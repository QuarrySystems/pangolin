#!/usr/bin/env node
// @quarry-systems/agora-cli
// Binary entry point for the `agora` CLI.
//
// Constructs the commander root program, sets up dispatch to the subcommands
// (registered by subsequent tasks), and holds a factory for constructing an
// AgoraClient from CLI flags + config-file lookup. The integrator typically
// maintains an `agora.config.{ts,js,mjs}` in their deploy repo that exports
// the client as the module's default export (or a named `client` export).

import { Command } from 'commander';
import type { AgoraClient } from '@quarry-systems/agora-client';
import { attachCapabilitiesCmd } from './cmd-capabilities.js';
import { attachSubagentCmd } from './cmd-subagent.js';
import { attachEnvCmd } from './cmd-env.js';
import { attachDispatchCmd } from './cmd-dispatch.js';
import { attachDeployCmd } from './cmd-deploy.js';

export interface CliContext {
  /** Lazily-loaded AgoraClient instance (from agora.config.ts in cwd). */
  getClient: () => Promise<AgoraClient>;
}

export function buildProgram(ctx: CliContext): Command {
  const program = new Command();
  program.name('agora').description('Agora CLI — register artifacts and dispatch workers');
  attachCapabilitiesCmd(program, ctx);
  attachSubagentCmd(program, ctx);
  attachEnvCmd(program, ctx);
  attachDispatchCmd(program, ctx);
  attachDeployCmd(program, ctx);
  return program;
}

export async function defaultGetClient(): Promise<AgoraClient> {
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
        `agora-cli: ${filename} must export an AgoraClient instance as default or named 'client'`,
      );
    }
    return client as AgoraClient;
  }
  throw new Error(`agora-cli: no agora.config.{ts,js,mjs} found in ${process.cwd()}`);
}

// Direct-invocation guard. The package compiles to CommonJS (no `"type":
// "module"` in package.json), so we use the CJS-native `require.main ===
// module` check rather than `import.meta.url`. When this file is executed
// as the entry script (e.g. via the `agora` bin), build the program and
// parse argv; when it is `require()`d from a test, skip the side effect.
if (typeof require !== 'undefined' && require.main === module) {
  const program = buildProgram({ getClient: defaultGetClient });
  program.parseAsync(process.argv).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
