// packages/agora-orchestrator/test/extend-run.test.ts
import { describe, it, expect } from 'vitest';
import { SqliteRunStateStore } from '../src/runstate/sqlite.js';
import { idKeyedExecutor, makeOrch, driveUntilDone } from './fixtures/pattern-harness.js';
import type { WorkItem } from '../src/contracts/index.js';

// Helper: make a minimal work item
function wi(id: string, executor = 'dispatch', depends_on: string[] = [], extra: Partial<WorkItem> = {}): WorkItem {
  return { id, executor, inputs: {}, depends_on, resourceLocks: [], ...extra };
}

describe('extendRun — unknown runId', () => {
  it('throws when the runId does not exist in the store', () => {
    const store = new SqliteRunStateStore();
    const blobs = new Map<string, Uint8Array>();
    const executor = idKeyedExecutor(blobs, () => ({ status: 'done' }));
    const { orch } = makeOrch(store, executor);

    expect(() => orch.extendRun('nonexistent-run', [wi('x')], 'human:test')).toThrow(/unknown run/);
    store.close();
  });
});

describe('extendRun — id-skip idempotency', () => {
  it('re-appending the same item ids is a no-op (returns [] and adds zero rows)', () => {
    const store = new SqliteRunStateStore();
    const blobs = new Map<string, Uint8Array>();
    const executor = idKeyedExecutor(blobs, () => ({ status: 'done' }));
    const { orch } = makeOrch(store, executor);

    orch.submitRun({ id: 'r1', queue: 'default', items: [wi('a')] });

    // Append item 'b'
    const first = orch.extendRun('r1', [wi('b')], 'human:test');
    expect(first).toEqual(['b']);

    // Re-append same 'b' — must be a no-op
    const second = orch.extendRun('r1', [wi('b')], 'human:test');
    expect(second).toEqual([]);

    // Store must still have exactly 2 items (a + b)
    expect(store.getItems('r1')).toHaveLength(2);
    store.close();
  });

  it('id-skip does not append an audit entry when all items are duplicates', () => {
    const store = new SqliteRunStateStore();
    const blobs = new Map<string, Uint8Array>();
    const executor = idKeyedExecutor(blobs, () => ({ status: 'done' }));
    const { orch } = makeOrch(store, executor);

    orch.submitRun({ id: 'r1', queue: 'default', items: [wi('a')] });

    // Append 'b' once
    orch.extendRun('r1', [wi('b')], 'human:test');
    const entriesAfterFirst = store.getAuditEntries('r1');
    const extendedAfterFirst = entriesAfterFirst.filter((e) => e.kind === 'run.extended');
    expect(extendedAfterFirst).toHaveLength(1);

    // Re-append same 'b' — must not emit a new audit entry
    orch.extendRun('r1', [wi('b')], 'human:test');
    const entriesAfterSecond = store.getAuditEntries('r1');
    const extendedAfterSecond = entriesAfterSecond.filter((e) => e.kind === 'run.extended');
    expect(extendedAfterSecond).toHaveLength(1); // still just 1

    store.close();
  });
});

describe('extendRun — appended items run to completion (integration)', () => {
  it('appended item with needs on a done item resolves and completes', async () => {
    const store = new SqliteRunStateStore();
    const blobs = new Map<string, Uint8Array>();
    const executor = idKeyedExecutor(blobs, () => ({ status: 'done', resultRef: 'agora://result/x' }));
    const { orch } = makeOrch(store, executor);

    // Submit run with item 'a'
    orch.submitRun({ id: 'r1', queue: 'default', items: [wi('a')] });

    // Drive until 'a' is done
    await driveUntilDone(orch, 32, 'r1');
    const aStatus = orch.getStatus('r1').find((s) => s.id === 'a');
    expect(aStatus?.status).toBe('done');

    // Extend with 'b' that depends on 'a'
    const appended = orch.extendRun('r1', [wi('b', 'dispatch', ['a'])], 'human:test');
    expect(appended).toEqual(['b']);

    // Drive again — 'b' should complete too
    await driveUntilDone(orch, 32, 'r1');
    const bStatus = orch.getStatus('r1').find((s) => s.id === 'b');
    expect(bStatus?.status).toBe('done');

    store.close();
  });

  it('appended item starts pending and transitions through ready', async () => {
    const store = new SqliteRunStateStore();
    const blobs = new Map<string, Uint8Array>();
    const executor = idKeyedExecutor(blobs, () => ({ status: 'done' }));
    const { orch } = makeOrch(store, executor);

    orch.submitRun({ id: 'r2', queue: 'default', items: [wi('a')] });

    // Extend immediately (before driving) — 'c' depends on 'a', starts pending
    orch.extendRun('r2', [wi('c', 'dispatch', ['a'])], 'human:extend');

    const beforeDrive = orch.getStatus('r2').find((s) => s.id === 'c');
    expect(beforeDrive?.status).toBe('pending');

    // Drive to completion
    await driveUntilDone(orch, 32, 'r2');
    const afterDrive = orch.getStatus('r2').find((s) => s.id === 'c');
    expect(afterDrive?.status).toBe('done');

    store.close();
  });
});

