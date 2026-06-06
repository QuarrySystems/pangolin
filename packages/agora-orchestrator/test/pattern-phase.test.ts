// packages/agora-orchestrator/test/pattern-phase.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SqliteRunStateStore } from '../src/runstate/sqlite.js';
import { idKeyedExecutor, makeOrch, driveUntilDone } from './fixtures/pattern-harness.js';
import { AgoraOrchestrator } from '../src/orchestrator.js';
import { ManualTrigger } from '../src/triggers/manual.js';
import { AuditLog } from '../src/audit/audit-log.js';
import { NoneSigner } from '../src/audit/signer.js';
import { LocalAnchor } from '../src/audit/anchor.js';
import type { Pattern, SpawnDirective } from '../src/contracts/pattern.js';
import type { ItemState, WorkItem } from '../src/contracts/index.js';
import type { Run } from '../src/contracts/types.js';

/** Helper: build a minimal WorkItem */
function wi(id: string, depends_on: string[] = [], extra: Partial<WorkItem> = {}): WorkItem {
  return { id, executor: 'dispatch', inputs: {}, depends_on, resourceLocks: [], ...extra };
}

/**
 * Tracks de-namespace contract violations detected in fakePattern.onTaskDone.
 * Reset in beforeEach; asserted non-empty would indicate the pattern received namespaced ids.
 */
const deNsViolations: string[] = [];

/**
 * Fake pattern:
 *  - plan(): identity (passes the run through unchanged)
 *  - onTaskDone(): when item 'a' completes (done) and 'b' is not yet present → spawn 'b'
 *
 * De-namespace contract check: records a violation (instead of throwing, which would be
 * swallowed by the phase catch) if any id contains the U+001F namespace separator.
 */
const fakePattern: Pattern = {
  id: 'fake',
  plan(run: Run): Run { return run; },
  onTaskDone(item: ItemState, ctx: { runItems: ItemState[] }): SpawnDirective | null {
    // De-namespace contract: patterns must receive logical (de-namespaced) ids, never raw store ids.
    // Record violations rather than throwing (a throw would be swallowed by the phase catch).
    if (item.id.includes('\x1f')) deNsViolations.push(`item.id contains NS: ${item.id}`);
    for (const i of ctx.runItems) {
      if (i.id.includes('\x1f')) deNsViolations.push(`ctx.runItems[].id contains NS: ${i.id}`);
    }

    if (item.id !== 'a' || item.status !== 'done') return null;
    // Only spawn 'b' if it doesn't already exist in the run
    const hasB = ctx.runItems.some((i) => i.id === 'b');
    if (hasB) return null;
    return { items: [wi('b')] };
  },
};

/**
 * Fake pattern with a throwing plan (for submitRun plan-rejection tests).
 */
const throwingPlanPattern: Pattern = {
  id: 'throwing-plan',
  plan(_run: Run): Run { throw new Error('plan rejected: bad config'); },
  onTaskDone(_item: ItemState, _ctx: { runItems: ItemState[] }): SpawnDirective | null { return null; },
};

/**
 * Fake pattern with plan that TRANSFORMS the run (injects a dependency).
 */
const transformPlanPattern: Pattern = {
  id: 'transform-plan',
  plan(run: Run): Run {
    // Inject a 'prologue' item that 'a' depends on
    const prologue: WorkItem = wi('prologue');
    const transformedItems = [prologue, ...run.items.map((it) => ({
      ...it,
      depends_on: [...it.depends_on, 'prologue'],
    }))];
    return { ...run, items: transformedItems };
  },
  onTaskDone(_item: ItemState, _ctx: { runItems: ItemState[] }): SpawnDirective | null { return null; },
};

/**
 * Fake pattern whose spawn directives reference an unknown dep (fails validation).
 */
