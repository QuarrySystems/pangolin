import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGitEnv, captureBaseline, computeWorkspacePatch } from '../src/patch-capture.js';

describe('buildGitEnv', () => {
  it('gives git exactly the six-key allow-list and nothing else', () => {
    process.env.AWS_SESSION_TOKEN = 'MUST-NOT-LEAK';
    process.env.PANGOLIN_CALLBACK_TOKEN_REF = 'MUST-NOT-LEAK';
    expect(Object.keys(buildGitEnv()).sort()).toEqual([
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_NOSYSTEM',
      'GIT_TERMINAL_PROMPT',
      'HOME',
      'LC_ALL',
      'PATH',
    ]);
    expect(buildGitEnv().HOME).toBe('/nonexistent');
    expect(buildGitEnv().GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(buildGitEnv().GIT_CONFIG_NOSYSTEM).toBe('1');
  });
});

describe('git() wiring', () => {
  afterEach(() => {
    delete process.env.GIT_DIR;
  });

  // Cross-platform proof that git() runs under buildGitEnv() rather than process.env,
  // with no shell hook involved. GIT_DIR is honoured by git when inherited and would
  // redirect the repo away from the workspace: pre-fix, `git add -A` exits 128
  // ("this operation must be run in a work tree"), captureBaseline swallows it and
  // returns { unavailable: true }, and computeWorkspacePatch returns null. Post-fix
  // GIT_DIR is simply absent from the child's environment and capture is unaffected.
  // Verified to discriminate on git 2.35.1.
  it('ignores GIT_DIR set in the worker process.env', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gitenv-'));
    await writeFile(join(dir, 'a.txt'), 'one\n');
    process.env.GIT_DIR = join(tmpdir(), 'hijacked-should-not-be-used.git');

    const base = await captureBaseline(dir);
    expect(base).toMatchObject({ treeOid: expect.any(String) }); // pre-fix: { unavailable: true }

    await writeFile(join(dir, 'a.txt'), 'one\ntwo\n');
    const patch = await computeWorkspacePatch(dir, base);
    expect(patch).not.toBeNull(); // pre-fix: null
    expect(new TextDecoder().decode(patch!)).toContain('+two');
  });
});