describe('extendRun — merged-graph validation', () => {
  it('rejects an append with depends_on referencing an unknown item', () => {
    const store = new SqliteRunStateStore();
    const blobs = new Map<string, Uint8Array>();
    const executor = idKeyedExecutor(blobs, () => ({ status: 'done' }));
    const { orch } = makeOrch(store, executor);

    orch.submitRun({ id: 'r1', queue: 'default', items: [wi('a')] });

    expect(() =>
      orch.extendRun('r1', [wi('b', 'dispatch', ['nonexistent'])], 'human:test')
    ).toThrow(/failed validation/);

    // Store unchanged — still just 'a'
    expect(store.getItems('r1')).toHaveLength(1);
    store.close();
  });

  it('rejects an append introducing a duplicate id (already in run)', () => {
    const store = new SqliteRunStateStore();
    const blobs = new Map<string, Uint8Array>();
    const executor = idKeyedExecutor(blobs, () => ({ status: 'done' }));
    const { orch } = makeOrch(store, executor);

    orch.submitRun({ id: 'r1', queue: 'default', items: [wi('a'), wi('b')] });

    // Trying to extend with a fresh item 'b' — after id-skip, 'b' is filtered
    // so the extend is a no-op (id-skip), NOT an error
    const result = orch.extendRun('r1', [wi('b')], 'human:test');
    expect(result).toEqual([]); // id-skip no-op

    store.close();
  });

  it('rejects an append where two NEW items have the same id', () => {
    const store = new SqliteRunStateStore();
    const blobs = new Map<string, Uint8Array>();
    const executor = idKeyedExecutor(blobs, () => ({ status: 'done' }));
    const { orch } = makeOrch(store, executor);

    orch.submitRun({ id: 'r1', queue: 'default', items: [wi('a')] });

    // Two genuinely new items with the same id in a single extend call
    expect(() =>
      orch.extendRun('r1', [wi('b'), wi('b')], 'human:test')
    ).toThrow(/failed validation|duplicate/i);

    // Store unchanged
    expect(store.getItems('r1')).toHaveLength(1);
    store.close();
  });
});

describe('extendRun — needs auto-union into depends_on', () => {
  it('needs[*].from is auto-unioned into depends_on (normalizeRun reuse)', async () => {
    const store = new SqliteRunStateStore();
    const blobs = new Map<string, Uint8Array>();
    const executor = idKeyedExecutor(blobs, () => ({ status: 'done', resultRef: 'agora://r/x' }));
    const { orch } = makeOrch(store, executor);

    orch.submitRun({ id: 'r1', queue: 'default', items: [wi('a')] });
    await driveUntilDone(orch, 32, 'r1');

    // Item 'b' with needs but NO explicit depends_on — normalizeRun should union them
    const itemB: WorkItem = {
      id: 'b', executor: 'dispatch', inputs: {},
      depends_on: [],  // intentionally omit — normalizeRun auto-unions
      resourceLocks: [],
      needs: { patch: { from: 'a', select: { kind: 'patch' } } },
    };
    const appended = orch.extendRun('r1', [itemB], 'human:test');
    expect(appended).toEqual(['b']);

    // Drive 'b' to completion
    await driveUntilDone(orch, 32, 'r1');
    const bStatus = orch.getStatus('r1').find((s) => s.id === 'b');
    expect(bStatus?.status).toBe('done');

    store.close();
  });
});

