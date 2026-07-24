import { it, expect } from 'vitest';

import type { DispatchWork } from '../src/dispatch.js';

// NOTE: this file is NOT type-checked. pangolin-core's tsconfig `include` is
// ["src/**/*"], and vitest/esbuild strips types without excess-property
// checking — so a type-only assertion here passes against `main` whether or
// not the fields exist (it does NOT gate the contract). The binding gate for
// these fields is the DOWNSTREAM `pangolin-core typecheck` PLUS the client
// tasks that READ these fields in `pangolin-client/src/` (which IS
// type-checked). This test documents intended usage and locks the runtime
// shape, not the types.

it('a DispatchWork carrying the new fields round-trips at runtime', () => {
  const w: DispatchWork = {
    subagent: 'demo',
    target: 'local',
    callback: { url: 'https://ingress.example', bearerRef: 'secretref://bearer' },
    dedupeOnDispatchId: true,
  };

  expect(w.callback?.bearerRef).toBe('secretref://bearer');
  expect(w.dedupeOnDispatchId).toBe(true);
});

it('a DispatchWork without the new fields still round-trips (both optional)', () => {
  const w: DispatchWork = {
    subagent: 'demo',
    target: 'local',
    callback: { url: 'https://ingress.example' },
  };

  expect(w.callback?.bearerRef).toBeUndefined();
  expect(w.dedupeOnDispatchId).toBeUndefined();
});