const badSpawnPattern: Pattern = {
  id: 'bad-spawn',
  plan(run: Run): Run { return run; },
  onTaskDone(item: ItemState, ctx: { runItems: ItemState[] }): SpawnDirective | null {
    if (item.id !== 'a' || item.status !== 'done') return null;
    const hasInvalid = ctx.runItems.some((i) => i.id === 'invalid-spawn');
    if (hasInvalid) return null;
    // Spawn an item that depends on a nonexistent item — validation must fail
    return { items: [wi('invalid-spawn', ['nonexistent-dep'])] };
  },
};

// ─── Test suite ───────────────────────────────────────────────────────────────

// Reset de-namespace violation log before each test so fakePattern checks start clean.
beforeEach(() => { deNsViolations.length = 0; });

describe('pattern-phase: QueueConfig pattern binding', () => {
  it('a queue with no pattern behaves identically to today (existing behavior unchanged)', async () => {
    const store = new SqliteRunStateStore();
    const blobs = new Map<string, Uint8Array>();
    const executor = idKeyedExecutor(blobs, () => ({ status: 'done' }));
    const { orch } = makeOrch(store, executor);

    // No pattern bound — standard 2-item run
    orch.submitRun({ id: 'r-nopat', queue: 'default', items: [wi('x'), wi('y', ['x'])] });
    await driveUntilDone(orch, 32, 'r-nopat');

    const statuses = orch.getStatus('r-nopat').map((s) => ({ id: s.id, status: s.status }));
    expect(statuses).toEqual(expect.arrayContaining([
      { id: 'x', status: 'done' },
      { id: 'y', status: 'done' },
    ]));
    store.close();
  });
});

describe('pattern-phase: plan() runs before validateRun in submitRun', () => {
  it('a throwing plan rejects submission; store stays clean (getItems empty)', () => {
    const store = new SqliteRunStateStore();
    const blobs = new Map<string, Uint8Array>();
    const executor = idKeyedExecutor(blobs, () => ({ status: 'done' }));
    const { orch } = makeOrch(store, executor, {
      queues: { default: { concurrency: 5, pattern: throwingPlanPattern } },
    });

    expect(() =>
      orch.submitRun({ id: 'r-throw', queue: 'default', items: [wi('a')] }),
    ).toThrow(/plan rejected/);

    // Store must remain clean
    expect(store.getItems('r-throw')).toHaveLength(0);
    store.close();
  });

  it('plan that transforms the run (injects prologue dep) persists the transformed graph', async () => {
    const store = new SqliteRunStateStore();
    const blobs = new Map<string, Uint8Array>();
    const executor = idKeyedExecutor(blobs, () => ({ status: 'done' }));
    const { orch } = makeOrch(store, executor, {
      queues: { default: { concurrency: 5, pattern: transformPlanPattern } },
    });

    // submit with 1 item — plan will inject 'prologue' and make 'a' depend on it
    orch.submitRun({ id: 'r-transform', queue: 'default', items: [wi('a')] });

    // Store should have BOTH prologue and a
    const items = store.getItems('r-transform');
    const logicalIds = items.map((i) => i.id.split('\x1f')[1]);
    expect(logicalIds).toContain('prologue');
    expect(logicalIds).toContain('a');

    // Drive to completion — both should be done
    await driveUntilDone(orch, 32, 'r-transform');
    const statuses = orch.getStatus('r-transform').map((s) => s.status);
    expect(statuses.every((s) => s === 'done')).toBe(true);
    store.close();
  });
});

