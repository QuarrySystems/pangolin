// tick's wiring of reconcile's `deps` into the run-state store
// (task-tick-store-deps).
//
// Every assertion about an ABSENT setDeps call is paired with a sibling
// observation from the same tick — setVerify having been called, or a status
// transition having happened. Without that, "zero setDeps calls" is equally
// consistent with a tick that never ran, which is the failure mode these tests
// exist to exclude.

import { describe, it, expect } from 'vitest';
import { tick } from '../../src/engine/tick.js';
import { SqliteRunStateStore } from '../../src/runstate/sqlite.js';
import type { Executor, ExecutionResult } from '../../src/contracts/index.js';
import type { WorkItem } from '../../src/contracts/types.js';
import type { DepsEvidence } from '@quarry-systems/pangolin-core';

const DEPS: DepsEvidence = { atSetup: 'sha256:aa', atFinish: 'sha256:bb', tier: 'recorded' };
const VERIFY = { passed: true } as const;

/** Executor that fires, then returns a fixed reconcile result. */
function execReturning(result: ExecutionResult): Executor {
  return {
    id: 'rec',
    async fire(item: WorkItem) {
      return { dispatchHash: `h-${item.id}` };
    },
    async reconcile() {
      return result;
    },
  };
}

/** Wrap a real SQLite store, recording setDeps/setVerify calls. Real store
 *  rather than a hand-rolled fake so the persistence path under test is the
 *  production one. */
function recordingStore() {
  const store = new SqliteRunStateStore();
  const setDepsCalls: Array<[string, DepsEvidence]> = [];
  const setVerifyCalls: string[] = [];
  const realSetDeps = store.setDeps.bind(store);
  const realSetVerify = store.setVerify.bind(store);
  store.setDeps = (id, deps) => {
    setDepsCalls.push([id, deps]);
    realSetDeps(id, deps);
  };
  store.setVerify = (id, verify) => {
    setVerifyCalls.push(id);
    realSetVerify(id, verify);
  };
  return { store, setDepsCalls, setVerifyCalls };
}

async function runOneItem(result: ExecutionResult) {
  const { store, setDepsCalls, setVerifyCalls } = recordingStore();
  store.ensureQueue('default', 1);
  store.saveRun({
    id: 'r',
    queue: 'default',
    items: [{ id: 'a', executor: 'rec', inputs: {}, depends_on: [], resourceLocks: [] }],
  });
  const executors = { rec: execReturning(result) };
  // Two ticks: the first fires the item, the second reconciles it.
  await tick(store, executors, 'default');
  await tick(store, executors, 'default');
  const item = store.getItems().find((i) => i.id === 'a');
  store.close();
  return { setDepsCalls, setVerifyCalls, item };
}

describe('tick stores deps from reconcile', () => {
  it('a done reconcile with deps produces exactly one setDeps carrying that object', async () => {
    const { setDepsCalls, setVerifyCalls, item } = await runOneItem({
      status: 'done',
      verify: VERIFY,
      deps: DEPS,
    });
    // Sibling control: setVerify ran in the same tick, so the branch executed.
    expect(setVerifyCalls).toEqual(['a']);
    expect(setDepsCalls).toHaveLength(1);
    expect(setDepsCalls[0]![1]).toEqual(DEPS);
    expect(item?.deps).toEqual(DEPS);
  });

  it('a done reconcile with no deps produces zero setDeps while setVerify still runs', async () => {
    const { setDepsCalls, setVerifyCalls, item } = await runOneItem({
      status: 'done',
      verify: VERIFY,
    });
    expect(setVerifyCalls).toEqual(['a']); // control: the done branch ran
    expect(setDepsCalls).toHaveLength(0);
    expect(item?.deps).toBeUndefined();
  });

  it('a FAILED reconcile carrying deps produces zero setDeps, and the item still transitioned', async () => {
    const { setDepsCalls, item } = await runOneItem({
      status: 'failed',
      verify: VERIFY,
      deps: DEPS,
    });
    // Control: a terminal transition did occur, so the absence below is a real
    // guard rather than a tick that never reconciled.
    expect(item?.status).toBe('failed');
    expect(setDepsCalls).toHaveLength(0);
    expect(item?.deps).toBeUndefined();
  });
});
