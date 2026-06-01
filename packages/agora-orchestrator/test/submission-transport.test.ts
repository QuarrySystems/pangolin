import { describe, it, expect } from 'vitest';
import { OUTBOX_KINDS } from '../src/contracts/submission-transport.js';
import type { ControlChannel, ControlEnvelope } from '../src/contracts/submission-transport.js';
describe('submission transport contract', () => {
  it('enumerates exactly the status, completed, and audit outbox kinds', () => {
    expect([...OUTBOX_KINDS]).toEqual(['status', 'completed', 'audit']);
  });

  it('ControlEnvelope and ControlChannel types compile and have expected shape', () => {
    // Compile-time check: construct a valid ControlEnvelope
    const env: ControlEnvelope = {
      kind: 'cancel',
      target: 'run-123',
      actor: 'human:brett',
      at: '2026-05-31T00:00:00.000Z',
    };
    expect(env.kind).toBe('cancel');
    expect(env.target).toBe('run-123');
    expect(env.actor).toBe('human:brett');
    expect(env.at).toBe('2026-05-31T00:00:00.000Z');

    // Compile-time check: ControlChannel is assignable from an object literal
    const _cc: ControlChannel = {
      control: async (_e: ControlEnvelope) => { void _e; },
      pollControl: async () => [],
      ackControl: async (_t: string) => { void _t; },
    };
    expect(typeof _cc.control).toBe('function');
    expect(typeof _cc.pollControl).toBe('function');
    expect(typeof _cc.ackControl).toBe('function');
  });
});
