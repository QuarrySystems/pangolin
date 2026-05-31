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
  DispatchExecutor,
  PackRegistry,
  effectTierPolicy,
  patchSchema,
  validateShape,
  devPack,
  devCodeEdit,
  devVerify,
  devRegistry,
  MailboxSubmissionTransport,
  LocalDirMailbox,
  serve,
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

  it('DispatchExecutor is a function (class)', () => {
    expect(typeof DispatchExecutor).toBe('function');
  });

  it('PackRegistry is a function (class)', () => {
    expect(typeof PackRegistry).toBe('function');
  });

  it('effectTierPolicy is a function', () => {
    expect(typeof effectTierPolicy).toBe('function');
  });

  it('patchSchema is defined (zod schema)', () => {
    expect(patchSchema).toBeDefined();
  });

  it('validateShape is a function', () => {
    expect(typeof validateShape).toBe('function');
  });

  it('devPack is an array', () => {
    expect(Array.isArray(devPack)).toBe(true);
  });

  it('devCodeEdit is defined (SubagentShape)', () => {
    expect(devCodeEdit).toBeDefined();
  });

  it('devVerify is defined (SubagentShape)', () => {
    expect(devVerify).toBeDefined();
  });

  it('devRegistry is a function', () => {
    expect(typeof devRegistry).toBe('function');
  });

  it('MailboxSubmissionTransport is a function (class)', () => {
    expect(typeof MailboxSubmissionTransport).toBe('function');
  });

  it('LocalDirMailbox is a function (class)', () => {
    expect(typeof LocalDirMailbox).toBe('function');
  });

  it('serve is a function', () => {
    expect(typeof serve).toBe('function');
  });
});
