import { describe, it, expect } from 'vitest';
import { OUTBOX_KINDS } from '../src/contracts/submission-transport.js';
describe('submission transport contract', () => {
  it('enumerates exactly the status and completed outbox kinds', () => {
    expect([...OUTBOX_KINDS]).toEqual(['status', 'completed']);
  });
});
