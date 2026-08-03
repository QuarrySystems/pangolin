import { it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureBaseline, computeWorkspacePatch } from '../src/patch-capture.js';

it('captures a baseline and diffs a subsequent file change, excluding .pangolin/', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pc-'));
  await writeFile(join(dir, 'a.txt'), 'one\n');
  const base = await captureBaseline(dir);
  await writeFile(join(dir, 'a.txt'), 'two\n');
  await mkdir(join(dir, '.pangolin'), { recursive: true });
  await writeFile(join(dir, '.pangolin', 'output.json'), '{}');
  const patch = await computeWorkspacePatch(dir, base);
  const text = new TextDecoder().decode(patch!);
  expect(text).toContain('a.txt');
  expect(text).toContain('+two');
  expect(text).not.toContain('.pangolin/output.json');
});

it('returns null when nothing changed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pc-'));
  await writeFile(join(dir, 'a.txt'), 'one\n');
  const base = await captureBaseline(dir);
  expect(await computeWorkspacePatch(dir, base)).toBeNull();
});

it('new files written after captureBaseline appear in the patch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pc-'));
  await writeFile(join(dir, 'existing.txt'), 'hello\n');
  const base = await captureBaseline(dir);
  // Write a brand-new file that did not exist at baseline time
  await writeFile(join(dir, 'new.txt'), 'brand-new\n');
  const patch = await computeWorkspacePatch(dir, base);
  const text = new TextDecoder().decode(patch!);
  expect(text).toContain('new.txt');
  expect(text).toContain('+brand-new');
});

it('files deleted after captureBaseline appear as removals in the patch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pc-'));
  await writeFile(join(dir, 'a.txt'), 'one\n');
  const base = await captureBaseline(dir);
  // Delete the file that existed at baseline
  await rm(join(dir, 'a.txt'));
  const patch = await computeWorkspacePatch(dir, base);
  const text = new TextDecoder().decode(patch!);
  expect(text).toContain('a.txt');
  // Unified diff marks removed lines with a leading '-'
  expect(text).toContain('-one');
});

it('computeWorkspacePatch returns null without throwing when baseline is unavailable', async () => {
  const result = await computeWorkspacePatch('/any/path', { unavailable: true });
  expect(result).toBeNull();
});

/** `git -C dir` for test-side replay. Mirrors the safe.directory flag src/ passes.
 *  autocrlf/eol are pinned because the replay runs on the developer's machine, not
 *  in the Linux worker image: with Windows defaults `git apply` rewrites LF to CRLF
 *  on checkout and the byte comparison fails on line endings rather than on the
 *  bytes under test. */
function execGit(dir: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [
      '-C',
      dir,
      '-c',
      'safe.directory=*',
      '-c',
      'core.autocrlf=false',
      '-c',
      'core.eol=lf',
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

/** Ordinary TypeScript whose only offence is two raw control bytes — which is all
 *  git's content heuristic needs to call the whole file binary. */
const binarySource = (body: string): Buffer =>
  Buffer.concat([
    Buffer.from('export const DELIM = "', 'utf8'),
    Buffer.from([0x00, 0x01]),
    Buffer.from(`";\n${body}\n`, 'utf8'),
  ]);

it('captures a git-binary file as a patch that still applies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pc-bin-'));
  const before = binarySource('// before');
  const after = binarySource('// after — the work this dispatch must not lose');
  await writeFile(join(dir, 'oracle.ts'), before);
  const base = await captureBaseline(dir);
  await writeFile(join(dir, 'oracle.ts'), after);

  const patch = await computeWorkspacePatch(dir, base);
  const text = new TextDecoder().decode(patch!);

  // Control: git really did take the binary path, so the assertion below is about
  // the payload being present rather than about a file that was text all along.
  expect(text).toContain('GIT binary patch');

  // The property that matters: the work is recoverable. Rebuild the baseline in a
  // clean repo and apply. Without --binary the patch is a one-line stub and this
  // fails with "cannot apply binary patch ... without full index line".
  const replay = await mkdtemp(join(tmpdir(), 'pc-replay-'));
  await writeFile(join(replay, 'oracle.ts'), before);
  await execGit(replay, ['init', '-q']);
  await execGit(replay, ['add', '-A']);
  await writeFile(join(replay, 'work.patch'), patch!);
  await execGit(replay, ['apply', 'work.patch']);

  expect(await readFile(join(replay, 'oracle.ts'))).toEqual(after);
});

it('preserves non-UTF-8 bytes in a file git classifies as TEXT', async () => {
  // KNOWN-ISSUES 18. 0xE9 is 'e-acute' in Latin-1. There is no NUL byte, so git
  // calls this file TEXT, `--binary` never engages, and the bytes land raw in an
  // ordinary hunk — where a utf8 decode/re-encode round trip rewrites each one as
  // EF BF BD. The patch then applies cleanly and writes the wrong bytes.
  const dir = await mkdtemp(join(tmpdir(), 'pc-latin1-'));
  const before = Buffer.from('hi\n', 'utf8');
  const after = Buffer.concat([
    Buffer.from('caf', 'utf8'),
    Buffer.from([0xe9]),
    Buffer.from('\n', 'utf8'),
  ]);
  await writeFile(join(dir, 'notes.txt'), before);
  const base = await captureBaseline(dir);
  await writeFile(join(dir, 'notes.txt'), after);

  const patch = Buffer.from((await computeWorkspacePatch(dir, base))!);

  // Control: this really did take the TEXT path, so the assertions below are about
  // the round trip and not about binary-payload encoding.
  expect(patch.includes('GIT binary patch')).toBe(false);
  expect(patch.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false); // no U+FFFD
  expect(patch.includes(Buffer.from([0xe9]))).toBe(true); // the byte itself survived

  // And the property that matters: replaying the patch reproduces the exact bytes.
  const replay = await mkdtemp(join(tmpdir(), 'pc-latin1-replay-'));
  await writeFile(join(replay, 'notes.txt'), before);
  await execGit(replay, ['init', '-q']);
  await execGit(replay, ['add', '-A']);
  await writeFile(join(replay, 'work.patch'), patch);
  await execGit(replay, ['apply', 'work.patch']);

  expect(await readFile(join(replay, 'notes.txt'))).toEqual(after);
});
