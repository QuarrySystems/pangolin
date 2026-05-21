#!/usr/bin/env node
// check-dep-allowlist.mjs — architectural enforcement of agora's orthogonality
// principle (§7.7 of the agora design).
//
// Walks every `package.json` in `packages/*` relative to the current working
// directory and rejects any `dependencies`, `devDependencies`, or
// `peerDependencies` entry whose name matches a forbidden prefix:
//
//   - @stoa-mcp/*
//   - @quarry-systems/bedrock-*
//   - @rastate/*
//   - @quarry-systems/drift-*
//
// Without this check the orthogonality boundary is policy, not architecture.
//
// Resolution: `packages/*` is resolved relative to `process.cwd()` (NOT the
// script file) so the script can be exercised against a fake monorepo from a
// tmp directory in tests.
//
// Exit codes:
//   0  all packages clean
//   1  one or more violations; offending package + dep + block printed to stderr
//
// Run as a Node ESM script: `node scripts/check-dep-allowlist.mjs`.
// Zero npm dependencies — uses only `node:fs/promises` and `node:path`.

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const FORBIDDEN = [
  /^@stoa-mcp\//,
  /^@quarry-systems\/bedrock-/,
  /^@rastate\//,
  /^@quarry-systems\/drift-/,
];

const DEP_BLOCKS = ['dependencies', 'devDependencies', 'peerDependencies'];

async function findPackageJsonFiles(packagesDir) {
  let entries;
  try {
    entries = await readdir(packagesDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(packagesDir, entry.name, 'package.json');
    try {
      const s = await stat(candidate);
      if (s.isFile()) files.push(candidate);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return files.sort();
}

async function main() {
  const packagesDir = join(process.cwd(), 'packages');
  const packageFiles = await findPackageJsonFiles(packagesDir);

  if (packageFiles.length === 0) {
    console.error(
      `check-dep-allowlist: no package.json files found under ${packagesDir}`,
    );
    process.exit(1);
  }

  const violations = [];
  for (const path of packageFiles) {
    let pkg;
    try {
      pkg = JSON.parse(await readFile(path, 'utf8'));
    } catch (err) {
      console.error(`check-dep-allowlist: cannot parse ${path}: ${err.message}`);
      process.exit(1);
    }
    const pkgName = pkg.name ?? path;
    for (const block of DEP_BLOCKS) {
      const deps = pkg[block];
      if (!deps || typeof deps !== 'object') continue;
      for (const dep of Object.keys(deps)) {
        if (FORBIDDEN.some((re) => re.test(dep))) {
          violations.push({ pkg: pkgName, block, dep });
        }
      }
    }
  }

  if (violations.length > 0) {
    console.error('check-dep-allowlist: dependency allowlist violations:');
    for (const v of violations) {
      console.error(`  - ${v.pkg} declares ${v.dep} in ${v.block}`);
    }
    process.exit(1);
  }

  console.log(
    `check-dep-allowlist: all ${packageFiles.length} packages pass dependency allowlist check.`,
  );
  process.exit(0);
}

await main();
