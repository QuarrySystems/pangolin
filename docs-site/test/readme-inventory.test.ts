import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { packageDirNames, packageCount, read, repoRoot } from './helpers/packages.js';

// The root README carries three separate inventories of `packages/` — a prose
// count, a table, and two dependency-graph renderings (mermaid + ASCII). All
// four were hand-maintained and all four had drifted: the README said
// "Thirteen packages" while sixteen existed, omitting pangolin-verify,
// pangolin-signer-aws-kms, and pangolin-product entirely.
//
// These assertions derive the expected set from the filesystem, so adding a
// package fails here until every inventory is updated — which is the only way
// a count in prose stays true.

const readmePath = join(repoRoot, 'README.md');

const NUMBER_WORDS: Record<number, string> = {
  12: 'Twelve',
  13: 'Thirteen',
  14: 'Fourteen',
  15: 'Fifteen',
  16: 'Sixteen',
  17: 'Seventeen',
  18: 'Eighteen',
  19: 'Nineteen',
  20: 'Twenty',
};

it('README states a package count matching the actual packages/ directory count', () => {
  const count = packageCount();
  const word = NUMBER_WORDS[count];
  expect(word, `no number word mapped for ${count} packages — extend NUMBER_WORDS`).toBeDefined();
  expect(read(readmePath)).toContain(`${word} packages under`);
});

it('README table names every directory under packages/', () => {
  const readme = read(readmePath);
  const missing = packageDirNames().filter(
    (name) => !readme.includes(`[\`${name}\`](packages/${name}/)`),
  );
  expect(missing, `missing from the README package table: ${missing.join(', ')}`).toEqual([]);
});

it('README mermaid dependency graph declares a node for every package', () => {
  const readme = read(readmePath);
  const mermaid = readme.slice(
    readme.indexOf('```mermaid'),
    readme.indexOf('```', readme.indexOf('```mermaid') + 3),
  );
  // Each node is declared as `id[pangolin-foo...]`; assert the package name appears
  // inside a node declaration rather than merely somewhere in the block.
  const missing = packageDirNames().filter((name) => !new RegExp(`\\[${name}[\\]<]`).test(mermaid));
  expect(missing, `missing from the README mermaid graph: ${missing.join(', ')}`).toEqual([]);
});

it('README ASCII dependency rendering lists every package', () => {
  const readme = read(readmePath);
  const start = readme.indexOf('```text');
  const ascii = readme.slice(start, readme.indexOf('```', start + 3));
  const missing = packageDirNames().filter((name) => !ascii.includes(name));
  expect(missing, `missing from the README ASCII graph: ${missing.join(', ')}`).toEqual([]);
});

// ADR files are `NNNN-slug.md`; `index.md` is the listing page, not an ADR.
function adrCount(): number {
  const decisionsDir = join(
    repoRoot,
    'docs-site',
    'src',
    'content',
    'docs',
    'explanation',
    'decisions',
  );
  return readdirSync(decisionsDir).filter((f) => /^\d{4}-.*\.md$/.test(f)).length;
}

it('README ADR count matches the number of ADR files', () => {
  const count = adrCount();
  const word = NUMBER_WORDS[count];
  expect(word, `no number word mapped for ${count} ADRs — extend NUMBER_WORDS`).toBeDefined();
  expect(read(readmePath)).toContain(`${word.toLowerCase()} ADRs`);
});
