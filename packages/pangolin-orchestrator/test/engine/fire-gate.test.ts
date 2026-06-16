// packages/pangolin-orchestrator/test/engine/fire-gate.test.ts
import { describe, it, expect } from 'vitest';
import { tick } from '../../src/engine/tick.js';
import { SqliteRunStateStore } from '../../src/runstate/sqlite.js';
import { AuditLog } from '../../src/audit/audit-log.js';
import { NoneSigner } from '../../src/audit/signer.js';
import { LocalAnchor } from '../../src/audit/anchor.js';
import { NoneAuthorizer, createConfigAuthorizer } from '../../src/audit/authorizer.js';
import type {
  Executor,
  FireContext,
  ItemState,
  Run,
  RunStateStore,
  TerminalStatus,
} from '../../src/contracts/index.js';
import type { WorkItem } from '../../src/contracts/types.js';
import { PackRegistry } from '../../src/packs/registry.js';
import { makeShape } from '../support/make-shape.js';
import type { VerifyOutcome } from '@quarry-systems/pangolin-core';

// ── Recording executor ───────────────────────────────────────────────────────

type RecordingExecutor = Executor & {
  readonly firedIds: string[];
  readonly firedContexts: FireContext[];
};

function recordingExec(): RecordingExecutor {
  // Use class-style self-reference so properties are actually on the object.
  const self: RecordingExecutor = {
    id: 'rec',
    firedIds: [],
    firedContexts: [],
    async fire(item: WorkItem, ctx?: FireContext) {
      (self.firedIds as string[]).push(item.id);
      (self.firedContexts as FireContext[]).push(ctx ?? {});
      return { dispatchHash: `h-${item.id}` };
    },
    async reconcile(_hash: string) {
      return { status: 'done' as const };
    },
  };
  return self;
}

// ── Minimal in-memory RunStateStore with per-item actor support ──────────────

function makeMemStore(): RunStateStore {
  const items = new Map<string, ItemState>();
  const queues = new Map<string, number>();
  const locks = new Map<string, string>(); // lock-key → itemId

  return {
    ensureQueue(name: string, c: number) {
      queues.set(name, c);
    },
    saveRun(run: Run, actor?: string, submittedAt?: string) {
      for (const it of run.items) {
        items.set(it.id, {
          ...it,
          runId: run.id,
          queue: run.queue,
          status: 'pending',
          ...(actor !== undefined ? { actor } : {}),
          ...(submittedAt !== undefined ? { submittedAt } : {}),
        });
      }
    },
    markReady(ids: string[]) {
      for (const id of ids) {
        const it = items.get(id);
        if (it && it.status === 'pending') items.set(id, { ...it, status: 'ready' });
      }
    },
    setRunning(id: string, dispatchHash: string) {
      const it = items.get(id);
      if (it) items.set(id, { ...it, status: 'running', dispatchHash });
    },
    setStatus(id: string, status: TerminalStatus, reason?: string) {
      const it = items.get(id);
      if (it) items.set(id, { ...it, status, ...(reason !== undefined ? { reason } : {}) });
    },
    getItems(runId?: string): ItemState[] {
      const all = [...items.values()];
      return runId ? all.filter((i) => i.runId === runId) : all;
    },
    runningCount(queue: string): number {
      return [...items.values()].filter((i) => i.queue === queue && i.status === 'running').length;
    },
    queueConcurrency(queue: string): number {
      return queues.get(queue) ?? 0;
    },
    heldLockKeys(): string[] {
      return [...locks.keys()];
    },
    acquireLocks(itemId: string, keys: string[]): boolean {
      if (keys.length === 0) return true;
      if (keys.some((k) => locks.has(k))) return false;
      for (const k of keys) locks.set(k, itemId);
      return true;
    },
    releaseLocks(itemId: string): void {
      for (const [k, v] of locks) {
        if (v === itemId) locks.delete(k);
      }
    },
    getActor(id: string): string | undefined {
      return items.get(id)?.actor;
    },
    getAttempts(id: string): number {
      return items.get(id)?.attempts ?? 0;
    },
    bumpAttempt(id: string): void {
      const it = items.get(id);
      if (it) items.set(id, { ...it, attempts: (it.attempts ?? 0) + 1 });
    },
    requeue(id: string, notBeforeMs: number): void {
      const it = items.get(id);
      if (it) items.set(id, { ...it, status: 'ready', nextAttemptAt: notBeforeMs });
    },
    setResultRef(id: string, ref: string): void {
      const it = items.get(id);
      if (it) items.set(id, { ...it, resultRef: ref });
    },
    setVerify(id: string, verify: VerifyOutcome): void {
      const it = items.get(id);
      if (it) items.set(id, { ...it, verify });
    },
    setOutputRefs(id: string, outputRefs: Record<string, string>): void {
      const it = items.get(id);
      if (it) items.set(id, { ...it, outputRefs });
    },
    setManifestRef(id: string, ref: string): void {
      const it = items.get(id);
      if (it) items.set(id, { ...it, manifestRef: ref });
    },
    close() {
      /* no-op */
    },
  };
}

// ── Shared fixtures ──────────────────────────────────────────────────────────

// Shape used in all gate tests: write-impure (a non-trivial effectTier).
const shape = makeShape({ id: 'shape.write', effectTier: 'write-impure' });
const packs = new PackRegistry([shape]);

