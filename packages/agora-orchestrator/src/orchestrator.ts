// packages/agora-orchestrator/src/orchestrator.ts
import type { Executor, ItemState, Run, RunStateStore, Trigger } from './contracts/index.js';
import { tick } from './engine/tick.js';

export interface QueueConfig { concurrency: number; }
export interface AgoraOrchestratorOptions {
  store: RunStateStore;
  executors: Record<string, Executor>;
  triggers: Record<string, Trigger>;
  queues: Record<string, QueueConfig>;
  defaultQueue?: string; // defaults to 'default'
  maxAttempts?: number; // defaults to 2 (spec §4)
}

/** method -> privilege tag (mechanism for the §10.6 CLI/MCP split; surfaces land later). */
export const PRIVILEGE = {
  submitRun: 'client', getStatus: 'client', tick: 'service',
} as const;

export interface StatusItem { id: string; runId: string; status: string; blockedBy: string[]; }

export class AgoraOrchestrator {
  private readonly store: RunStateStore;
  private readonly executors: Record<string, Executor>;
  private readonly triggers: Record<string, Trigger>;
  private readonly defaultQueue: string;
  private readonly maxAttempts: number;
  constructor(opts: AgoraOrchestratorOptions) {
    this.store = opts.store;
    this.executors = opts.executors;
    this.triggers = opts.triggers;
    this.defaultQueue = opts.defaultQueue ?? 'default';
    this.maxAttempts = opts.maxAttempts ?? 2;
    if (!opts.queues[this.defaultQueue]) throw new Error(`AgoraOrchestrator: default queue '${this.defaultQueue}' not configured`);
    for (const [name, q] of Object.entries(opts.queues)) this.store.ensureQueue(name, q.concurrency);
  }
  submitRun(run: Run, actor?: string): string {
    if (this.store.getItems(run.id).length > 0) return run.id; // already ingested — idempotent no-op
    const trigger = this.triggers['manual'];
    if (!trigger) throw new Error("AgoraOrchestrator: no 'manual' trigger registered");
    this.store.saveRun(run, actor);
    this.store.markReady(trigger.initialReady(run));
    return run.id;
  }
  async tick(queue?: string) { return tick(this.store, this.executors, queue ?? this.defaultQueue, { maxAttempts: this.maxAttempts }); }
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
    const byId = new Map(items.map((i) => [`${i.runId}:${i.id}`, i]));
    return items.map((i: ItemState) => ({
      id: i.id, runId: i.runId, status: i.status,
      blockedBy: i.depends_on.filter((d) => byId.get(`${i.runId}:${d}`)?.status !== 'done'),
    }));
  }
}
