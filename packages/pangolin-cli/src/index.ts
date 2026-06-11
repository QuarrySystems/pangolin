#!/usr/bin/env node
// @quarry-systems/pangolin-cli
// Binary entry point for the `pangolin` CLI.
//
// Constructs the commander root program, sets up dispatch to the subcommands
// (registered by subsequent tasks), and holds a factory for constructing an
// PangolinClient from CLI flags + config-file lookup. The integrator typically
// maintains an `pangolin.config.{ts,js,mjs}` in their deploy repo that exports
// the client as the module's default export (or a named `client` export).

import { Command } from 'commander';
import type { PangolinClient } from '@quarry-systems/pangolin-client';
import { attachCapabilitiesCmd } from './cmd-capabilities.js';
import { attachSubagentCmd } from './cmd-subagent.js';
import { attachEnvCmd } from './cmd-env.js';
import { attachDispatchCmd } from './cmd-dispatch.js';
import { attachDeployCmd } from './cmd-deploy.js';
import { attachOrchCmd } from './cmd-orch.js';
import type { OrchContext } from './cmd-orch.js';
import { attachVerifyCmd } from './cmd-verify.js';
import { attachPipelineCmd } from './cmd-pipeline.js';

export interface CliContext {
  /** Lazily-loaded PangolinClient instance (from pangolin.config.ts in cwd). */
  getClient: () => Promise<PangolinClient>;
  /** Lazily-loaded OrchContext instance (from pangolin.config.ts `orch` export in cwd).
   *  Throws lazily (clear error) only when an orch verb actually runs without an `orch`
   *  config export — mirrors how getClient throws lazily without a config file. */
  getOrchContext: () => Promise<OrchContext>;
}

export function buildProgram(ctx: CliContext): Command {
  const program = new Command();
  program.name('pangolin').description('Pangolin Scale CLI — register artifacts and dispatch workers');
  attachCapabilitiesCmd(program, ctx);
  attachSubagentCmd(program, ctx);
  attachEnvCmd(program, ctx);
  attachDispatchCmd(program, ctx);
  attachDeployCmd(program, ctx);
  attachOrchCmd(program, ctx);
  attachVerifyCmd(program, ctx);
  attachPipelineCmd(program, ctx);
  return program;
}

export async function defaultGetClient(): Promise<PangolinClient> {
  // Resolve ./pangolin.config.{ts,js,mjs} relative to cwd, dynamic import, expect
  // a default export of an PangolinClient instance (or a named `client` export).
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
        `pangolin-cli: ${filename} must export an PangolinClient instance as default or named 'client'`,
      );
    }
    return client as PangolinClient;
  }
  throw new Error(`pangolin-cli: no pangolin.config.{ts,js,mjs} found in ${process.cwd()}`);
}

export async function defaultGetOrchContext(): Promise<OrchContext> {
  // Resolve ./pangolin.config.{ts,js,mjs} relative to cwd, dynamic import, expect
  // a named `orch` export of an OrchContext object.
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
    const oc = mod.orch;
    if (!oc) {
      throw new Error(
        `pangolin-cli: ${filename} must export an OrchContext as a named 'orch' export for pangolin orch commands`,
      );
    }
    return oc as OrchContext;
  }
  throw new Error(`pangolin-cli: no pangolin.config.{ts,js,mjs} found in ${process.cwd()}`);
}

// Direct-invocation guard. The package compiles to CommonJS (no `"type":
// "module"` in package.json), so we use the CJS-native `require.main ===
// module` check rather than `import.meta.url`. When this file is executed
// as the entry script (e.g. via the `pangolin` bin), build the program and
// parse argv; when it is `require()`d from a test, skip the side effect.
if (typeof require !== 'undefined' && require.main === module) {
  const program = buildProgram({ getClient: defaultGetClient, getOrchContext: defaultGetOrchContext });
  program.parseAsync(process.argv).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