// Config authorizer: deny actor===agent:untrusted, allow everything else.
const authorizer = createConfigAuthorizer({
  principal: 'policy:test',
  policyRef: 'sha256:testpolicy',
  rules: [{ deny: { actor: 'agent:untrusted' }, reason: 'untrusted actors blocked' }],
});

/**
 * Build a run state store with two items having distinct per-item actors:
 *  - 'denied-item' actor='agent:untrusted'
 *  - 'allowed-item' actor='agent:trusted'
 * Both have subagentShape='shape.write' and start ready.
 */
function buildRun(): RunStateStore {
  const store = makeMemStore();
  store.ensureQueue('default', 10);

  // Each saveRun call sets the actor for that batch of items.
  store.saveRun(
    {
      id: 'gate-run',
      queue: 'default',
      items: [
        {
          id: 'denied-item',
          executor: 'rec',
          inputs: {},
          depends_on: [],
          resourceLocks: [],
          subagentShape: 'shape.write',
        },
      ],
    },
    'agent:untrusted',
  );
  store.saveRun(
    {
      id: 'gate-run',
      queue: 'default',
      items: [
        {
          id: 'allowed-item',
          executor: 'rec',
          inputs: {},
          depends_on: [],
          resourceLocks: [],
          subagentShape: 'shape.write',
        },
      ],
    },
    'agent:trusted',
  );

  store.markReady(['denied-item', 'allowed-item']);
  return store;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('fire-gate: authorization checked before ex.fire()', () => {
  it('denied item: status=denied, fire NOT called, item.denied audit emitted with verdict=deny', async () => {
    const store = buildRun();
    const exec = recordingExec();
    const auditStore = new SqliteRunStateStore();
    const auditLog = new AuditLog({
      store: auditStore,
      signer: NoneSigner,
      anchor: new LocalAnchor(auditStore),
    });

    await tick(store, { rec: exec }, 'default', packs, { authorizer, auditLog });

    // Denied item must have status=denied
    const deniedState = store.getItems('gate-run').find((i) => i.id === 'denied-item');
    expect(deniedState?.status).toBe('denied');

    // fire() must NOT have been called for the denied item
    expect(exec.firedIds).not.toContain('denied-item');

    // An item.denied audit entry must have been emitted with verdict=deny
    const entries = auditStore.getAuditEntries('gate-run');
    const deniedEntry = entries.find((e) => e.kind === 'item.denied' && e.itemId === 'denied-item');
    expect(deniedEntry).toBeDefined();
    expect(deniedEntry!.authorization?.verdict).toBe('deny');
    expect(deniedEntry!.authorization?.principal).toBe('policy:test');
    expect(deniedEntry!.authorization?.policyRef).toBe('sha256:testpolicy');

    auditStore.close();
  });

  it('allowed item: fire IS called, FireContext has authorization+effectClass, item.fired audit emitted', async () => {
    const store = buildRun();
    const exec = recordingExec();
    const auditStore = new SqliteRunStateStore();
    const auditLog = new AuditLog({
      store: auditStore,
      signer: NoneSigner,
      anchor: new LocalAnchor(auditStore),
    });

    await tick(store, { rec: exec }, 'default', packs, { authorizer, auditLog });

    // Allowed item must have been fired
    expect(exec.firedIds).toContain('allowed-item');

    // FireContext for allowed-item must carry authorization verdict + effectClass
    const ctxIdx = exec.firedIds.indexOf('allowed-item');
    const ctx = exec.firedContexts[ctxIdx];
    expect(ctx).toBeDefined();
    expect(ctx!.authorization?.verdict).toMatch(/^(allow|not-evaluated)$/);
    // effectClass MUST derive from shape.effectTier, never from item.inputs
    expect(ctx!.effectClass).toBe('write-impure');

    // An item.fired audit entry must be emitted
    const entries = auditStore.getAuditEntries('gate-run');
    const firedEntry = entries.find((e) => e.kind === 'item.fired' && e.itemId === 'allowed-item');
    expect(firedEntry).toBeDefined();

    auditStore.close();
  });

  it('NoneAuthorizer default (no authorizer in opts): both items fire normally — back-compat', async () => {
    const store = buildRun();
    const exec = recordingExec();

    // No authorizer passed → should default to NoneAuthorizer internally
    await tick(store, { rec: exec }, 'default', packs);

    // Both items must fire
    expect(exec.firedIds).toContain('denied-item');
    expect(exec.firedIds).toContain('allowed-item');

    // Both should be running (fired but not yet reconciled)
    const items = store.getItems('gate-run');
    for (const item of items) {
      expect(item.status).toBe('running');
    }
  });

  it('NoneAuthorizer injected explicitly: effectClass flows through FireContext as write-impure', async () => {
    const store = buildRun();
    const exec = recordingExec();

    await tick(store, { rec: exec }, 'default', packs, { authorizer: NoneAuthorizer });

    // Both items fire
    expect(exec.firedIds.length).toBe(2);

    // effectClass must be shape-derived: 'write-impure' (invariant: never from item.inputs)
    for (const ctx of exec.firedContexts) {
      expect(ctx.effectClass).toBe('write-impure');
    }
  });
});
