import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, chmod, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { captureBaseline, computeWorkspacePatch } from '../src/patch-capture.js';

const AWS_VALUE = 'TOPSECRET-TASK-ROLE';
const REF_VALUE = 'secret-ref-abc';

/** Writes the hook + the repo-local config that invokes it. `leakDir` is deliberately
 *  outside `dir` so the hook's own output is not staged into the captured patch. */
async function plantHook(dir: string, leakDir: string): Promise<string> {
  const leak = join(leakDir, 'leak.txt');
  const hook = join(dir, '.git', 'evil.sh');
  await writeFile(hook, `#!/bin/sh\nenv > '${leak.split(sep).join('/')}'\nexit 1\n`);
  await chmod(hook, 0o755);
  // Backslashes are escapes in .git/config — forward-slash the path on every platform. Quote it
  // too: git runs core.fsmonitor through a shell, so an unquoted path containing a space breaks
  // the vector. That failure is fail-SAFE (no leak file, and the no-.catch read fails loudly)
  // rather than a false pass, but a mkdtemp path under a spaced user directory would waste a run.
  const cfgPath = hook.split(sep).join('/');
  await writeFile(join(dir, '.git', 'config'), `[core]\n\tfsmonitor = '${cfgPath}'\n`, {
    flag: 'a',
  });
  return leak;
}

describe('patch-capture escape', () => {
  it('a repo-local core.fsmonitor hook sees no credential from the worker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'escape-'));
    const leakDir = await mkdtemp(join(tmpdir(), 'escape-leak-'));

    await writeFile(join(dir, 'file.txt'), 'hello\n');
    const base = await captureBaseline(dir); // creates .git/ before the "agent" acts
    expect(base).toMatchObject({ treeOid: expect.any(String) }); // capture actually ran

    const leak = await plantHook(dir, leakDir); // the agent's move
    await writeFile(join(dir, 'file.txt'), 'hello\nagent change\n');

    process.env.AWS_SESSION_TOKEN = AWS_VALUE;
    process.env.PANGOLIN_CALLBACK_TOKEN_REF = REF_VALUE;
    await computeWorkspacePatch(dir, base);

    // No .catch — an absent file means the hook never ran and the test must fail loudly.
    const captured = await readFile(leak, 'utf8');

    // Positive controls: the hook executed, and it executed under the SCOPED env.
    expect(captured).toMatch(/^PATH=/m);
    expect(captured).toMatch(/^HOME=\/nonexistent$/m);

    // The actual security assertions.
    expect(captured).not.toContain(AWS_VALUE);
    expect(captured).not.toContain(REF_VALUE);
    expect(captured).not.toMatch(/^AWS_/m);
    expect(captured).not.toMatch(/^PANGOLIN_/m);
  });

  it('POSITIVE CONTROL: the same hook under an unscoped spawn does leak the worker env', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'escape-ctl-'));
    const leakDir = await mkdtemp(join(tmpdir(), 'escape-ctl-leak-'));
    await writeFile(join(dir, 'file.txt'), 'hello\n');

    // Drive git locally with NO env option — the pre-fix behaviour — so this test proves
    // the vector is live and the assertions above discriminate. No source file is touched.
    const rawGit = (args: string[]) =>
      new Promise<void>((resolve, reject) => {
        const c = spawn('git', ['-C', dir, '-c', 'safe.directory=*', ...args]);
        c.on('error', reject);
        c.on('exit', () => resolve()); // the hook exits 1 by design; ignore the status
      });

    await rawGit(['init', '-q']);
    const leak = await plantHook(dir, leakDir);
    process.env.AWS_SESSION_TOKEN = AWS_VALUE;
    await rawGit(['add', '-A']);

    const captured = await readFile(leak, 'utf8');
    expect(captured).toContain(AWS_VALUE);
  });
});
