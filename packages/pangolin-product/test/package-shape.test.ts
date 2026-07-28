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

it('is pinned to the 0.4.0 release train, not 0.1.0', () => {
  expect(pkg.version).toBe('0.4.0');
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

it('declares all five standard scripts', () => {
  expect(pkg.scripts).toEqual({
    lint: 'eslint src --ext .ts',
    test: 'vitest run',
    typecheck: 'tsc --noEmit',
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
