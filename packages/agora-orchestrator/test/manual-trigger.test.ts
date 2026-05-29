import { describe, it, expect } from 'vitest';
import { ManualTrigger } from '../src/triggers/manual.js';
import type { Run } from '../src/contracts/index.js';

const run: Run = { id: 'r', queue: 'default', items: [
  { id: 'a', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: [] },
  { id: 'b', executor: 'fake', inputs: {}, depends_on: ['a'], resourceLocks: [] },
] };

describe('ManualTrigger', () => {
  it('readies only root items on submit', () => {
    expect(new ManualTrigger().initialReady(run)).toEqual(['a']);
  });
});
