// packages/agora-orchestrator/test/index.test.ts
import { describe, it, expect } from 'vitest';
import {
  AgoraOrchestrator,
  SqliteRunStateStore,
  ManualTrigger,
  computeNewlyReady,
  selectRunnable,
  tick,
  RUN_STATUSES,
} from '../src/index.js';

describe('barrel smoke test', () => {
  it('AgoraOrchestrator is a function (class)', () => {
    expect(typeof AgoraOrchestrator).toBe('function');
  });

  it('SqliteRunStateStore is a function (class)', () => {
    expect(typeof SqliteRunStateStore).toBe('function');
  });

  it('ManualTrigger is a function (class)', () => {
    expect(typeof ManualTrigger).toBe('function');
  });

  it('computeNewlyReady is a function', () => {
    expect(typeof computeNewlyReady).toBe('function');
  });

  it('selectRunnable is a function', () => {
    expect(typeof selectRunnable).toBe('function');
  });

  it('tick is a function', () => {
    expect(typeof tick).toBe('function');
  });

  it('RUN_STATUSES is an array', () => {
    expect(Array.isArray(RUN_STATUSES)).toBe(true);
  });
});
