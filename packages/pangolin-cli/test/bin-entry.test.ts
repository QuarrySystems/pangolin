import { buildProgram } from '../src/index.js';
import { it, expect } from 'vitest';

it('buildProgram returns a commander program named "pangolin"', () => {
  const ctx = { getClient: async () => ({} as any) };
  const program = buildProgram(ctx);
  expect(program.name()).toBe('pangolin');
});
