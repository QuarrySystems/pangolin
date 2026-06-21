import { buildProgram, formatCliError } from '../src/index.js';
import { it, expect } from 'vitest';

it('buildProgram returns a commander program named "pangolin"', () => {
  const ctx = { getClient: async () => ({}) as never };
  const program = buildProgram(ctx);
  expect(program.name()).toBe('pangolin');
});

it('formatCliError returns the clean message (not a stack) when debug is off', () => {
  const out = formatCliError(new Error('unknown target "prod"'), false);
  expect(out).toBe('unknown target "prod"');
  expect(out).not.toContain('at '); // no stack frames leaked to the user
});

it('formatCliError returns the full stack when debug is on', () => {
  const out = formatCliError(new Error('boom'), true);
  expect(out).toContain('boom');
  expect(out).toContain('at '); // stack frames present for debugging
});

it('formatCliError stringifies a non-Error throw', () => {
  expect(formatCliError('plain string', false)).toBe('plain string');
});
