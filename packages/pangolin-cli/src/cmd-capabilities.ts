// `pangolin capabilities` subcommand group.
//
// Wires three subcommands onto the root program:
//   - `register --name <n> --from <dir>`: walks `<dir>` recursively, builds a
//     `files:` map keyed by forward-slash relative paths, and calls
//     `client.capabilities.register({ name, files })`. Prints the resulting
//     `CapabilityRef` as JSON.
//   - `list`: prints one tab-delimited line per registered capability
//     (`name\tcontentHash\tregisteredAt`).
//   - `get <name>`: prints the named capability ref as JSON, or `(not found)`
//     when the catalog lookup returns `null`.
//
// The command obtains the `PangolinClient` lazily via `ctx.getClient()` so the
// process does not pay the pangolin.config.{ts,js,mjs} resolution cost until a
// subcommand actually runs.

import { Command } from 'commander';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { CliContext } from './index.js';
import { resolveProvider } from './providers/index.js';
import { runSync } from './sync.js';

export function attachCapabilitiesCmd(program: Command, ctx: CliContext): void {
  const caps = program.command('capabilities').description('Manage capability bundles');

  caps
    .command('register')
    .requiredOption('--name <name>', 'capability name')
    .requiredOption('--from <dir>', 'directory whose contents become the bundle')
    .action(async (opts: { name: string; from: string }) => {
      const client = await ctx.getClient();
      const files = await readDirAsBundle(opts.from);
      const ref = await client.capabilities.register({ name: opts.name, files });
      console.log(JSON.stringify(ref));
    });

  caps.command('list').action(async () => {
    const client = await ctx.getClient();
    const refs = await client.capabilities.list();
    for (const r of refs) console.log(`${r.name}\t${r.contentHash}\t${r.registeredAt}`);
  });

  caps.command('get <name>').action(async (name: string) => {
    const client = await ctx.getClient();
    const ref = await client.capabilities.get(name);
    console.log(ref ? JSON.stringify(ref) : '(not found)');
  });

  caps
    .command('sync')
    .description("Bulk-register capabilities from an external tool's on-disk convention")
    .requiredOption('--provider <name>', "provider adapter (e.g. 'claude-code')")
    .option('--from <dir>', "source directory (defaults to the provider's convention)")
    .option('--dry-run', 'parse and print, do not register', false)
    .action(async (opts: { provider: string; from?: string; dryRun: boolean }) => {
      const provider = resolveProvider(opts.provider);
      const dir = opts.from ?? provider.defaultCapabilityDir;
      const bundles = await provider.loadCapabilities(dir);
      const client = opts.dryRun ? null : await ctx.getClient();
      await runSync({
        kind: 'capability',
        items: bundles,
        dryRun: opts.dryRun,
        register: async (b) => {
          const ref = await client!.capabilities.register(b);
          return { name: ref.name, contentHash: ref.contentHash };
        },
      });
    });
}

/**
 * Walk `rootDir` recursively and return a `{ relativePath: bytes }` map. Path
 * separators are normalized to forward slashes so a bundle registered on
 * Windows matches one registered on POSIX byte-for-byte.
 */
async function readDirAsBundle(rootDir: string): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        const rel = relative(rootDir, full).replace(/\\/g, '/');
        out[rel] = await readFile(full);
      }
    }
  }
  await walk(rootDir);
  return out;
}
