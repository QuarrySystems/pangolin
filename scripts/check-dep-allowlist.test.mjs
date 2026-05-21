// check-dep-allowlist.test.mjs — exercise the orthogonality-boundary script
// across the real monorepo and against a fabricated violating package.
//
// Run as: `node scripts/check-dep-allowlist.test.mjs`
// Uses the built-in `node:test` runner (no extra dependency).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'check-dep-allowlist.mjs');
const REPO_ROOT = resolve(__dirname, '..');

test('accepts the monorepo as it stands (all packages clean)', () => {
  const output = execSync(`node ${JSON.stringify(SCRIPT)}`, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.match(output, /pass dependency allowlist check/);
});

test('rejects a package declaring a forbidden @stoa-mcp dependency', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'dep-allowlist-stoa-'));
  try {
    await mkdir(join(tmp, 'packages', 'foo'), { recursive: true });
    await writeFile(
      join(tmp, 'packages', 'foo', 'package.json'),
      JSON.stringify({
        name: '@quarry-systems/foo',
        dependencies: { '@stoa-mcp/some-thing': '1.0.0' },
      }),
    );
    let exitCode = 0;
    let stderr = '';
    try {
      execSync(`node ${JSON.stringify(SCRIPT)}`, {
        cwd: tmp,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      exitCode = e.status;
      stderr = e.stderr?.toString() ?? '';
    }
    assert.equal(exitCode, 1, 'script should exit 1 on forbidden dependency');
    assert.match(stderr, /@quarry-systems\/foo/);
    assert.match(stderr, /@stoa-mcp\/some-thing/);
    assert.match(stderr, /dependencies/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('rejects a package declaring a forbidden @quarry-systems/bedrock-* dependency', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'dep-allowlist-bedrock-'));
  try {
    await mkdir(join(tmp, 'packages', 'foo'), { recursive: true });
    await writeFile(
      join(tmp, 'packages', 'foo', 'package.json'),
      JSON.stringify({
        name: '@quarry-systems/foo',
        devDependencies: { '@quarry-systems/bedrock-core': '1.0.0' },
      }),
    );
    let exitCode = 0;
    let stderr = '';
    try {
      execSync(`node ${JSON.stringify(SCRIPT)}`, {
        cwd: tmp,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      exitCode = e.status;
      stderr = e.stderr?.toString() ?? '';
    }
    assert.equal(exitCode, 1);
    assert.match(stderr, /@quarry-systems\/bedrock-core/);
    assert.match(stderr, /devDependencies/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('rejects a package declaring a forbidden @rastate dependency in peerDependencies', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'dep-allowlist-rastate-'));
  try {
    await mkdir(join(tmp, 'packages', 'foo'), { recursive: true });
    await writeFile(
      join(tmp, 'packages', 'foo', 'package.json'),
      JSON.stringify({
        name: '@quarry-systems/foo',
        peerDependencies: { '@rastate/core': '1.0.0' },
      }),
    );
    let exitCode = 0;
    let stderr = '';
    try {
      execSync(`node ${JSON.stringify(SCRIPT)}`, {
        cwd: tmp,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      exitCode = e.status;
      stderr = e.stderr?.toString() ?? '';
    }
    assert.equal(exitCode, 1);
    assert.match(stderr, /@rastate\/core/);
    assert.match(stderr, /peerDependencies/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('rejects a package declaring a forbidden @quarry-systems/drift-* dependency', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'dep-allowlist-drift-'));
  try {
    await mkdir(join(tmp, 'packages', 'foo'), { recursive: true });
    await writeFile(
      join(tmp, 'packages', 'foo', 'package.json'),
      JSON.stringify({
        name: '@quarry-systems/foo',
        dependencies: { '@quarry-systems/drift-engine': '1.0.0' },
      }),
    );
    let exitCode = 0;
    let stderr = '';
    try {
      execSync(`node ${JSON.stringify(SCRIPT)}`, {
        cwd: tmp,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      exitCode = e.status;
      stderr = e.stderr?.toString() ?? '';
    }
    assert.equal(exitCode, 1);
    assert.match(stderr, /@quarry-systems\/drift-engine/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('allows non-forbidden @quarry-systems packages (e.g., agora-core workspace ref)', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'dep-allowlist-allowed-'));
  try {
    await mkdir(join(tmp, 'packages', 'foo'), { recursive: true });
    await writeFile(
      join(tmp, 'packages', 'foo', 'package.json'),
      JSON.stringify({
        name: '@quarry-systems/foo',
        dependencies: {
          '@quarry-systems/agora-core': 'workspace:*',
          '@aws-sdk/client-s3': '^3.700.0',
        },
      }),
    );
    const output = execSync(`node ${JSON.stringify(SCRIPT)}`, {
      cwd: tmp,
      encoding: 'utf8',
    });
    assert.match(output, /pass dependency allowlist check/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
