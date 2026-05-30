import { Command } from 'commander';
import type { CliContext } from './index.js';

// Type aliases for secret references, inlined to avoid agora-core import
type SecretRef = { ref: string };
type InlineSecret = { inline: string };

const REF_PREFIXES = ['arn:', 'local-secret://'];

/** Thrown by parseSecretArg when the value has no recognised secret prefix. */
export class SecretArgParseError extends Error {
  constructor(public readonly key: string) {
    super(`secret ${key} must start with 'arn:', 'local-secret://', or 'inline:'`);
    this.name = 'SecretArgParseError';
  }
}

/**
 * Parse a single KEY=VALUE secret argument string into a record entry.
 * Single source of truth for the --secret flag format:
 *   arn:* or local-secret://*  → { ref }   (opaque reference)
 *   inline:*                   → { inline } (prefix stripped)
 *   anything else              → throws SecretArgParseError
 */
export function parseSecretArg(kv: string): Record<string, SecretRef | InlineSecret> {
  const [k, ...rest] = kv.split('=');
  const v = rest.join('=');
  if (REF_PREFIXES.some((p) => v.startsWith(p))) {
    return { [k]: { ref: v } };
  } else if (v.startsWith('inline:')) {
    return { [k]: { inline: v.slice('inline:'.length) } };
  }
  throw new SecretArgParseError(k);
}

export function attachEnvCmd(program: Command, ctx: CliContext): void {
  const env = program.command('env').description('Manage env bundles');

  env.command('register')
    .requiredOption('--name <name>', 'env bundle name')
    .option('--value <kv...>', 'KEY=VALUE pairs (repeatable)')
    .option('--secret <kv...>', 'KEY=arn:... | KEY=local-secret://... | KEY=inline:<value> (repeatable)')
    .action(async (opts) => {
      const client = await ctx.getClient();
      const values: Record<string, string> = {};
      const secrets: Record<string, SecretRef | InlineSecret> = {};
      for (const kv of opts.value ?? []) {
        const [k, ...rest] = kv.split('=');
        values[k] = rest.join('=');
      }
      for (const kv of opts.secret ?? []) {
        try {
          Object.assign(secrets, parseSecretArg(kv));
        } catch (e) {
          if (e instanceof SecretArgParseError) {
            console.error(e.message);
            process.exit(1);
            return; // unreachable in production; guards test mocks of process.exit
          }
          throw e;
        }
      }
      const ref = await client.env.register({ name: opts.name, values, secrets });
      console.log(JSON.stringify(ref));
    });

  env.command('list').action(async () => {
    const client = await ctx.getClient();
    for (const r of await client.env.list()) console.log(`${r.name}\t${r.contentHash}\t${r.registeredAt}`);
  });
  env.command('get <name>').action(async (name: string) => {
    const client = await ctx.getClient();
    const ref = await client.env.get(name);
    console.log(ref ? JSON.stringify(ref) : '(not found)');
  });
}
