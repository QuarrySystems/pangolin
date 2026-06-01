import { RUN_STATUSES } from '../src/contracts/types.js';
import type { TerminalStatus } from '../src/contracts/types.js';
import { it, expect } from 'vitest';

it('admits cancelled as a terminal status', () => {
  expect(RUN_STATUSES).toContain('cancelled');
  const s: TerminalStatus = 'cancelled';
  expect(s).toBe('cancelled');
});
