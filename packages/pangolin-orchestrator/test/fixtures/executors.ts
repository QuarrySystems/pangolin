import { SqliteRunStateStore } from '../../src/runstate/sqlite.js';
import type { Executor, RunStateStore } from '../../src/contracts/index.js';

export const immediateExecutor = (): Executor => ({
  id: 'x',
  async fire() { return { dispatchHash: 'h' }; },
  async reconcile() { return { status: 'done' }; },
});

export const failingExecutor = (): Executor => ({
  id: 'x',
  async fire() { return { dispatchHash: 'h' }; },
  async reconcile() { return { status: 'failed' }; },
});

/**
 * A store with item `id` already `running` under executor 'x' (ready to reconcile).
 */
export function setupOneFiredItem(id: string): { store: RunStateStore; executors: Record<string, Executor> } {
  const store = new SqliteRunStateStore();
  store.ensureQueue('default', 1);
  store.saveRun({
    id: 'r',
    queue: 'default',
    items: [
      { id, executor: 'x', inputs: {}, depends_on: [], resourceLocks: [] },
    ],
  });
  store.markReady([id]);
  store.setRunning(id, 'h');
  return { store, executors: { x: failingExecutor() } };
}