describe('pattern-phase: seal ordering (spawning in tick N delays seal to tick N+K)', () => {
  it('a run that spawns in the completing tick does NOT seal that tick, and seals after spawned work finishes', async () => {
    const store = new SqliteRunStateStore();
    const blobs = new Map<string, Uint8Array>();
    const executor = idKeyedExecutor(blobs, () => ({ status: 'done' }));
    const { orch } = makeOrch(store, executor, {
      queues: { default: { concurrency: 5, pattern: fakePattern } },
    });

    orch.submitRun({ id: 'r-seal', queue: 'default', items: [wi('a')] });

    // Drive until item 'a' is done
    let ticksUntilADone = 0;
    for (let i = 0; i < 32; i++) {
      await orch.tick('default');
      ticksUntilADone++;
      const aStatus = orch.getStatus('r-seal').find((s) => s.id === 'a');
      if (aStatus?.status === 'done') break;
    }

    // At this point 'a' is done. The pattern phase ran in the SAME tick that completed 'a',
    // spawning 'b'. The seal block runs AFTER the pattern phase, so 'b' is pending → no seal.
    const exportAfterADone = orch.getAuditExport('r-seal');
    expect(exportAfterADone.root).toBeUndefined(); // NOT sealed yet

    // Also verify 'b' was spawned
    const bStatus = orch.getStatus('r-seal').find((s) => s.id === 'b');
    expect(bStatus).toBeDefined();

    // Now drive until done (b completes)
    await driveUntilDone(orch, 32, 'r-seal');

    // Now the run should be sealed
    const finalExport = orch.getAuditExport('r-seal');
    expect(finalExport.root).toBeDefined();

    // Both items must be done
    const finalStatuses = orch.getStatus('r-seal').map((s) => ({ id: s.id, status: s.status }));
    expect(finalStatuses).toEqual(expect.arrayContaining([
      { id: 'a', status: 'done' },
      { id: 'b', status: 'done' },
    ]));

    // De-namespace contract: fakePattern must have received only logical (non-namespaced) ids.
    expect(deNsViolations).toHaveLength(0);
    store.close();
  });
});

describe('pattern-phase: crash-replay / restart idempotency', () => {
  it('constructing a second orchestrator over the same store and ticking → no duplicate spawned items', async () => {
    const store = new SqliteRunStateStore();
    const blobs = new Map<string, Uint8Array>();
    const executor = idKeyedExecutor(blobs, () => ({ status: 'done' }));

    // First orchestrator: submit + drive until 'a' is done
    const { orch: orch1 } = makeOrch(store, executor, {
      queues: { default: { concurrency: 5, pattern: fakePattern } },
    });

    orch1.submitRun({ id: 'r-replay', queue: 'default', items: [wi('a')] });

    // Drive until 'a' is done (this also triggers the pattern phase + spawns 'b')
    for (let i = 0; i < 32; i++) {
      await orch1.tick('default');
      const aStatus = orch1.getStatus('r-replay').find((s) => s.id === 'a');
      if (aStatus?.status === 'done') break;
    }

    // Verify 'b' was spawned
    const itemsAfterA = store.getItems('r-replay');
    const logicalIdsAfterA = itemsAfterA.map((i) => i.id.split('\x1f')[1]);
    expect(logicalIdsAfterA).toContain('b');
    const countAfterA = itemsAfterA.length;

    // Simulate restart: create a SECOND orchestrator over the same store (same executor instance ok)
    const { orch: orch2 } = makeOrch(store, executor, {
      queues: { default: { concurrency: 5, pattern: fakePattern } },
    });

    // Tick the second orchestrator — the pattern phase re-scans; id-skip prevents duplicates
    await orch2.tick('default');
    await orch2.tick('default');

    // Item count must not have grown (b is still the only spawned item)
    const itemsAfterRestart = store.getItems('r-replay');
    expect(itemsAfterRestart).toHaveLength(countAfterA); // no duplicates

    // Drive to completion on second orchestrator
    await driveUntilDone(orch2, 32, 'r-replay');

    const finalExport = orch2.getAuditExport('r-replay');
    expect(finalExport.root).toBeDefined();
    expect(orch2.getStatus('r-replay').every((s) => s.status === 'done')).toBe(true);

    // De-namespace contract: fakePattern must have received only logical (non-namespaced) ids.
    expect(deNsViolations).toHaveLength(0);
    store.close();
  });
});

