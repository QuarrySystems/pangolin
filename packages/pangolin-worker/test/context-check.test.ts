import { it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import type { ContextRequirement } from '@quarry-systems/pangolin-core';
import { checkContextRequirements } from '../src/context-check.js';

/** `git -C dir` for test-side setup. Mirrors patch-capture.test.ts's execGit. */
function execGit(dir: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [
      '-C',
      dir,
      '-c',
      'safe.directory=*',
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=test',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ]);
    const err: Buffer[] = [];
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`git ${args.join(' ')} exited ${code}: ${Buffer.concat(err)}`)),
    );
  });
}

it('returns one result per requirement, including for kinds it cannot satisfy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-'));
  const reqs: ContextRequirement[] = [
    { kind: 'exec', bin: 'definitely-not-a-binary' },
    { kind: 'paths', glob: 'nothing/**' },
    { kind: 'git', needs: 'history' },
  ];
  const res = await checkContextRequirements(dir, reqs, { PATH: '/nonexistent' });
  // The arity invariant guards a branch that pushes nothing — a missing result
  // reads as SATISFIED downstream.
  expect(res).toHaveLength(reqs.length);
  expect(res.every((r) => r.met === false)).toBe(true);
  expect(res.every((r) => r.observed.length > 0)).toBe(true);
});

it('never throws for a nonexistent workspaceDir, resolving all three kinds', async () => {
  const reqs: ContextRequirement[] = [
    { kind: 'exec', bin: 'definitely-not-a-binary' },
    { kind: 'paths', glob: '**' },
    { kind: 'git', needs: 'worktree' },
  ];
  await expect(
    checkContextRequirements(join(tmpdir(), 'cc-does-not-exist-xyz'), reqs, {
      PATH: process.env.PATH ?? '',
    }),
  ).resolves.toHaveLength(3);
});

// --- exec ---------------------------------------------------------------

it('exec: a binary in a directory named by the passed env.PATH is met:true', async () => {
  const binDir = await mkdtemp(join(tmpdir(), 'cc-bin-'));
  await writeFile(join(binDir, 'planted-bin'), '');
  const res = await checkContextRequirements(binDir, [{ kind: 'exec', bin: 'planted-bin' }], {
    PATH: binDir,
  });
  expect(res[0].met).toBe(true);
});

it('exec: the same binary is met:false when env.PATH is /nonexistent', async () => {
  const binDir = await mkdtemp(join(tmpdir(), 'cc-bin-'));
  await writeFile(join(binDir, 'planted-bin'), '');
  const res = await checkContextRequirements(binDir, [{ kind: 'exec', bin: 'planted-bin' }], {
    PATH: '/nonexistent',
  });
  expect(res[0].met).toBe(false);
});

it('exec: planting the binary on the REAL process.env.PATH does not help — the passed env is used, no fallback', async () => {
  const binDir = await mkdtemp(join(tmpdir(), 'cc-bin-'));
  await writeFile(join(binDir, 'planted-bin'), '');
  const original = process.env.PATH;
  process.env.PATH = binDir + delimiter + (original ?? '');
  try {
    const res = await checkContextRequirements(binDir, [{ kind: 'exec', bin: 'planted-bin' }], {
      PATH: '/nonexistent',
    });
    expect(res[0].met).toBe(false);
  } finally {
    process.env.PATH = original;
  }
});

// --- paths ----------------------------------------------------------------

it('paths: a glob matching one file is met:true', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-paths-'));
  await writeFile(join(dir, 'match.txt'), 'x');
  const res = await checkContextRequirements(dir, [{ kind: 'paths', glob: 'match.txt' }], {
    PATH: process.env.PATH ?? '',
  });
  expect(res[0].met).toBe(true);
});

it('paths: a glob matching no file is met:false', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-paths-'));
  const res = await checkContextRequirements(dir, [{ kind: 'paths', glob: 'nope.txt' }], {
    PATH: process.env.PATH ?? '',
  });
  expect(res[0].met).toBe(false);
});

it('paths: minCount discriminates — 2 against one match is met:false, 1 against the same match is met:true', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-paths-'));
  await writeFile(join(dir, 'only.txt'), 'x');

  const two = await checkContextRequirements(
    dir,
    [{ kind: 'paths', glob: 'only.txt', minCount: 2 }],
    { PATH: process.env.PATH ?? '' },
  );
  expect(two[0].met).toBe(false);

  const one = await checkContextRequirements(
    dir,
    [{ kind: 'paths', glob: 'only.txt', minCount: 1 }],
    { PATH: process.env.PATH ?? '' },
  );
  expect(one[0].met).toBe(true);
});

it('paths: short-circuits at minCount, reporting exactly that many matches rather than the total', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-paths-'));
  for (let i = 0; i < 10; i++) {
    await writeFile(join(dir, `many-${i}.txt`), 'x');
  }
  const res = await checkContextRequirements(dir, [{ kind: 'paths', glob: '*.txt', minCount: 1 }], {
    PATH: process.env.PATH ?? '',
  });
  expect(res[0].met).toBe(true);
  expect(res[0].observed).toContain('1 match');
  expect(res[0].observed).not.toContain('10 match');
});

// --- git --------------------------------------------------------------

it("git needs:'worktree' is met:true in a git-init-ed dir with no commits, met:false with no .git", async () => {
  const withGit = await mkdtemp(join(tmpdir(), 'cc-git-'));
  await execGit(withGit, ['init', '-q']);
  const metRes = await checkContextRequirements(withGit, [{ kind: 'git', needs: 'worktree' }], {
    PATH: process.env.PATH ?? '',
  });
  expect(metRes[0].met).toBe(true);

  const withoutGit = await mkdtemp(join(tmpdir(), 'cc-nogit-'));
  const unmetRes = await checkContextRequirements(
    withoutGit,
    [{ kind: 'git', needs: 'worktree' }],
    { PATH: process.env.PATH ?? '' },
  );
  expect(unmetRes[0].met).toBe(false);
});

it("git needs:'history' is met:false in a zero-commit dir and met:true once a commit exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-git-'));
  await execGit(dir, ['init', '-q']);

  const before = await checkContextRequirements(dir, [{ kind: 'git', needs: 'history' }], {
    PATH: process.env.PATH ?? '',
  });
  expect(before[0].met).toBe(false);

  await writeFile(join(dir, 'a.txt'), 'x');
  await execGit(dir, ['add', '-A']);
  await execGit(dir, ['commit', '-q', '-m', 'first']);

  const after = await checkContextRequirements(dir, [{ kind: 'git', needs: 'history' }], {
    PATH: process.env.PATH ?? '',
  });
  expect(after[0].met).toBe(true);
});

it('git is fail-closed: with a PATH from which git is unresolvable, met:false naming the cause, no throw', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-git-'));
  await execGit(dir, ['init', '-q']);

  const res = await checkContextRequirements(dir, [{ kind: 'git', needs: 'worktree' }], {
    PATH: '/nonexistent',
  });
  expect(res[0].met).toBe(false);
  expect(res[0].observed.length).toBeGreaterThan(0);
});
