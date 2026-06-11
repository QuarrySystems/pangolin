import { Command } from 'commander';
import type { CliContext } from './index.js';

export function attachDispatchCmd(program: Command, ctx: CliContext): void {
  const d = program.command('dispatch').description('Dispatch + observe workers');

  d.command('run')
    .requiredOption('--subagent <name>', 'subagent ref')
    .option('--env <names...>', 'env bundle name(s)')
    .option('--input <json>', 'input variables as JSON', '{}')
    .option('--capability <names...>', "override the subagent's capability set")
    .option('--add-capability <names...>', "append capabilities to the subagent's set")
    .requiredOption('--target <name>', 'target name from PangolinClient.targets')
    .option('--worker-image <digest>', 'worker image (digest-pinned; defaults to ghcr.io/quarrysystems/pangolin-worker:latest)')
    .action(async (opts) => {
      let parsedInput: Record<string, unknown>;
      try {
        parsedInput = JSON.parse(opts.input);
      } catch (err) {
        console.error(`pangolin dispatch run: --input is not valid JSON: ${(err as Error).message}`);
        process.exit(1);
      }

      const client = await ctx.getClient();
      const result = await client.dispatch({
        subagent: opts.subagent,
        env: opts.env,
        input: parsedInput,
        capabilities: opts.capability,
        addCapabilities: opts.addCapability,
        target: opts.target,
        workerImage: opts.workerImage || 'ghcr.io/quarrysystems/pangolin-worker:latest',
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.failure) process.exit(1);
    });

  d.command('describe <id>')
    .action(async (id: string) => {
      const client = await ctx.getClient();
      const result = await client.dispatch.describe(id);
      console.log(JSON.stringify(result, null, 2));
    });

  d.command('cancel <id>')
    .action(async (id: string) => {
      const client = await ctx.getClient();
      await client.dispatch.cancel(id);
      console.log(`cancelled: ${id}`);
    });
}
