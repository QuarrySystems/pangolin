import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { it, expect } from 'vitest';

const repoRoot = join(__dirname, '..', '..');
const decisionsDir = join(
  repoRoot,
  'docs-site',
  'src',
  'content',
  'docs',
  'explanation',
  'decisions',
);
const indexPath = join(decisionsDir, 'index.md');
const adrPath = join(decisionsDir, '0020-dispatch-product-read.md');

function read(path: string): string {
  return readFileSync(path, 'utf-8');
}

function adrFiles(): string[] {
  return readdirSync(decisionsDir).filter((entry) => /^\d{4}-.*\.md$/.test(entry));
}

it('every NNNN-*.md ADR file has a matching bullet in index.md, and vice versa', () => {
  const files = adrFiles();
  const index = read(indexPath);
  const bulletNumbers = [...index.matchAll(/^-\s*\[(\d{4})\]/gm)].map((m) => m[1]);

  const fileNumbers = files.map((f) => f.slice(0, 4)).sort();
  const sortedBulletNumbers = [...bulletNumbers].sort();

  expect(fileNumbers).toEqual(sortedBulletNumbers);
});

it('ADR-0020 exists with the required frontmatter and section headings', () => {
  const content = read(adrPath);

  expect(content).toMatch(/^title:/m);
  expect(content).toMatch(/^description:/m);
  expect(content).toMatch(/^status:\s*accepted/m);
  expect(content).toMatch(/^date:/m);
  expect(content).toMatch(/^deciders:/m);

  expect(content).toMatch(/## Context/);
  expect(content).toMatch(/## Decision/);
  expect(content).toMatch(/## Consequences/);
});

it('ADR-0020 states the trust asymmetry between the sentinel and content-addressed refs', () => {
  const content = read(adrPath).toLowerCase();
  expect(content).toMatch(/overwrite[- ]put/);
  expect(content).toMatch(/no hash to verify against|no hash to verify/);
  expect(content).toMatch(/content-addressed/);
  expect(content).toMatch(/self-verifying/);
});

it('ADR-0020 explains why fetchVerified was not merged into the published fetcher', () => {
  const content = read(adrPath).toLowerCase();
  expect(content).toMatch(/fetchverified/);
  expect(content).toMatch(/dual-mode/);
  expect(content).toMatch(/trusted channel/);
});

it('ADR-0020 records lockstep pairing and the backward-read obligation', () => {
  const content = read(adrPath).toLowerCase();
  expect(content).toMatch(/lockstep/);
  expect(content).toMatch(/digest-pinned/);
  expect(content).toMatch(/backward[- ]read/);
});

it('ADR-0020 records the describe() gap for fire-and-forget consumers', () => {
  const content = read(adrPath).toLowerCase();
  expect(content).toMatch(/describe\(\)/);
  expect(content).toMatch(/writedispatchrecord/);
  expect(content).toMatch(/reconcile/);
});

it('index.md links ADR-0020 as a bullet-list entry', () => {
  const index = read(indexPath);
  expect(index).toMatch(
    /^-\s*\[0020\]\(\/pangolin\/explanation\/decisions\/0020-dispatch-product-read\/\)/m,
  );
});
