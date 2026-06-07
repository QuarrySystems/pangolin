import { it, expect } from 'vitest';
import type { DispatchWork, RuntimeExit, RuntimeUsage } from '../src/index.js';

it('DispatchWork accepts an optional model string', () => {
  const w: DispatchWork = { subagent: 's', target: 't', model: 'max' };
  expect(w.model).toBe('max');
});

it('RuntimeExit accepts an optional usage block typed as RuntimeUsage', () => {
  const usage: RuntimeUsage = { models: ['claude-opus-4-7'], costUsd: 0.05, turns: 3 };
  const exit: RuntimeExit = { exitCode: 0, stdout: '', stderr: '', usage };
  expect(exit.usage?.models).toEqual(['claude-opus-4-7']);
});
