// `agora deploy --from <manifest>` — the manifest reconciler (§4.5).
//
// Walks the parsed manifest top-to-bottom in three phases:
//   1. capabilities — each `from:` directory is bundled (files keyed by
//      forward-slash relative path) and registered via
//      `client.capabilities.register()`.
//   2. subagents — each entry is forwarded to `client.subagent.register()`;
//      subagents may reference capabilities registered in phase 1.
//   3. envs — each entry is forwarded to `client.env.register()`; secrets
//      pass through unchanged (the discriminated `{ ref } | InlineSecret`
//      shape is already validated by `parseManifest`).
//
// Re-registration is implicit via the SDK's content-addressed register path,
// so running the same manifest twice against a clean registry yields the
// same hashes and produces no new entries.
//
// Halt-on-failure: the first thrown registration error aborts the deploy.
// No rollback is attempted; partial state remains on the registry.
//
// Per-entry confirmation lines are emitted to stdout in the format
// `<type> <name>\t<contentHash>` so downstream tooling (CI logs, deploy
// orchestrators) can grep results.
//
// Path resolution: `capability.from` is interpreted relative to the current
// working directory at deploy time, matching the typical CLI convention
// (`agora deploy --from ./agora.config.yaml` from the project root resolves
// `./caps/git-write` from that same root).

import { Command } from 'commander';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { CliContext } from './index.js';
import { parseManifest } from './manifest-parser.js';

export function attachDeployCmd(program: Command, ctx: CliContext): void {
  program
    .command('deploy')
    .description('Reconcile a manifest against the registry (capabilities → subagents → envs)')
    .requiredOption('--from <path>', 'path to agora-manifest.yaml')
    .action(async (opts: { from: string }) => {
      const client = await ctx.getClient();
      const manifest = await parseManifest(opts.from);

      // 1. Capabilities
      for (const cap of manifest.capabilities ?? []) {
        const files = await readDirAsBundle(cap.from);
        const ref = await client.capabilities.register({ name: cap.name, files });
        console.log(`capability ${ref.name}\t${ref.contentHash}`);
      }

      // 2. Subagents (may reference capabilities registered above)
      for (const sub of manifest.subagents ?? []) {
        const handle = await client.subagent.register({
          name: sub.name,
          systemPrompt: sub.systemPrompt,
          promptTemplate: sub.promptTemplate,
          model: sub.model,
          capabilities: sub.capabilities,
        });
        console.log(`subagent ${handle.name}\t${handle.contentHash}`);
      }

      // 3. Envs
      for (const env of manifest.envs ?? []) {
        const ref = await client.env.register({
          name: env.name,
          values: env.values,
          // parseManifest validates the { ref } | InlineSecret discrimination;
          // derive the expected type from the client method instead of importing
          // the SDK's secret types from agora-core directly.
          secrets: env.secrets as Parameters<typeof client.env.register>[0]["secrets"],
        });
        console.log(`env ${ref.name}\t${ref.contentHash}`);
      }
    });
}

/**
 * Walk `rootDir` recursively and return a `{ relativePath: bytes }` map.
 * Path separators are normalised to forward slashes so a bundle registered
 * on Windows hashes byte-for-byte the same as one registered on POSIX.
 * Mirrors the helper in `cmd-capabilities.ts` so the two register paths
 * produce identical content hashes for the same on-disk bundle.
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
