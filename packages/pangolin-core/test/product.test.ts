import { it, expect } from 'vitest';
// Imports the BARREL deliberately — the assertion is that the re-export lands.
// Sibling core tests import specific modules (`../src/audit.js`); this one is
// the exception on purpose.
import { MAX_OUTPUT_ENTRIES } from '../src/index.js';

it('exports MAX_OUTPUT_ENTRIES from the barrel at the worker-side value 256', () => {
  expect(MAX_OUTPUT_ENTRIES).toBe(256);
});
