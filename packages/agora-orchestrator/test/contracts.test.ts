import { describe, it, expect } from 'vitest';
import { RUN_STATUSES } from '../src/contracts/index.js';
import type { WorkItem } from '../src/contracts/index.js';

describe('contracts', () => {
  it('RUN_STATUSES covers the six lifecycle states', () => {
    expect([...RUN_STATUSES]).toEqual(['pending', 'ready', 'running', 'done', 'failed', 'skipped']);
  });
  it('WorkItem shape compiles', () => {
    const w: WorkItem = { id: 'a', executor: 'fake', inputs: {}, depends_on: [], resourceLocks: [] };
    expect(w.id).toBe('a');
  });
});
