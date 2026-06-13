import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { verifyBundle, renderVerification } from '@quarry-systems/pangolin-orchestrator';
import type { AuditBundle } from '@quarry-systems/pangolin-orchestrator';
import type { CliContext } from './index.js';

export function attachVerifyCmd(program: Command, ctx: CliContext): void {
  program
    .command('verify <bundle.json>')
    .description('Verify an exported audit bundle against its external anchor')
    .option('--json', 'emit the raw VerificationReport as JSON')
    .option('--full', 'print every ledger row')
    .action(async (file: string, opts: { json?: boolean; full?: boolean }) => {
      let bundle: AuditBundle;
      try {
        bundle = JSON.parse(await readFile(file, 'utf8'));
      } catch (err) {
        throw new Error(`pangolin verify: cannot read bundle at '${file}': ${(err as Error).message}`);
      }
      const { anchor, verifySignature, verifyTimestamp } = await ctx.getOrchContext();
      if (!anchor) {
        throw new Error('pangolin verify: pangolin.config `orch` export provides no anchor');
      }
      // verifyTimestamp is additive: threaded only if the config supplies one (e.g. from
      // @quarry-systems/pangolin-verify). Omitted by default — existing behavior unchanged.
      const report = await verifyBundle(bundle, { anchor, verifySignature, verifyTimestamp });
      console.log(
        opts.json
          ? JSON.stringify(report, null, 2)
          : renderVerification(
              { ...bundle, report },
              { color: process.stdout.isTTY, full: opts.full },
            ),
      );
      if (!report.intact) process.exitCode = 1;
    });
}
