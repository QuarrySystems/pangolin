import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
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

const FORBIDDEN_PREFIXES = ['@quarry-systems/pangolin-core'];

describe('@quarry-systems/pangolin-providers-local-docker scaffold shape', () => {
  describe('package.json', () => {
    let pkg: Record<string, unknown>;

    it('(1) name is @quarry-systems/pangolin-providers-local-docker', () => {
      pkg = readJson('package.json') as Record<string, unknown>;
      expect(pkg.name).toBe('@quarry-systems/pangolin-providers-local-docker');
    });

    it('(2) dependencies includes @quarry-systems/pangolin-core at workspace:*', () => {
      pkg = readJson('package.json') as Record<string, unknown>;
      const deps = pkg.dependencies as Record<string, string> | undefined;
      expect(deps).toBeDefined();
      expect(deps?.['@quarry-systems/pangolin-core']).toBe('workspace:*');
    });

    it('(3) no forbidden external @quarry-systems/* prefixes in devDependencies or peerDependencies', () => {
      pkg = readJson('package.json') as Record<string, unknown>;
      const devDeps = pkg.devDependencies as Record<string, string> | undefined;
      const peerDeps = pkg.peerDependencies as Record<string, string> | undefined;

      const checkDeps = (deps: Record<string, string> | undefined, label: string) => {
        if (!deps) return;
        for (const key of Object.keys(deps)) {
          // pangolin-core is allowed as a workspace dep in dependencies but
          // no other @quarry-systems/* packages should appear in dev/peer
          if (key.startsWith('@quarry-systems/') && key !== '@quarry-systems/pangolin-core') {
            throw new Error(`Forbidden @quarry-systems dependency in ${label}: ${key}`);
          }
        }
      };

      checkDeps(devDeps, 'devDependencies');
      checkDeps(peerDeps, 'peerDependencies');
    });
  });

  describe('README.md', () => {
    it('(4) mentions local-docker and ComputeProvider', () => {
      // task-readmes-per-package owns the exact prose; this just sanity-checks
      // the README is present and identifies the package.
      const full = resolve(pkgRoot, 'README.md');
      expect(existsSync(full)).toBe(true);
      const raw = readFileSync(full, 'utf8');
      expect(raw.toLowerCase()).toContain('local-docker');
      expect(raw.toLowerCase()).toContain('computeprovider');
    });
  });
});
