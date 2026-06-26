// packages/pangolin-orchestrator/test/orchestrator-extend-close.test.ts
import { describe, it, expect } from 'vitest';
import { SqliteRunStateStore } from '../src/runstate/sqlite.js';
import { idKeyedExecutor, makeOrch, driveUntilDone } from './fixtures/pattern-harness.js';
import type { WorkItem } from '../src/contracts/index.js';

// Helper: make a minimal work item
function wi(id: string, depends_on: string[] = []): WorkItem {
  return { id, executor: 'dispatch', inputs: {}, depends_on, resourceLocks: [] };
}

describe('openEnded seal-gate — back-compat: normal run seals at all-terminal', () => {
  it('a NORMAL run still seals at all-terminal (back-compat, no close needed)', async () => {
    const store = new SqliteRunStateStore();
    const blobs = new Map<string, Uint8Array>();
    const executor = idKeyedExecutor(blobs, () => ({ status: 'done' }));
    const { orch } = makeOrch(store, executor);

    const runId = await orch.submitRun({
      id: 'normal-run',
      queue: 'default',
      items: [wi('a')],
      // no openEnded — normal behavior
    });

    // Drive items to done
    await driveUntilDone(orch, 32, runId);

    // A final tick to trigger the seal block
    await orch.tick('default');

    // Seal must have fired: getAuditRoot must be defined
    const exp = orch.getAuditExport(runId);
    expect(exp.root).toBeDefined();

    store.close();
  });
});

describe('openEnded seal-gate — openEnded run waits for closeRun', () => {
  it('an openEnded run does NOT seal until closed, then seals on the next tick', async () => {
    const store = new SqliteRunStateStore();
    const blobs = new Map<string, Uint8Array>();
    const executor = idKeyedExecutor(blobs, () => ({ status: 'done' }));
    const { orch } = makeOrch(store, executor);

    const runId = await orch.submitRun({
      id: 'open-run',
      queue: 'default',
      items: [wi('a')],
      openEnded: true,
    });

    // Drive items to terminal
    await driveUntilDone(orch, 32, runId);

    // Tick again — items are terminal, but run is openEnded and not closed yet
    // Seal must NOT have fired
    await orch.tick('default');
    const expBefore = orch.getAuditExport(runId);
    expect(expBefore.root).toBeUndefined();

    // Now close the run
    orch.closeRun(runId, 'human:brett');

    // Verify a run.closed audit entry was emitted
    const entriesAfterClose = store.getAuditEntries(runId);
    const closedEntries = entriesAfterClose.filter((e) => e.kind === 'run.closed');
    expect(closedEntries).toHaveLength(1);
    expect(closedEntries[0]!.runId).toBe(runId);

    // Next tick: seal must now fire (items terminal + closed)
    await orch.tick('default');
    const expAfter = orch.getAuditExport(runId);
    expect(expAfter.root).toBeDefined();

    // Audit entries include both run.closed and run.completed
    const entriesAfterSeal = store.getAuditEntries(runId);
    const kinds = entriesAfterSeal.map((e) => e.kind);
    expect(kinds).toContain('run.closed');
    expect(kinds).toContain('run.completed');

    store.close();
  });
});

describe('producerExtend — guarded producer push', () => {
  it('producerExtend throws on a closed run; extendRun (the spawn path) still appends to one', async () => {
    const store = new SqliteRunStateStore();
    const blobs = new Map<string, Uint8Array>();
    const executor = idKeyedExecutor(blobs, () => ({ status: 'done' }));
    const { orch } = makeOrch(store, executor);

    const runId = await orch.submitRun({
      id: 'close-guard-run',
      queue: 'default',
      items: [wi('a')],
      openEnded: true,
    });

    // Close the run
    orch.closeRun(runId, 'human:brett');

    // producerExtend must throw on a closed run
    expect(() => orch.producerExtend(runId, [wi('b')], 'human:producer')).toThrow(/closed/);

    // extendRun (the internal spawn path) must NOT throw — it stays unguarded
    expect(() => orch.extendRun(runId, [wi('b')], 'pattern:default')).not.toThrow();

    // The item was actually appended via extendRun
    const items = orch.getStatus(runId);
    expect(items.some((i) => i.id === 'b')).toBe(true);

    store.close();
  });

  it('producerExtend on an unknown run throws (via extendRun)', async () => {
    const store = new SqliteRunStateStore();
    const blobs = new Map<string, Uint8Array>();
    const executor = idKeyedExecutor(blobs, () => ({ status: 'done' }));
    const { orch } = makeOrch(store, executor);

    // producerExtend delegates to extendRun which throws on unknown run
    expect(() => orch.producerExtend('nonexistent', [wi('x')], 'human:producer')).toThrow(
      /unknown run/,
    );

    store.close();
  });

  it('producerExtend on an open run delegates and appends items', async () => {
    const store = new SqliteRunStateStore();
    const blobs = new Map<string, Uint8Array>();
    const executor = idKeyedExecutor(blobs, () => ({ status: 'done' }));
    const { orch } = makeOrch(store, executor);

    const runId = await orch.submitRun({
      id: 'open-extend-run',
      queue: 'default',
      items: [wi('a')],
      openEnded: true,
    });

    // producerExtend on an open (not closed) run must succeed
    const appended = orch.producerExtend(runId, [wi('b')], 'human:producer');
    expect(appended).toEqual(['b']);

    // Verify item was added
    const items = orch.getStatus(runId);
    expect(items.some((i) => i.id === 'b')).toBe(true);

    store.close();
  });
});

describe('closeRun', () => {
  it('closeRun on an unknown run throws', () => {
    const store = new SqliteRunStateStore();
    const blobs = new Map<string, Uint8Array>();
    const executor = idKeyedExecutor(blobs, () => ({ status: 'done' }));
    const { orch } = makeOrch(store, executor);

    expect(() => orch.closeRun('nonexistent', 'human:brett')).toThrow(/unknown run/);

    store.close();
  });

  it('closeRun is idempotent on a known run', async () => {
    const store = new SqliteRunStateStore();
    const blobs = new Map<string, Uint8Array>();
    const executor = idKeyedExecutor(blobs, () => ({ status: 'done' }));
    const { orch } = makeOrch(store, executor);

    const runId = await orch.submitRun({
      id: 'idempotent-close-run',
      queue: 'default',
      items: [wi('a')],
    });

    // Close twice — must not throw
    orch.closeRun(runId, 'human:brett');
    expect(() => orch.closeRun(runId, 'human:brett')).not.toThrow();

    // Second close must NOT emit a duplicate run.closed audit entry
    expect(store.getAuditEntries(runId).filter((e) => e.kind === 'run.closed')).toHaveLength(1);

    store.close();
  });

  it('closeRun emits a run.closed audit entry', async () => {
    const store = new SqliteRunStateStore();
    const blobs = new Map<string, Uint8Array>();
    const executor = idKeyedExecutor(blobs, () => ({ status: 'done' }));
    const { orch } = makeOrch(store, executor);

    const runId = await orch.submitRun({
      id: 'audit-close-run',
      queue: 'default',
      items: [wi('a')],
    });

    orch.closeRun(runId, 'human:operator');

    const entries = store.getAuditEntries(runId);
    const closedEntry = entries.find((e) => e.kind === 'run.closed');
    expect(closedEntry).toBeDefined();
    expect(closedEntry!.runId).toBe(runId);
    expect(closedEntry!.actor).toBe('human:operator');

    store.close();
  });
});
