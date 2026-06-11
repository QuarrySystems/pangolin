import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
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
