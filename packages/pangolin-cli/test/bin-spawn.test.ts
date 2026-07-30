// Spawns the BUILT binary (dist/index.js) as a real child process against a
// scratch cwd containing a real pangolin.config.mjs.
//
// This is the only construction that executes the `buildProgram({...})` call
// in src/index.ts — that line sits inside `if (typeof require !== 'undefined'
// && require.main === module)`, which vitest never executes when it imports
// src/index.ts directly (see bin-entry.test.ts) — and the only place in this
// plan where the config-side producer (`defaultGetSyncProviders`) is bound to
// the resolver-side consumer (`resolveProviderLazily`) through that line.
//
// Harness mirrors test/e2e/mcp-tool-surface.test.ts:94-121 (repo root, not
// this package): mkdtemp a scratch cwd, writeFile a config into it, spawn
// with `cwd: configDir`, rm in afterEach.
//
// A built-in-only spawn is NOT sufficient on its own: resolveProviderLazily
// returns from findBuiltIn before ever touching getSyncProviders, so a
// built-in case alone would pass even against a build that never wired the
// construction site at all. The 'probe' config-provider case below is the
// discriminating one — it is red if the construction site omits
// getSyncProviders entirely (TypeError on `await getExtra()` against
// `undefined`) and red if the member is made optional / called with `?.`
// (yields `null`, producing `unknown --provider 'probe'`).

import { it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(pkgRoot, 'dist/index.js');

// A shape-valid provider defined inline in the config. No client is needed:
// cmd-subagent.ts is `opts.dryRun ? null : await ctx.getClient()`, so
// --dry-run never constructs one.
const CONFIG_WITH_PROVIDER = `
export const syncProviders = [{
  name: 'probe',
  defaultSubagentDir: 'agents',
  defaultCapabilityDir: 'capabilities',
  async loadSubagents() { return [{ name: 'probe-agent', promptTemplate: 'hi {{x}}' }]; },
  async loadCapabilities() { return []; },
}];
`;

// A config that throws at module scope — used for the blast-radius cases.
const HOSTILE_CONFIG = `throw new Error('boom-from-config');\n`;

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'pangolin-bin-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

it('resolves a CONFIG-SUPPLIED provider through the real bin', async () => {
  await writeFile(join(cwd, 'pangolin.config.mjs'), CONFIG_WITH_PROVIDER);
  const { stdout } = await run(
    process.execPath,
    [bin, 'subagent', 'sync', '--provider', 'probe', '--dry-run'],
    { cwd },
  );
  expect(stdout).toContain('(dry-run) subagent probe-agent');
});

it('a built-in under --dry-run survives an import-hostile config', async () => {
  await writeFile(join(cwd, 'pangolin.config.mjs'), HOSTILE_CONFIG);
  const { stdout } = await run(
    process.execPath,
    [bin, 'subagent', 'sync', '--provider', 'claude-code', '--from', cwd, '--dry-run'],
    { cwd },
  );
  expect(stdout).not.toContain('boom-from-config');
});

it('a typo surfaces the import error, not the unknown-provider message', async () => {
  await writeFile(join(cwd, 'pangolin.config.mjs'), HOSTILE_CONFIG);
  await expect(
    run(process.execPath, [bin, 'subagent', 'sync', '--provider', 'claude-cod', '--dry-run'], { cwd }),
  ).rejects.toThrow(/boom-from-config/);
});
