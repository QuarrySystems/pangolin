import { it, expect } from 'vitest';
import type { AppendChannel, ControlEnvelope } from '../src/contracts/submission-transport.js';
import type { Run } from '../src/contracts/types.js';

it("Run admits openEnded; ControlEnvelope admits 'close'; AppendChannel is structurally separate", () => {
  const r: Run = { id: 'r1', queue: 'default', items: [], openEnded: true };
  const c: ControlEnvelope = { kind: 'close', target: 'r1', actor: 'app:x', at: 'T' };
  const ok: (a: AppendChannel) => void = () => {}; // type only — AppendChannel exists
  expect([r.openEnded, c.kind, typeof ok]).toEqual([true, 'close', 'function']);
});
