import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Shared helpers for tests that assert documentation stays in step with the
 * actual `packages/` inventory.
 *
 * These live in one place because the repo has drifted the same way more than
 * once: `package-map.md` claimed "fourteen packages" while fifteen existed and
 * the table listed only fourteen, and the root README claimed "Thirteen" while
 * sixteen existed. Both were counted by hand. Anything asserting an inventory
 * should derive it from the filesystem rather than restate a number.
 */

export const repoRoot = join(__dirname, '..', '..', '..');
export const packagesDir = join(repoRoot, 'packages');

/** Every directory name under `packages/`, which is the authoritative inventory. */
export function packageDirNames(): string[] {
  return readdirSync(packagesDir).filter((entry) =>
    statSync(join(packagesDir, entry)).isDirectory(),
  );
}

export function packageCount(): number {
  return packageDirNames().length;
}

export function read(path: string): string {
  return readFileSync(path, 'utf-8');
}
