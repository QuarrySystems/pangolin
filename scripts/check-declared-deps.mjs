#!/usr/bin/env node
// Clean-room dependency guard.
//
// After `pnpm -r build`, assert that every bare module specifier imported by a package's
// BUILT dist is either a Node builtin or a DECLARED dependency of that package
// (dependencies / peerDependencies / optionalDependencies). This is the precise, hermetic
// guard for the 2026-05-27 ship-blocker class: a refactor dropped a package from a consumer's
// `dependencies` but kept importing it; ~70 src/injected-dep tests passed, yet any CLEAN
// consumer got MODULE_NOT_FOUND (the dep resolved only via workspace hoisting).
//
// Static scan of dist only — no install, no temp dir, no network → deterministic + cross-platform.
// It also catches the stale/missing-build case: a package whose `main` points into dist/ but has
// no dist/ fails loudly (in CI `pnpm -r build` runs first, so this means the build genuinely failed).

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const pkgsDir = join(repoRoot, 'packages');
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

// Bare specifiers reachable at runtime: `from '…'`, `require('…')`, dynamic `import('…')`.
// (`[^'"\n]` keeps a stray `from "` inside a multi-line template literal from swallowing the file.)
const SPEC_RE = /(?:\bfrom\s*|\brequire\(\s*|\bimport\(\s*)['"]([^'"\n]+)['"]/g;

// Valid npm package-name shape (optionally scoped). Filters out false matches from string
// literals / error messages (e.g. `${path}`, `never existed`) that the regex catches inside
// runtime code — a real dependency specifier always satisfies this; an error-message fragment never does.
const VALID_PKG = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

/** The installable package name for an import specifier, or null for relative/builtin/non-package. */
function pkgNameOf(spec) {
  if (spec.startsWith('.') || spec.startsWith('/')) return null;
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return VALID_PKG.test(name) ? name : null;
}

function walkJs(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkJs(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
}

let failed = false;
for (const name of readdirSync(pkgsDir).sort()) {
  const pkgDir = join(pkgsDir, name);
  const pjPath = join(pkgDir, 'package.json');
  if (!existsSync(pjPath)) continue;
  const pj = JSON.parse(readFileSync(pjPath, 'utf8'));
  const declared = new Set([
    ...Object.keys(pj.dependencies ?? {}),
    ...Object.keys(pj.peerDependencies ?? {}),
    ...Object.keys(pj.optionalDependencies ?? {}),
  ]);
  const distDir = join(pkgDir, 'dist');
  if (!existsSync(distDir)) {
    const expectsDist = (typeof pj.main === 'string' && pj.main.includes('dist')) || pj.scripts?.build;
    if (expectsDist) {
      console.error(`✗ ${pj.name}: main=${pj.main ?? '(none)'} expects dist/ but none exists — build missing or stale`);
      failed = true;
    } else {
      console.log(`- ${pj.name}: no dist/, no build (skipped)`);
    }
    continue;
  }

  const files = [];
  walkJs(distDir, files);
  const offenders = new Map(); // dep -> Set(relative file)
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    SPEC_RE.lastIndex = 0;
    let m;
    while ((m = SPEC_RE.exec(src)) !== null) {
      const dep = pkgNameOf(m[1]);
      if (!dep || BUILTINS.has(dep) || dep === pj.name || declared.has(dep)) continue;
      if (!offenders.has(dep)) offenders.set(dep, new Set());
      offenders.get(dep).add(relative(pkgDir, f));
    }
  }

  if (offenders.size) {
    failed = true;
    console.error(`✗ ${pj.name}: built dist imports UNDECLARED dependencies:`);
    for (const [dep, fileset] of offenders) {
      const shown = [...fileset].slice(0, 3).join(', ');
      console.error(`    ${dep}  (e.g. ${shown}${fileset.size > 3 ? ', …' : ''})`);
    }
  } else {
    console.log(`✓ ${pj.name}`);
  }
}

if (failed) {
  console.error(
    '\nclean-room dep guard FAILED: a built package imports a dependency it does not declare.\n' +
      'Add the missing package(s) to that package’s "dependencies" (or "peerDependencies"). ' +
      'Left unfixed, a clean consumer (outside the workspace hoist) hits MODULE_NOT_FOUND.',
  );
  process.exit(1);
}
console.log('\nclean-room dep guard: every package imports only declared dependencies. ✓');