describe('pattern-phase: without auditLog', () => {
  it('spawns still apply and settled runs re-scan harmlessly when auditLog is absent', async () => {
    const store = new SqliteRunStateStore();
    const blobs = new Map<string, Uint8Array>();
    const executor = idKeyedExecutor(blobs, () => ({ status: 'done' }));

    // Build orchestrator WITHOUT audit log
    const orch = new AgoraOrchestrator({
      store,
      executors: { dispatch: executor },
      triggers: { manual: new ManualTrigger() },
      queues: { default: { concurrency: 5, pattern: fakePattern } },
      // no auditLog
    });

    orch.submitRun({ id: 'r-noaudit', queue: 'default', items: [wi('a')] });
    await driveUntilDone(orch, 32, 'r-noaudit');

    // Both 'a' and 'b' should be done (pattern still fires even without audit)
    const statuses = orch.getStatus('r-noaudit').map((s) => ({ id: s.id, status: s.status }));
    expect(statuses).toEqual(expect.arrayContaining([
      { id: 'a', status: 'done' },
      { id: 'b', status: 'done' },
    ]));

    // Ticking again (after both done) must not throw or spawn duplicates
    await orch.tick('default');
    await orch.tick('default');
    const afterExtraItems = orch.getStatus('r-noaudit');
    expect(afterExtraItems).toHaveLength(2); // still exactly a + b

    // De-namespace contract: fakePattern must have received only logical (non-namespaced) ids.
    expect(deNsViolations).toHaveLength(0);
    store.close();
  });
});

describe('pattern-phase: bad spawn does not abort tick; other runs advance', () => {
  it('a pattern whose spawn fails validation does not abort the tick; other runs still advance; failure is emitted to stderr', async () => {
    const store = new SqliteRunStateStore();
    const blobs = new Map<string, Uint8Array>();
    const executor = idKeyedExecutor(blobs, () => ({ status: 'done' }));
    const { orch } = makeOrch(store, executor, {
      queues: { default: { concurrency: 5, pattern: badSpawnPattern } },
    });

    // Spy on process.stderr.write to capture diagnostic messages from the phase catch block.
    const stderrMessages: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrMessages.push(String(chunk));
      return true;
    });

    try {
      // Two runs: run-bad has the bad spawn pattern trigger; run-good is a simple run
      orch.submitRun({ id: 'run-bad', queue: 'default', items: [wi('a')] });
      orch.submitRun({ id: 'run-good', queue: 'default', items: [wi('x'), wi('y', ['x'])] });

      // Drive until done — run-good should complete even if run-bad's spawn fails
      await driveUntilDone(orch, 32, 'run-good');

      const goodStatuses = orch.getStatus('run-good').map((s) => s.status);
      expect(goodStatuses.every((s) => s === 'done')).toBe(true);

      // The failed spawn for run-bad must have emitted a diagnostic — distinguishing
      // "spawn rejected silently" from "spawn applied".
      const spawnFailureMsg = stderrMessages.find((m) => m.includes('[agora] pattern spawn failed') && m.includes('run-bad'));
      expect(spawnFailureMsg).toBeDefined();
    } finally {
      stderrSpy.mockRestore();
    }

    store.close();
  });
});

describe('pattern-phase: spawned item actor is pattern:default in audit export', () => {
  it('spawned item carries actor "pattern:default" in getAuditExport().items', async () => {
    const store = new SqliteRunStateStore();
    const blobs = new Map<string, Uint8Array>();
    const executor = idKeyedExecutor(blobs, () => ({ status: 'done' }));
    const { orch } = makeOrch(store, executor, {
      queues: { default: { concurrency: 5, pattern: fakePattern } },
    });

    orch.submitRun({ id: 'r-actor', queue: 'default', items: [wi('a')] });
    await driveUntilDone(orch, 32, 'r-actor');

    const exportData = orch.getAuditExport('r-actor');
    const bItem = exportData.items.find((i) => i.id === 'b');
    expect(bItem).toBeDefined();
    expect(bItem?.actor).toBe('pattern:default');

    // De-namespace contract: fakePattern must have received only logical (non-namespaced) ids.
    expect(deNsViolations).toHaveLength(0);
    store.close();
  });
});
