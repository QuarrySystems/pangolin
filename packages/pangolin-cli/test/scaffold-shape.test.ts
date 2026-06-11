import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgRoot = resolve(__dirname, '..');

const readJson = (relPath: string): unknown => {
  const full = resolve(pkgRoot, relPath);
  const raw = readFileSync(full, 'utf8');
  return JSON.parse(raw);
};

const FORBIDDEN_PREFIXES = [
  '@stoa-mcp/',
  '@quarry-systems/bedrock-',
  '@rastate/',
  '@quarry-systems/drift-',
];

describe('pangolin-cli scaffold shape', () => {
  describe('package.json', () => {
    let pkg: Record<string, unknown>;

    beforeEach(() => {
      pkg = readJson('package.json') as Record<string, unknown>;
    });

    it('has the correct package name', () => {
      expect(pkg.name).toBe('@quarry-systems/pangolin-cli');
    });

    it('declares bin.pangolin pointing at dist/index.js', () => {
      const bin = pkg.bin as Record<string, string> | undefined;
      expect(bin).toBeDefined();
      expect(bin?.pangolin).toBe('dist/index.js');
    });

    it('declares @quarry-systems/pangolin-client as a workspace dependency', () => {
      const deps = pkg.dependencies as Record<string, string> | undefined;
      expect(deps).toBeDefined();
      expect(deps?.['@quarry-systems/pangolin-client']).toBe('workspace:*');
    });

    it('has no forbidden dependency prefixes', () => {
      const deps = pkg.dependencies as Record<string, string> | undefined;
      const devDeps = pkg.devDependencies as Record<string, string> | undefined;
      const allDeps = [
        ...Object.keys(deps ?? {}),
        ...Object.keys(devDeps ?? {}),
      ];
      for (const dep of allDeps) {
        for (const prefix of FORBIDDEN_PREFIXES) {
          expect(dep, `dependency ${dep} uses forbidden prefix ${prefix}`).not.toMatch(
            new RegExp(`^${prefix.replace('/', '\\/').replace('-', '\\-')}`),
          );
        }
      }
    });
  });

  describe('README.md', () => {
    let readme: string;

    beforeEach(() => {
      readme = readFileSync(resolve(pkgRoot, 'README.md'), 'utf8');
    });

    it('describes this package as the CLI for Pangolin Scale', () => {
      // task-readmes-per-package owns README content; this is a sanity check.
      expect(readme.toLowerCase()).toContain('cli');
      expect(readme.toLowerCase()).toContain('pangolin');
    });
  });
});
