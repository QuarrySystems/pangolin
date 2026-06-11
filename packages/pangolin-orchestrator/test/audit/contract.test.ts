import { describe, it, expect } from 'vitest';
import { GUARANTEE_RANK } from '../../src/contracts/index.js';
it('GUARANTEE_RANK licenses tamper-evident only at external-immutable+', () => {
  expect(GUARANTEE_RANK.detect).toBe(0);
  expect(GUARANTEE_RANK['external-immutable']).toBe(1);
  expect(GUARANTEE_RANK.witnessed).toBe(2);
});
