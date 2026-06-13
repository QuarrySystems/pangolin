#!/usr/bin/env node
// @quarry-systems/pangolin-verify — the `pangolin-verify` binary.
//
// Verify a sealed audit bundle WITHOUT installing the orchestrator. Loads the bundle,
// optionally a verify-context (signer key + anchor source + TSA certs), builds the anchor
// for the chosen mode, and runs pangolin-core's verifyBundle with the supplied
// ed25519 + RFC 3161 verifier callbacks. See VERIFICATION.md.

import { Command } from 'commander';
import { pathToFileURL } from 'node:url';
import { verifyBundle } from '@quarry-systems/pangolin-core';
import type { VerificationReport } from '@quarry-systems/pangolin-core';
import {
  loadBundle,
  loadVerifyContext,
  buildAnchor,
  makeVerifySignature,
  makeVerifyTimestamp,
} from './verify-context.js';
import { renderVerification } from './render.js';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('pangolin-verify')
    .description('Independently verify a Pangolin Scale audit bundle (trust the artifact, not the vendor)')
    .argument('<bundle.json>', 'path to the exported AuditBundle JSON')
    .option('--anchor <verify-context.json>', 'verify-context: signer key, anchor source, TSA certs')
    .option('--json', 'emit the raw VerificationReport as JSON')
    .option('--full', 'print every ledger row')
    .action(async (file: string, opts: { anchor?: string; json?: boolean; full?: boolean }) => {
      const bundle = await loadBundle(file);

      let report: VerificationReport;
      if (opts.anchor) {
        const ctx = await loadVerifyContext(opts.anchor);
        const anchor = buildAnchor(ctx, bundle);
        report = await verifyBundle(bundle, {
          anchor,
          verifySignature: makeVerifySignature(ctx),
          verifyTimestamp: makeVerifyTimestamp(ctx),
        });
      } else {
        // No context → offline mode against the bundle's own embedded root.
        const anchor = buildAnchor({ anchor: { mode: 'offline' }, tsaCaCertsDer: [] }, bundle);
        report = await verifyBundle(bundle, { anchor });
      }

      console.log(
        opts.json
          ? JSON.stringify(report, null, 2)
          : renderVerification({ ...bundle, report }, { color: process.stdout.isTTY === true, full: opts.full }),
      );
      process.exitCode = report.intact ? 0 : 1;
    });
  return program;
}

// Direct-invocation guard (ESM). When run as the `pangolin-verify` bin, parse argv;
// when imported from a test, skip the side effect.
const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      console.error((err as Error).message);
      process.exit(1);
    });
}
