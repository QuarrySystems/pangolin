import { resolveModelArg } from '../src/model-map.js';
import { it, expect } from 'vitest';

it('maps the three reserved levels to claude bare aliases', () => {
  expect(resolveModelArg('fast')).toBe('haiku');
  expect(resolveModelArg('standard')).toBe('sonnet');
  expect(resolveModelArg('max')).toBe('opus');
});

it('passes through non-level strings byte-identical', () => {
  expect(resolveModelArg('claude-opus-4-7')).toBe('claude-opus-4-7');
  expect(resolveModelArg('claude-3-opus')).toBe('claude-3-opus');
  expect(resolveModelArg('haiku')).toBe('haiku');
});

it('returns undefined when passed undefined', () => {
  expect(resolveModelArg(undefined)).toBeUndefined();
});

it('returns undefined when passed empty string', () => {
  expect(resolveModelArg('')).toBeUndefined();
});
