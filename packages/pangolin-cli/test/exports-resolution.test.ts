import { it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
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

// The barrel's `export type { SyncProvider, SubagentDef, CapabilityBundle }` line
// is invisible to every other gate: types are erased so `Object.keys` cannot see
// them, nothing in src/ imports the barrel, and this package has no
// tsconfig.test.json. Deleting that line leaves build, typecheck, lint and every
// other test green while removing the one thing an out-of-tree author needs in
// order to write `implements SyncProvider`. A tsc subprocess is the only check
// that can observe it.
it('the SPI types support `implements SyncProvider` through the subpath', async () => {
  await writeFile(
    join(probeDir, 'types-probe.ts'),
    // Not a bare type reference — the actual out-of-tree use case. If the barrel
    // stops re-exporting the types, this fails to compile.
    `import type {\n` +
      `  SyncProvider, SubagentDef, CapabilityBundle,\n` +
      `} from '@quarry-systems/pangolin-cli/providers';\n` +
      `\n` +
      `export class Probe implements SyncProvider {\n` +
      `  readonly name = 'probe';\n` +
      `  readonly defaultSubagentDir = 'agents';\n` +
      `  readonly defaultCapabilityDir = 'capabilities';\n` +
      `  async loadSubagents(_dir: string): Promise<SubagentDef[]> { return []; }\n` +
      `  async loadCapabilities(_dir: string): Promise<CapabilityBundle[]> { return []; }\n` +
      `}\n`,
  );
  await writeFile(
    join(probeDir, 'tsconfig.json'),
    JSON.stringify({
      // NodeNext is what makes tsc honour the `exports` map; anything else would
      // resolve by path and prove nothing about the subpath.
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      files: ['types-probe.ts'],
    }),
  );

  const tsc = createRequire(join(pkgRoot, 'package.json')).resolve('typescript/bin/tsc');
  // Non-zero exit rejects, so a type error fails the test with tsc's own message.
  const { stdout } = await run(process.execPath, [tsc, '-p', probeDir]);
  expect(stdout.trim()).toBe('');
});
