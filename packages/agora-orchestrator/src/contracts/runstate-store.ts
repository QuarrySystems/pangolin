import type { ItemState, Run, RunStatus, TerminalStatus } from './types.js';

/**
 * Mutable run-state persistence (D2 split-store). The orchestrator service is the
 * SINGLE exclusive writer (D3). SQLite impl lands in task-runstate-sqlite.
 */
export interface RunStateStore {
  ensureQueue(name: string, concurrency: number): void;
  saveRun(run: Run): void;
  markReady(itemIds: string[]): void;
  setRunning(itemId: string, dispatchHash: string): void;
  setStatus(itemId: string, status: TerminalStatus): void;
  getItems(runId?: string): ItemState[];
  runningCount(queue: string): number;
  queueConcurrency(queue: string): number;
  heldLockKeys(): string[];
  /** Atomically acquire ALL keys for an item; returns false (acquiring none) on any contention. */
  acquireLocks(itemId: string, keys: string[]): boolean;
  releaseLocks(itemId: string): void;
  close(): void;
}
