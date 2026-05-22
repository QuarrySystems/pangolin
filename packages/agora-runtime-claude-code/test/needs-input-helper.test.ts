import {
  getNeedsInputHelperOverlay,
  isHelperDisabled,
} from '../src/needs-input-helper.js';
import { it, expect } from 'vitest';

const SKILL_PATH = '.claude/skills/agora-needs-input/SKILL.md';

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
  expect(text).toContain('/workspace/.agora/needs_input.json');
  expect(text).toContain('question');
  expect(text).toContain('options');
  expect(text).toContain('context');
  expect(text).toContain('partial_state');
  expect(text).toContain('1 MiB');
});

it('isHelperDisabled honors AGORA_DISABLE_NEEDS_INPUT_HELPER=true', () => {
  expect(isHelperDisabled({ AGORA_DISABLE_NEEDS_INPUT_HELPER: 'true' })).toBe(
    true,
  );
});

it('isHelperDisabled returns false when env var is unset', () => {
  expect(isHelperDisabled({})).toBe(false);
});

it('isHelperDisabled returns false for non-"true" values', () => {
  expect(isHelperDisabled({ AGORA_DISABLE_NEEDS_INPUT_HELPER: '1' })).toBe(
    false,
  );
  expect(isHelperDisabled({ AGORA_DISABLE_NEEDS_INPUT_HELPER: 'TRUE' })).toBe(
    false,
  );
  expect(isHelperDisabled({ AGORA_DISABLE_NEEDS_INPUT_HELPER: 'false' })).toBe(
    false,
  );
});
