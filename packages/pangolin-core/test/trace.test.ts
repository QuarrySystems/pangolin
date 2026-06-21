import { describe, it, expect } from 'vitest';
import type { TraceContext, LifecycleEvent, DispatchWork } from '../src/index.js';

describe('TraceContext', () => {
  it('carries traceId + optional runId/itemId and rides DispatchWork + LifecycleEvent', () => {
    const trace: TraceContext = { traceId: 'run-1', runId: 'run-1', itemId: 'a' };

    const work: DispatchWork = { subagent: 's', target: 't', trace };
    expect(work.trace?.traceId).toBe('run-1');
    expect(work.trace?.itemId).toBe('a');

    const started: LifecycleEvent = {
      kind: 'dispatch.started',
      dispatchId: 'd',
      providerTaskId: 'p',
      at: '2026-01-01T00:00:00.000Z',
      trace,
    };
    expect(started.trace?.runId).toBe('run-1');

    // traceId-only (standalone) shape is valid:
    const minimal: TraceContext = { traceId: 'd' };
    expect(minimal.runId).toBeUndefined();
  });
});
