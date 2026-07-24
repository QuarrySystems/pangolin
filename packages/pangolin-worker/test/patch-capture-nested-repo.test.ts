import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureBaseline, computeWorkspacePatch } from '../src/patch-capture.js';

// Pins CURRENT behaviour, not desired behaviour. The underlying defect is tracked as the
// `agora` wiki task
// `task-patch-capture-silently-drops-every-edit-inside-a-nested-repository-gitlink`,
// which carries the reproduction and four candidate fix shapes. When that task lands,
// this test is expected to change.
describe('patch-capture with a nested repository', () => {
  it('does NOT capture edits inside a nested repository (documented gitlink behaviour)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nested-'));
    const inner = join(dir, 'repo');
    await mkdir(inner);
    await writeFile(join(inner, 'src.txt'), 'original\n');
    const g = (args: string[], cwd: string) =>
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd });
    g(['init', '-q', '.'], inner);
    g(['add', '-A'], inner);
    g(['commit', '-qm', 'init'], inner);

    await writeFile(join(dir, 'top.txt'), 'top\n');
    const base = await captureBaseline(dir);

    await writeFile(join(inner, 'src.txt'), 'original\nagent change\n'); // invisible
    await writeFile(join(dir, 'newtop.txt'), 'new top file\n'); // visible

    const bytes = await computeWorkspacePatch(dir, base);
    expect(bytes).not.toBeNull();
    const patch = new TextDecoder().decode(bytes!);

    // Positive control first: capture ran and produced real output, so the absence
    // assertion below cannot pass for the wrong reason.
    expect(patch.length).toBeGreaterThan(0);
    expect(patch).toContain('newtop.txt');

    expect(patch).not.toContain('agent change');
  });
});
