// `agora subagent` subcommand group — register / assign / list / get.
//
// Each subcommand resolves an `AgoraClient` via `ctx.getClient()` and calls
// the namespaced `client.subagent.*` API. The `register` subcommand reads a
// YAML file with the subagent definition (systemPrompt / promptTemplate /
// model / capabilities) and forwards it under the given `--name`.
//
// `assign` is currently restricted: the namespaced storage layer does not
// expose the underlying {systemPrompt, promptTemplate, model} bundle from a
// `SubagentRef`, so we cannot reconstruct a `RegisterSubagentOpts` purely
// from a name. Rather than silently dropping prompt fields, we emit a clear
// error directing the user to re-register with the new capability list.
// The full assign-only flow lands in v1.5 once subagent.get exposes enough
// of the stored bundle to round-trip it back through register().

import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type { CliContext } from './index.js';
import { resolveProvider } from './providers/index.js';
import { runSync } from './sync.js';

export function attachSubagentCmd(program: Command, ctx: CliContext): void {
  const sub = program.command('subagent').description('Manage subagents');

  sub
    .command('register')
    .description('Register a subagent from a YAML file or inline flags')
    .requiredOption('--name <name>', 'subagent name')
    .option('--from <file>', 'YAML file with systemPrompt / promptTemplate / model / capabilities')
    .option('--system-prompt <text>', 'inline systemPrompt')
    .option('--prompt-template <text>', 'inline promptTemplate')
    .option('--model <id>', 'inline model id')
    .option('--capability <names...>', 'capability name(s) to bind (repeatable)')
    .action(
      async (opts: {
        name: string;
        from?: string;
        systemPrompt?: string;
        promptTemplate?: string;
        model?: string;
        capability?: string[];
      }) => {
        const hasInline =
          opts.systemPrompt !== undefined ||
          opts.promptTemplate !== undefined ||
          opts.model !== undefined ||
          (opts.capability?.length ?? 0) > 0;
        if (opts.from && hasInline) {
          throw new Error('use either --from <file> or inline flags, not both');
        }
        if (!opts.from && !hasInline) {
          throw new Error(
            'supply --from <file> or at least one of --system-prompt / --prompt-template / --model / --capability',
          );
        }
        const def: Record<string, unknown> = opts.from
          ? ((parseYaml(await readFile(opts.from, 'utf8')) ?? {}) as Record<string, unknown>)
          : {
              ...(opts.systemPrompt !== undefined && { systemPrompt: opts.systemPrompt }),
              ...(opts.promptTemplate !== undefined && { promptTemplate: opts.promptTemplate }),
              ...(opts.model !== undefined && { model: opts.model }),
              ...(opts.capability && { capabilities: opts.capability }),
            };
        const client = await ctx.getClient();
        const handle = await client.subagent.register({ name: opts.name, ...def });
        console.log(
          JSON.stringify({
            name: handle.name,
            contentHash: handle.contentHash,
            registeredAt: handle.registeredAt,
          }),
        );
      },
    );

  sub
    .command('assign <name>')
    .description('Assign a new capability set to a named subagent')
    .requiredOption('--capabilities <list>', 'comma-separated capability names')
    .action(async (name: string, opts: { capabilities: string }) => {
      // Touch the client so misconfiguration surfaces here, even though we
      // immediately throw — keeps the failure mode consistent with the other
      // subcommands (config errors first, semantic limitation second).
      await ctx.getClient();
      const caps = opts.capabilities
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean);
      throw new Error(
        `assign currently requires re-registering the subagent with the new capability list via 'subagent register --from <yaml> --name ${name}' where the YAML's 'capabilities' includes ${caps.join(', ')}. Full assign-only flow will land in v1.5 once SubagentHandle is retrievable from storage.`,
      );
    });

  sub
    .command('list')
    .description('List all registered subagents')
    .action(async () => {
      const client = await ctx.getClient();
      const refs = await client.subagent.list();
      for (const r of refs) {
        console.log(`${r.name}\t${r.contentHash}\t${r.registeredAt}`);
      }
    });

  sub
    .command('get <name>')
    .description('Get a single subagent ref by name')
    .action(async (name: string) => {
      const client = await ctx.getClient();
      const ref = await client.subagent.get(name);
      console.log(ref ? JSON.stringify(ref) : '(not found)');
    });

  sub
    .command('sync')
    .description("Bulk-register subagents from an external tool's on-disk convention")
    .requiredOption('--provider <name>', "provider adapter (e.g. 'claude-code')")
    .option('--from <dir>', "source directory (defaults to the provider's convention)")
    .option('--dry-run', 'parse and print, do not register', false)
    .action(async (opts: { provider: string; from?: string; dryRun: boolean }) => {
      const provider = resolveProvider(opts.provider);
      const dir = opts.from ?? provider.defaultSubagentDir;
      const defs = await provider.loadSubagents(dir);
      const client = opts.dryRun ? null : await ctx.getClient();
      await runSync({
        kind: 'subagent',
        items: defs,
        dryRun: opts.dryRun,
        register: async (def) => {
          const handle = await client!.subagent.register(def);
          return { name: handle.name, contentHash: handle.contentHash };
        },
      });
    });
}
