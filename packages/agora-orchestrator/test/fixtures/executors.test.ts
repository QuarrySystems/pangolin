import { describe, it, expect } from 'vitest';
import { immediateExecutor, failingExecutor, setupOneFiredItem } from './executors.js';

describe('test executor fixtures', () => {
  it('immediate reconciles done, failing reconciles failed', async () => {
    expect((await immediateExecutor().reconcile('h'))?.status).toBe('done');
    expect((await failingExecutor().reconcile('h'))?.status).toBe('failed');
  });

  it('setupOneFiredItem returns a store with item running and executors map keyed x', () => {
    const { store, executors } = setupOneFiredItem('a');
    const item = store.getItems().find((i) => i.id === 'a');
    expect(item?.status).toBe('running');
    expect(item?.dispatchHash).toBe('h');
    expect(executors).toHaveProperty('x');
    store.close();
  });
});
