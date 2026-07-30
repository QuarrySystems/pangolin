import { it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
// Same idiom as test/scaffold-shape.test.ts:6-8.
const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// INSIDE the package — self-reference resolution requires it, and self-reference
// is active only when package.json has an `exports` field.
let probeDir: string;
beforeEach(async () => {
  probeDir = await mkdtemp(join(pkgRoot, '.probe-'));
});
afterEach(async () => {
  await rm(probeDir, { recursive: true, force: true });
});

it('an ESM consumer named-imports the SPI from the subpath', async () => {
  const probe = join(probeDir, 'probe.mjs');
  await writeFile(
    probe,
    `import { ClaudeCodeProvider } from '@quarry-systems/pangolin-cli/providers';\n` +
      `console.log(new ClaudeCodeProvider().name);\n`,
  );
  const { stdout } = await run(process.execPath, [probe]);
  expect(stdout.trim()).toBe('claude-code');
});

it('a registry internal is NOT reachable through the subpath', async () => {
  const probe = join(probeDir, 'internal.mjs');
  await writeFile(
    probe,
    `import { ClaudeCodeProvider, mergeProviders } from '@quarry-systems/pangolin-cli/providers';\n` +
      `console.log(typeof ClaudeCodeProvider, typeof mergeProviders);\n`,
  );
  // Must name mergeProviders specifically — a bare "it throws" is satisfied by
  // ERR_MODULE_NOT_FOUND, which is what a MISSING exports map produces.
  await expect(run(process.execPath, [probe])).rejects.toThrow(/mergeProviders/);
});
