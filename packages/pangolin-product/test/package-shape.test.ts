import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, '..', 'package.json');
const tsconfigPath = join(__dirname, '..', 'tsconfig.json');
const licensePath = join(__dirname, '..', 'LICENSE');
const verifyLicensePath = join(__dirname, '..', '..', 'pangolin-verify', 'LICENSE');
const verifyTsconfigPath = join(__dirname, '..', '..', 'pangolin-verify', 'tsconfig.json');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8'));

it('names the package @quarry-systems/pangolin-product', () => {
  expect(pkg.name).toBe('@quarry-systems/pangolin-product');
});

it('rides the lockstep release train, not its scaffold default', () => {
  // The invariant is lockstep with the rest of the workspace, not any one
  // version number. This package shipped at 0.1.0 while the other fifteen were
  // 0.3.1 (PR #97) — the drift RELEASING.md's dry-run count check now also
  // catches — so the guard is worth keeping.
  //
  // Asserted RELATIVELY, against pangolin-core. Hard-coding the current version
  // made this test fail on every single release, which turns a real guard into
  // a release chore and trains whoever hits it to edit the number without
  // thinking about what it is guarding.
  const corePath = join(__dirname, '..', '..', 'pangolin-core', 'package.json');
  const core = JSON.parse(readFileSync(corePath, 'utf8'));
  expect(pkg.version).toBe(core.version);
  expect(pkg.version).not.toBe('0.1.0');
});

it('is licensed BUSL-1.1', () => {
  expect(pkg.license).toBe('BUSL-1.1');
});

it('is an ESM package with dist entrypoints', () => {
  expect(pkg.type).toBe('module');
  expect(pkg.main).toBe('dist/index.js');
  expect(pkg.types).toBe('dist/index.d.ts');
});

it('declares exactly one dependency: pangolin-core', () => {
  expect(pkg.dependencies).toEqual({
    '@quarry-systems/pangolin-core': 'workspace:*',
  });
});

it('carries no devDependencies beyond what siblings carry', () => {
  expect(pkg.devDependencies ?? {}).toEqual({});
});

it('has no bin field', () => {
  expect(pkg.bin).toBeUndefined();
});

it('declares the standard scripts, including the test-typecheck gate', () => {
  // Strict `toEqual` on purpose: this pins the exact set AND the exact command
  // strings, so a drift in either fails loudly. It caught the `lint` widening
  // and the `typecheck:test` addition when those landed (issue #99).
  expect(pkg.scripts).toEqual({
    lint: 'eslint src test --ext .ts',
    test: 'vitest run',
    typecheck: 'tsc --noEmit',
    'typecheck:test': 'tsc --noEmit -p tsconfig.test.json',
    build: 'tsc',
    clean: 'rm -rf dist',
  });
});

it('is publishable to the public npm registry', () => {
  expect(pkg.publishConfig).toEqual({ access: 'public' });
});

it('packs only dist, README, and LICENSE', () => {
  expect(pkg.files).toEqual(['dist', 'README.md', 'LICENSE']);
});

it('points repository/homepage/bugs at the pangolin monorepo', () => {
  expect(pkg.repository).toEqual({
    type: 'git',
    url: 'git+https://github.com/QuarrySystems/pangolin.git',
    directory: 'packages/pangolin-product',
  });
  expect(pkg.homepage).toBe('https://quarrysystems.github.io/pangolin');
  expect(pkg.bugs).toEqual({ url: 'https://github.com/QuarrySystems/pangolin/issues' });
});

it('tsconfig extends the shared base and matches the pangolin-verify shape', () => {
  const verifyTsconfig = JSON.parse(readFileSync(verifyTsconfigPath, 'utf8'));
  expect(tsconfig.extends).toBe('../../tsconfig.base.json');
  expect(tsconfig.compilerOptions).toEqual({ outDir: 'dist', rootDir: 'src' });
  expect(tsconfig.include).toEqual(['src/**/*']);
  expect(tsconfig).toEqual(verifyTsconfig);
});

it('LICENSE is byte-identical to pangolin-verify/LICENSE', () => {
  const license = readFileSync(licensePath);
  const verifyLicense = readFileSync(verifyLicensePath);
  expect(license.equals(verifyLicense)).toBe(true);
});
