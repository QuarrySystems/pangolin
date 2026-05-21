import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const readJson = (relPath: string): unknown => {
  const full = resolve(repoRoot, relPath);
  const raw = readFileSync(full, 'utf8');
  return JSON.parse(raw);
};

describe('monorepo bootstrap', () => {
  describe('package.json (root manifest)', () => {
    let pkg: Record<string, unknown>;

    it('exists and parses as JSON', () => {
      expect(existsSync(resolve(repoRoot, 'package.json'))).toBe(true);
      pkg = readJson('package.json') as Record<string, unknown>;
      expect(pkg).toBeTypeOf('object');
    });

    it('declares name "agora"', () => {
      pkg = readJson('package.json') as Record<string, unknown>;
      expect(pkg.name).toBe('agora');
    });

    it('is marked private', () => {
      pkg = readJson('package.json') as Record<string, unknown>;
      expect(pkg.private).toBe(true);
    });

    it('declares a packageManager field pinning pnpm', () => {
      pkg = readJson('package.json') as Record<string, unknown>;
      expect(pkg.packageManager).toMatch(/^pnpm@/);
    });

    it('declares the four root fan-out scripts (lint, test, typecheck, build)', () => {
      pkg = readJson('package.json') as Record<string, unknown>;
      const scripts = pkg.scripts as Record<string, string> | undefined;
      expect(scripts).toBeDefined();
      for (const name of ['lint', 'test', 'typecheck', 'build']) {
        expect(scripts?.[name], `script ${name}`).toBeDefined();
        expect(scripts?.[name], `script ${name} fans out via pnpm -r`).toContain('pnpm -r');
      }
    });

    it('declares required devDependencies', () => {
      pkg = readJson('package.json') as Record<string, unknown>;
      const dev = pkg.devDependencies as Record<string, string> | undefined;
      expect(dev).toBeDefined();
      for (const name of [
        'typescript',
        '@typescript-eslint/parser',
        '@typescript-eslint/eslint-plugin',
        'eslint',
        'prettier',
        'vitest',
      ]) {
        expect(dev?.[name], `devDependency ${name}`).toBeDefined();
      }
    });
  });

  describe('pnpm-workspace.yaml', () => {
    it('exists and declares packages: packages/*', () => {
      const full = resolve(repoRoot, 'pnpm-workspace.yaml');
      expect(existsSync(full)).toBe(true);
      const raw = readFileSync(full, 'utf8');
      // Loose YAML match — avoids pulling in a yaml dep for a single assertion.
      expect(raw).toMatch(/packages\s*:/);
      expect(raw).toMatch(/['"]?packages\/\*['"]?/);
    });
  });

  describe('tsconfig.base.json', () => {
    let tsconfig: { compilerOptions?: Record<string, unknown> };

    it('exists and parses', () => {
      const full = resolve(repoRoot, 'tsconfig.base.json');
      expect(existsSync(full)).toBe(true);
      tsconfig = readJson('tsconfig.base.json') as typeof tsconfig;
      expect(tsconfig).toBeTypeOf('object');
    });

    it('declares strict ES2022 NodeNext compiler options', () => {
      tsconfig = readJson('tsconfig.base.json') as typeof tsconfig;
      const opts = tsconfig.compilerOptions;
      expect(opts).toBeDefined();
      expect(opts?.strict).toBe(true);
      expect(opts?.target).toBe('ES2022');
      expect(opts?.module).toBe('NodeNext');
      expect(opts?.moduleResolution).toBe('NodeNext');
      expect(opts?.esModuleInterop).toBe(true);
      expect(opts?.skipLibCheck).toBe(true);
      expect(opts?.forceConsistentCasingInFileNames).toBe(true);
      expect(opts?.declaration).toBe(true);
      expect(opts?.declarationMap).toBe(true);
      expect(opts?.sourceMap).toBe(true);
    });

    it('does NOT declare outDir (per-package tsconfigs own that)', () => {
      tsconfig = readJson('tsconfig.base.json') as typeof tsconfig;
      expect(tsconfig.compilerOptions?.outDir).toBeUndefined();
    });
  });

  describe('.eslintrc.cjs', () => {
    it('exists and extends @typescript-eslint/recommended', () => {
      const full = resolve(repoRoot, '.eslintrc.cjs');
      expect(existsSync(full)).toBe(true);
      const raw = readFileSync(full, 'utf8');
      expect(raw).toContain('@typescript-eslint/recommended');
      expect(raw).toContain('@typescript-eslint/parser');
    });
  });

  describe('.prettierrc.json', () => {
    it('exists and declares the locked formatting defaults', () => {
      const full = resolve(repoRoot, '.prettierrc.json');
      expect(existsSync(full)).toBe(true);
      const cfg = readJson('.prettierrc.json') as Record<string, unknown>;
      expect(cfg.tabWidth).toBe(2);
      expect(cfg.singleQuote).toBe(true);
      expect(cfg.trailingComma).toBe('all');
    });
  });

  describe('.gitignore', () => {
    it('covers node_modules, dist, coverage, .env, *.log', () => {
      const full = resolve(repoRoot, '.gitignore');
      expect(existsSync(full)).toBe(true);
      const raw = readFileSync(full, 'utf8');
      const entries = raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
      const has = (pat: string) => entries.some((e) => e === pat);
      expect(has('node_modules/'), 'node_modules/').toBe(true);
      expect(has('dist/'), 'dist/').toBe(true);
      expect(has('coverage/'), 'coverage/').toBe(true);
      expect(has('.env'), '.env').toBe(true);
      expect(has('*.log'), '*.log').toBe(true);
    });
  });

  describe('README.md', () => {
    it('exists and is non-empty', () => {
      const full = resolve(repoRoot, 'README.md');
      expect(existsSync(full)).toBe(true);
      const raw = readFileSync(full, 'utf8');
      expect(raw.length).toBeGreaterThan(0);
      expect(raw.toLowerCase()).toContain('agora');
    });
  });
});
