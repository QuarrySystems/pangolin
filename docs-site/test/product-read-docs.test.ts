import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { it, expect } from 'vitest';

const repoRoot = join(__dirname, '..', '..');
const docsRoot = join(repoRoot, 'docs-site', 'src', 'content', 'docs');
const packagesDir = join(repoRoot, 'packages');

const packageMapPath = join(docsRoot, 'reference', 'package-map.md');
const dispatchLifecyclePath = join(docsRoot, 'reference', 'dispatch-lifecycle.md');
const clientApiPath = join(docsRoot, 'reference', 'pangolin-client-api.md');
const architectureOverviewPath = join(docsRoot, 'explanation', 'architecture-overview.md');

function read(path: string): string {
  return readFileSync(path, 'utf-8');
}

function actualPackageCount(): number {
  return readdirSync(packagesDir).filter((entry) =>
    statSync(join(packagesDir, entry)).isDirectory(),
  ).length;
}

it('package-map states a package count that matches the actual packages/ directory count', () => {
  const count = actualPackageCount();
  expect(count).toBe(16); // sanity: fails loudly if packages/ drifts without this test being updated

  const content = read(packageMapPath);
  expect(content).not.toMatch(/fourteen/i);
  // The count is spelled out in words (e.g. "sixteen"); assert the number word
  // that's actually present agrees with the directory count via a small map,
  // so this test catches future drift instead of hardcoding "sixteen" three times.
  const numberWords: Record<number, string> = {
    14: 'fourteen',
    15: 'fifteen',
    16: 'sixteen',
    17: 'seventeen',
    18: 'eighteen',
  };
  const expectedWord = numberWords[count];
  expect(expectedWord, `no number-word mapping for package count ${count}`).toBeDefined();
  expect(content).toMatch(new RegExp(expectedWord, 'i'));
});

it('package-map table row count matches the actual packages/ directory count', () => {
  const count = actualPackageCount();
  const content = read(packageMapPath);
  const rowMatches = content.match(/^\|\s*`pangolin-[a-z0-9-]+`\s*\|/gm) ?? [];
  expect(rowMatches.length).toBe(count);
});

it('package-map names every directory under packages/ by name', () => {
  const dirNames = readdirSync(packagesDir).filter((entry) =>
    statSync(join(packagesDir, entry)).isDirectory(),
  );
  const content = read(packageMapPath);
  for (const dirName of dirNames) {
    expect(content, `${dirName} is missing from package-map.md`).toMatch(
      new RegExp('`' + dirName + '`'),
    );
  }
});

it('package-map documents pangolin-product as a table row depending only on pangolin-core', () => {
  const content = read(packageMapPath);
  expect(content).toMatch(/\|\s*`pangolin-product`\s*\|/);
  const productRowMatch = content.match(/\|\s*`pangolin-product`\s*\|.*\|/);
  expect(productRowMatch).not.toBeNull();
  expect(productRowMatch![0]).toMatch(/pangolin-core/);
});

it('package-map mermaid graph includes a pangolin-product node pointing at core', () => {
  const content = read(packageMapPath);
  const mermaidMatch = content.match(/```mermaid([\s\S]*?)```/);
  expect(mermaidMatch).not.toBeNull();
  const mermaid = mermaidMatch![1];
  expect(mermaid).toMatch(/product\[pangolin-product/);
  expect(mermaid).toMatch(/product\s*-->\s*core/);
});

it('pangolin-client-api documents that dispatch.describe only observes reconciled dispatches', () => {
  const content = read(clientApiPath);
  expect(content).toMatch(/readOutputSentinel/);
  // The fire-only gap must be spelled out, not just implied by adjacency.
  expect(content.toLowerCase()).toMatch(/fire.{0,400}(never writes|no dispatch record|writes no)/s);
});

it('dispatch-lifecycle documents the public read and the sentinel vs artifact trust distinction', () => {
  const content = read(dispatchLifecyclePath);
  expect(content).toMatch(/readOutputSentinel/);
  expect(content).toMatch(/fetchDispatchArtifact/);
  expect(content.toLowerCase()).toMatch(/uri-addressed overwrite put/);
  expect(content.toLowerCase()).toMatch(/content-addressed/);
});

it('architecture-overview notes the sentinel is readable without reconcile', () => {
  const content = read(architectureOverviewPath);
  const escapeStepMatch = content.match(
    /\d+\.\s+\*\*Escape\.\*\*[\s\S]*?(?=\n\d+\.\s+\*\*|\n##\s)/,
  );
  expect(escapeStepMatch).not.toBeNull();
  expect(escapeStepMatch![0].toLowerCase()).toMatch(/without (that )?reconcile/);
});

it('does not describe unbuilt surface: a populated summary field, a head() probe, a size cap, or a batch fetch', () => {
  const files = [packageMapPath, dispatchLifecyclePath, clientApiPath, architectureOverviewPath];
  for (const file of files) {
    const content = read(file);
    expect(content, `${file} must not document a head() probe`).not.toMatch(/head\(\)/);
    expect(content, `${file} must not document a batch fetch`).not.toMatch(/batch fetch/i);
    expect(content, `${file} must not document a size cap on the artifact read`).not.toMatch(
      /size[- ]?(bound|cap|limit)ed? read/i,
    );
    // "summary" as a populated field name (not the general English word) —
    // guard against `summary:` frontmatter or a documented `summary` sentinel field.
    expect(content, `${file} must not document a populated summary field`).not.toMatch(
      /\bsummary\b\s+field/i,
    );
  }
});
