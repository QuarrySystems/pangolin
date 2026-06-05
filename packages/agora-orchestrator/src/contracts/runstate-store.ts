import type { VerifyOutcome } from '@quarry-systems/agora-core';
import type { ItemState, Run, TerminalStatus } from './types.js';

/**
 * Mutable run-state persistence (D2 split-store). The orchestrator service is the
 * SINGLE exclusive writer (D3). SQLite impl lands in task-runstate-sqlite.
 */
export interface RunStateStore {
  ensureQueue(name: string, concurrency: number): void;
  saveRun(run: Run, actor?: string, submittedAt?: string): void;
  markReady(itemIds: string[]): void;
  setRunning(itemId: string, dispatchHash: string): void;
  setStatus(itemId: string, status: TerminalStatus, reason?: string): void;
  getItems(runId?: string): ItemState[];
  runningCount(queue: string): number;
  queueConcurrency(queue: string): number;
  heldLockKeys(): string[];
  /** Atomically acquire ALL keys for an item; returns false (acquiring none) on any contention. */
  acquireLocks(itemId: string, keys: string[]): boolean;
  releaseLocks(itemId: string): void;
  getActor(itemId: string): string | undefined;
  getAttempts(itemId: string): number;      // absent reads as 0
  bumpAttempt(itemId: string): void;        // attempts += 1
  requeue(itemId: string, notBeforeMs: number): void; // status -> 'ready', nextAttemptAt = notBeforeMs
  setResultRef(itemId: string, ref: string): void;    // persist opaque result artifact ref
  setVerify(itemId: string, verify: VerifyOutcome): void; // persist self-verify signal
  setManifestRef(itemId: string, ref: string): void;  // persist opaque dispatch-manifest ref
  close(): void;
}
