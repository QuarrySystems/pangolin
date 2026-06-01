// packages/agora-orchestrator/src/orchestrator.ts
import type { Executor, ItemState, Run, RunStateStore, Trigger } from './contracts/index.js';
import type { PackRegistry } from './packs/registry.js';
import type { AuditLog } from './audit/audit-log.js';
import { tick } from './engine/tick.js';

/** Namespace separator — U+001F UNIT SEPARATOR (not a valid item-id char in practice). */
const NS = '\x1f';
/** Produce a store-internal namespaced id: `${runId}\x1f${id}`. */
const ns = (runId: string, id: string) => `${runId}${NS}${id}`;
/** Strip the runId prefix from a namespaced id; pass-through if no separator found. */
const deNs = (id: string) => { const i = id.indexOf(NS); return i < 0 ? id : id.slice(i + 1); };

export interface QueueConfig { concurrency: number; }
export interface AgoraOrchestratorOptions {
  store: RunStateStore;
  executors: Record<string, Executor>;
  triggers: Record<string, Trigger>;
  queues: Record<string, QueueConfig>;
  defaultQueue?: string; // defaults to 'default'
  maxAttempts?: number; // defaults to 2 (spec §4)
  packs?: PackRegistry;
  auditLog?: AuditLog;
}

/** method -> privilege tag (mechanism for the §10.6 CLI/MCP split; surfaces land later). */
export const PRIVILEGE = {
  submitRun: 'client', getStatus: 'client', tick: 'service',
} as const;

export interface StatusItem {
  id: string; runId: string; status: string; blockedBy: string[];
  resultRef?: string; manifestRef?: string;
}

const TERMINAL_STATUSES = new Set(['done', 'failed', 'skipped']);

export class AgoraOrchestrator {
  private readonly store: RunStateStore;
  private readonly executors: Record<string, Executor>;
  private readonly triggers: Record<string, Trigger>;
  private readonly defaultQueue: string;
  private readonly maxAttempts: number;
  private readonly packs: PackRegistry | undefined;
  private readonly auditLog: AuditLog | undefined;
  constructor(opts: AgoraOrchestratorOptions) {
    this.store = opts.store;
    this.executors = opts.executors;
    this.triggers = opts.triggers;
    this.defaultQueue = opts.defaultQueue ?? 'default';
    this.maxAttempts = opts.maxAttempts ?? 2;
    this.packs = opts.packs;
    this.auditLog = opts.auditLog;
    if (!opts.queues[this.defaultQueue]) throw new Error(`AgoraOrchestrator: default queue '${this.defaultQueue}' not configured`);
    for (const [name, q] of Object.entries(opts.queues)) this.store.ensureQueue(name, q.concurrency);
  }
  submitRun(run: Run, actor?: string, submittedAt?: string): string {
    if (this.store.getItems(run.id).length > 0) return run.id; // already ingested — idempotent no-op
    const trigger = this.triggers['manual'];
    if (!trigger) throw new Error("AgoraOrchestrator: no 'manual' trigger registered");
    // Namespace item ids so two runs with a same-named item never collide in the store.
    // run ids are NOT namespaced; resourceLocks are NOT namespaced (cross-run locks are intentional).
    const nsRun: Run = {
      ...run,
      items: run.items.map((it) => ({
        ...it,
        id: ns(run.id, it.id),
        depends_on: it.depends_on.map((d) => ns(run.id, d)),
      })),
    };
    this.store.saveRun(nsRun, actor, submittedAt);
    this.store.markReady(trigger.initialReady(nsRun));
    this.auditLog?.append({ kind: 'run.submitted', runId: run.id, actor, at: new Date().toISOString() });
    return run.id;
  }
  async tick(queue?: string) {
    // Wrap each executor so the item passed to fire() carries the original (de-namespaced) id.
    // The store-internal id is namespaced; executors should only ever see the logical item id.
    const wrappedExecutors: Record<string, Executor> = Object.fromEntries(
      Object.entries(this.executors).map(([k, ex]) => [k, {
        id: ex.id,
        fire: (item, ctx) => ex.fire({ ...item, id: deNs(item.id), depends_on: item.depends_on.map(deNs) }, ctx),
        reconcile: ex.reconcile.bind(ex),
      }]),
    );
    const q = queue ?? this.defaultQueue;
    const result = await tick(this.store, wrappedExecutors, q, this.packs, {
      maxAttempts: this.maxAttempts,
      auditLog: this.auditLog,
      denamespace: deNs,
    });

    // Seal any run whose all items are now terminal and whose epoch has not yet been sealed.
    if (this.auditLog) {
      const allItems = this.store.getItems();
      // Collect distinct runIds present in this queue.
      const runIds = new Set(allItems.filter((i) => i.queue === q).map((i) => i.runId));
      const at = new Date().toISOString();
      for (const runId of runIds) {
        // Check the seal guard first (avoids getItems call when already sealed).
        const auditStore = this.store as unknown as { getAuditRoot(epochId: string): unknown };
        if (typeof auditStore.getAuditRoot === 'function' && auditStore.getAuditRoot(runId) !== undefined) continue;
        // All items for this run (across all queues — a run may span queues in theory, but in practice it's one queue).
        const runItems = allItems.filter((i) => i.runId === runId);
        if (runItems.length > 0 && runItems.every((i) => TERMINAL_STATUSES.has(i.status))) {
          this.auditLog.append({ kind: 'run.completed', runId, at });
          await this.auditLog.sealEpoch(runId);
        }
      }
    }
    return result;
  }
  /** Crash recovery: re-ready items left `running` by a crashed process so the run can progress.
   *  A stranded dispatch can't be reconciled by a fresh executor, so we treat it as a consumed
   *  attempt and requeue it (at-least-once). Exhaustion/terminal-failure + skip-cascade are then
   *  handled by the normal tick flow on the re-dispatch. Returns the number recovered. */
  recoverStranded(now: number = Date.now()): number {
    const stranded = this.store.getItems().filter((i) => i.status === 'running');
    for (const it of stranded) {
      this.store.releaseLocks(it.id);
      this.store.bumpAttempt(it.id);
      this.store.requeue(it.id, now); // status -> 'ready', nextAttemptAt = now (eligible immediately)
    }
    return stranded.length;
  }
  getStatus(runId?: string): StatusItem[] {
    const items = this.store.getItems(runId);
    // Internal lookup uses namespaced ids (as stored); output is de-namespaced.
    const byId = new Map(items.map((i) => [`${i.runId}:${i.id}`, i]));
    return items.map((i: ItemState) => ({
      id: deNs(i.id), runId: i.runId, status: i.status,
      blockedBy: i.depends_on
        .filter((d) => byId.get(`${i.runId}:${d}`)?.status !== 'done')
        .map((d) => deNs(d)),
      ...(i.resultRef !== undefined ? { resultRef: i.resultRef } : {}),
      ...(i.manifestRef !== undefined ? { manifestRef: i.manifestRef } : {}),
    }));
  }
}
