import { it, expect } from 'vitest';
import { idKeyedExecutor, makeOrch, driveUntilDone } from './pattern-harness.js';

it('idKeyedExecutor drives a one-item run to the behavior-declared terminal status', async () => {
  const store = new (await import('../../src/runstate/sqlite.js')).SqliteRunStateStore();
  const { orch } = makeOrch(store, idKeyedExecutor(new Map(), () => ({ status: 'done', resultRef: 'agora://r' })));
  orch.submitRun({ id: 'r1', queue: 'default', items: [{ id: 'a', executor: 'dispatch', inputs: {}, depends_on: [], resourceLocks: [] }] }, 'human:test');
  await driveUntilDone(orch);
  expect(orch.getStatus('r1')[0]!.status).toBe('done');
  store.close();
});
