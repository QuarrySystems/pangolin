import {
  getNeedsInputHelperOverlay,
  isHelperDisabled,
} from '../src/needs-input-helper.js';
import { it, expect } from 'vitest';
import { access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_PATH = '.claude/skills/pangolin-needs-input/SKILL.md';
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

it('overlay returns a SKILL.md at the conventional path', async () => {
  const overlay = await getNeedsInputHelperOverlay();
  expect(Object.keys(overlay)).toContain(SKILL_PATH);
});

it('overlay value is non-empty bytes for the SKILL.md asset', async () => {
  const overlay = await getNeedsInputHelperOverlay();
  const bytes = overlay[SKILL_PATH];
  expect(bytes).toBeInstanceOf(Uint8Array);
  expect(bytes.byteLength).toBeGreaterThan(0);
});

it('SKILL.md body mentions sentinel path, shape, and 1 MiB cap', async () => {
  const overlay = await getNeedsInputHelperOverlay();
  const text = Buffer.from(overlay[SKILL_PATH]).toString('utf8');
  expect(text).toContain('/workspace/.pangolin/needs_input.json');
  expect(text).toContain('question');
  expect(text).toContain('options');
  expect(text).toContain('context');
  expect(text).toContain('partial_state');
  expect(text).toContain('1 MiB');
});

it('isHelperDisabled honors PANGOLIN_DISABLE_NEEDS_INPUT_HELPER=true', () => {
  expect(isHelperDisabled({ PANGOLIN_DISABLE_NEEDS_INPUT_HELPER: 'true' })).toBe(
    true,
  );
});

it('isHelperDisabled returns false when env var is unset', () => {
  expect(isHelperDisabled({})).toBe(false);
});

it('isHelperDisabled returns false for non-"true" values', () => {
  expect(isHelperDisabled({ PANGOLIN_DISABLE_NEEDS_INPUT_HELPER: '1' })).toBe(
    false,
  );
  expect(isHelperDisabled({ PANGOLIN_DISABLE_NEEDS_INPUT_HELPER: 'TRUE' })).toBe(
    false,
  );
  expect(isHelperDisabled({ PANGOLIN_DISABLE_NEEDS_INPUT_HELPER: 'false' })).toBe(
    false,
  );
});

// Regression test for DAG 2 follow-up: the build must copy `src/assets/` to
// `dist/assets/` so that `getNeedsInputHelperOverlay()` can resolve its asset
// at runtime in a published-package context (where __dirname points at
// `dist/`, not `src/`). Without the asset-copy build step this file is
// missing and the overlay helper throws ENOENT in consumers.
it('dist/assets/needs-input-helper-skill.md exists after build', async () => {
  const distAsset = join(
    PKG_ROOT,
    'dist',
    'assets',
    'needs-input-helper-skill.md',
  );
  await expect(access(distAsset)).resolves.toBeUndefined();
});
