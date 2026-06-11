import { detectNeedsInputSentinel } from '../src/sentinel-detector.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect, beforeEach, afterEach } from 'vitest';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'sentinel-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it('returns undefined when no sentinel exists', async () => {
  expect(await detectNeedsInputSentinel(dir)).toBeUndefined();
});

it('returns the absolute path when sentinel exists', async () => {
  await mkdir(join(dir, '.pangolin'), { recursive: true });
  await writeFile(join(dir, '.pangolin', 'needs_input.json'), '{}');
  const path = await detectNeedsInputSentinel(dir);
  expect(path).toBe(join(dir, '.pangolin', 'needs_input.json'));
});