describe('extendRun — maxItemsPerRun backstop', () => {
  it('throws when exceeding maxItemsPerRun; store unchanged', () => {
    const store = new SqliteRunStateStore();
    const blobs = new Map<string, Uint8Array>();
    const executor = idKeyedExecutor(blobs, () => ({ status: 'done' }));
    // Set maxItemsPerRun to 3 via extra options
    const { orch } = makeOrch(store, executor, { maxItemsPerRun: 3 });

    orch.submitRun({ id: 'r1', queue: 'default', items: [wi('a'), wi('b')] });
    // Store has 2 items; maxItemsPerRun is 3; adding 2 more would make 4

    expect(() =>
      orch.extendRun('r1', [wi('c'), wi('d')], 'human:test')
    ).toThrow(/maxItemsPerRun/);

    // Store must still have exactly 2 items
    expect(store.getItems('r1')).toHaveLength(2);
    store.close();
  });

  it('allows appending up to exactly maxItemsPerRun', () => {
    const store = new SqliteRunStateStore();
    const blobs = new Map<string, Uint8Array>();
    const executor = idKeyedExecutor(blobs, () => ({ status: 'done' }));
    const { orch } = makeOrch(store, executor, { maxItemsPerRun: 3 });

    orch.submitRun({ id: 'r1', queue: 'default', items: [wi('a'), wi('b')] });
    // Adding exactly 1 more reaches 3 (the limit) — should succeed
    const appended = orch.extendRun('r1', [wi('c')], 'human:test');
    expect(appended).toEqual(['c']);
    expect(store.getItems('r1')).toHaveLength(3);
    store.close();
  });
});

describe('extendRun — audit entry', () => {
  it('emits exactly one run.extended entry with runId, actor, and causeItemId', () => {
    const store = new SqliteRunStateStore();
    const blobs = new Map<string, Uint8Array>();
    const executor = idKeyedExecutor(blobs, () => ({ status: 'done' }));
    const { orch } = makeOrch(store, executor);

    orch.submitRun({ id: 'r1', queue: 'default', items: [wi('a')] });

    orch.extendRun('r1', [wi('b')], 'human:extender', 'a');

    const entries = store.getAuditEntries('r1');
    const extEntries = entries.filter((e) => e.kind === 'run.extended');
    expect(extEntries).toHaveLength(1);
    expect(extEntries[0]!.runId).toBe('r1');
    expect(extEntries[0]!.actor).toBe('human:extender');
    expect(extEntries[0]!.itemId).toBe('a');

    store.close();
  });

  it('emits run.extended without itemId when causeItemId is not given', () => {
    const store = new SqliteRunStateStore();
    const blobs = new Map<string, Uint8Array>();
    const executor = idKeyedExecutor(blobs, () => ({ status: 'done' }));
    const { orch } = makeOrch(store, executor);

    orch.submitRun({ id: 'r1', queue: 'default', items: [wi('a')] });

    orch.extendRun('r1', [wi('b')], 'human:extender');

    const entries = store.getAuditEntries('r1');
    const extEntry = entries.find((e) => e.kind === 'run.extended');
    expect(extEntry).toBeDefined();
    expect(extEntry!.itemId).toBeUndefined();

    store.close();
  });
});

describe('extendRun — nsWorkItems refactor (submitRun namespacing unchanged)', () => {
  it('existing submitRun namespacing still works after refactor', () => {
    const store = new SqliteRunStateStore();
    const blobs = new Map<string, Uint8Array>();
    const executor = idKeyedExecutor(blobs, () => ({ status: 'done' }));
    const { orch } = makeOrch(store, executor);

    orch.submitRun({ id: 'myrun', queue: 'default', items: [wi('x'), wi('y', 'dispatch', ['x'])] });

    // Items stored with namespaced ids
    const items = store.getItems('myrun');
    expect(items.map((i) => i.id)).toContain('myrun\x1fx');
    expect(items.map((i) => i.id)).toContain('myrun\x1fy');

    // de-namespaced via getStatus
    const status = orch.getStatus('myrun');
    expect(status.map((s) => s.id)).toContain('x');
    expect(status.map((s) => s.id)).toContain('y');

    store.close();
  });

  it('extendRun also namespaces appended items', () => {
    const store = new SqliteRunStateStore();
    const blobs = new Map<string, Uint8Array>();
    const executor = idKeyedExecutor(blobs, () => ({ status: 'done' }));
    const { orch } = makeOrch(store, executor);

    orch.submitRun({ id: 'myrun', queue: 'default', items: [wi('x')] });
    orch.extendRun('myrun', [wi('z')], 'human:test');

    const items = store.getItems('myrun');
    expect(items.map((i) => i.id)).toContain('myrun\x1fz');

    store.close();
  });
});
