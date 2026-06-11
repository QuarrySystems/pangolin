// `pangolin pipeline` subcommand group — register / validate / list.
//
// Mirrors the structure of cmd-subagent.ts exactly (arg parsing, client
// construction, output format, exit codes).
//
// PRECEDENT NOTE — `list`:
//   Both `cmd-subagent` and `cmd-capabilities` expose a `list` verb that calls
//   `client.subagent.list()` / `client.capabilities.list()`. We follow that
//   pattern here and call `client.pipeline.list()`. The underlying catalog
//   layer currently throws "not yet implemented" (StorageProvider lacks a
//   listNames extension); that error will surface to the user with the same
//   UX as it does for the other resource types. The type assertion on
//   `(client.pipeline as any).list` is intentional: `PangolinClientPipelineAPI`
//   does not expose `list` yet (catalog enumeration is deferred in DAG 2).
//   Once `PangolinClientPipelineAPI` gains a `list()` method the cast can be
//   removed and this comment deleted.
//
// VALIDATE — storage-free design:
//   `validate` uses `registerPipeline` from `@quarry-systems/pangolin-client`
//   with a stub storage provider that is guaranteed to throw a known sentinel
//   error AFTER validation succeeds. Since `registerPipeline` runs the full
//   `validatePipelineSpec` check first (collecting all errors), validation
//   errors surface as a combined throw before any storage call. This means:
//   - Invalid spec → throws "pipeline.register: invalid spec:\n<errors>"
//   - Valid spec   → stub storage throws "VALIDATE_ONLY_SENTINEL"
//   No client config file is needed. The PangolinClient namespace is set to a
//   synthetic value that cannot collide with real registrations.

import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { registerPipeline } from '@quarry-systems/pangolin-client';
import type { CliContext } from './index.js';

/** Sentinel thrown by the stub storage in the `validate` command. */
const VALIDATE_ONLY_SENTINEL = '__PIPELINE_VALIDATE_ONLY__';

/**
 * Build a stub PangolinClient that has enough shape to satisfy `registerPipeline`
 * for the validation-only path. The storage provider throws the sentinel after
 * `registerPipeline` has already run `validatePipelineSpec` successfully.
 */
function makeValidateOnlyClient(): { namespace: string; storage: { resolveLatest: () => Promise<null>; put: () => never } } {
  return {
    namespace: '__validate__',
    storage: {
      resolveLatest: async () => null,
      put: (): never => {
        throw new Error(VALIDATE_ONLY_SENTINEL);
      },
    },
  };
}

export function attachPipelineCmd(program: Command, ctx: CliContext): void {
  const pipe = program.command('pipeline').description('Manage pipeline specs');

  // ── register ──────────────────────────────────────────────────────────────
  // Read a JSON spec file → client.pipeline.register(spec) → print ref.
  // Prints { id, contentHash, registeredAt, pinnedUri }.
  // Invalid spec or missing file → exit 1 with the error.

  pipe
    .command('register <file>')
    .description('Register a pipeline spec from a JSON file')
    .action(async (file: string) => {
      let raw: string;
      try {
        raw = await readFile(file, 'utf8');
      } catch (err) {
        console.error(`pipeline register: cannot read file "${file}": ${(err as Error).message}`);
        process.exit(1);
      }

      let spec: unknown;
      try {
        spec = JSON.parse(raw!);
      } catch (err) {
        console.error(`pipeline register: invalid JSON in "${file}": ${(err as Error).message}`);
        process.exit(1);
      }

      const client = await ctx.getClient();
      let ref: { id: string; contentHash: string; registeredAt: string };
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ref = await client.pipeline.register(spec as any);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }

      // Build the pinned URI in the same format used by the storage layer
      // (`pangolin://<namespace>/pipeline/<id>@<hash>`).
      const ns = (client as { namespace?: string }).namespace ?? 'local';
      const pinnedUri = `pangolin://${ns}/pipeline/${ref!.id}@${ref!.contentHash}`;

      console.log(JSON.stringify({ ...ref!, pinnedUri }));
    });

  // ── validate ──────────────────────────────────────────────────────────────
  // Storage-free: read JSON file → validatePipelineSpec → print errors or OK.
  // Does NOT construct a client. exit 0 on OK, exit 1 on errors.
  // See VALIDATE design note in file header for how we use registerPipeline
  // with a stub storage to run validatePipelineSpec without needing a separate
  // import of @quarry-systems/pangolin-core (which is not a direct dep of pangolin-cli).

  pipe
    .command('validate <file>')
    .description('Validate a pipeline spec JSON file without storing it')
    .action(async (file: string) => {
      let raw: string;
      try {
        raw = await readFile(file, 'utf8');
      } catch (err) {
        console.error(`pipeline validate: cannot read file "${file}": ${(err as Error).message}`);
        process.exit(1);
      }

      let spec: unknown;
      try {
        spec = JSON.parse(raw!);
      } catch (err) {
        console.error(`pipeline validate: invalid JSON in "${file}": ${(err as Error).message}`);
        process.exit(1);
      }

      // Use registerPipeline with a stub client so validatePipelineSpec runs
      // (it is the first thing registerPipeline does) without touching real storage.
      const stubClient = makeValidateOnlyClient();
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await registerPipeline(stubClient as any, spec as Parameters<typeof registerPipeline>[1]);
        // If we reach here, the spec is valid AND the stub's resolveLatest
        // returned null — meaning the put will be called next and throw the
        // sentinel. That path is unreachable in practice because resolveLatest
        // returns null → put is called → put throws. So this line is defensive.
        console.log('OK');
      } catch (err) {
        const msg = (err as Error).message;
        if (msg === VALIDATE_ONLY_SENTINEL) {
          // Spec was valid — storage threw the sentinel as expected.
          console.log('OK');
        } else if (msg.startsWith('pipeline.register: invalid spec:')) {
          // Spec was invalid — print each error line and exit 1.
          const errors = msg
            .replace('pipeline.register: invalid spec:\n', '')
            .split('\n')
            .filter(Boolean);
          for (const e of errors) console.error(e);
          process.exit(1);
        } else {
          // Unexpected error
          console.error(`pipeline validate: unexpected error: ${msg}`);
          process.exit(1);
        }
      }
    });

  // ── list ──────────────────────────────────────────────────────────────────
  // Follows cmd-subagent / cmd-capabilities precedent: call client.*.list() and
  // print one tab-delimited line per ref. See file header for the type-cast note.

  pipe
    .command('list')
    .description('List all registered pipeline specs')
    .action(async () => {
      const client = await ctx.getClient();
      // Type assertion: PangolinClientPipelineAPI.list is not yet part of the
      // published interface (see PRECEDENT NOTE in file header).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const refs = (await (client.pipeline as any).list()) as Array<{
        id: string;
        contentHash: string;
        registeredAt: string;
      }>;
      for (const r of refs) {
        console.log(`${r.id}\t${r.contentHash}\t${r.registeredAt}`);
      }
    });
}
