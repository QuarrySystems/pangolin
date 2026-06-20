import { it, expect } from 'vitest';
import { MetricsTelemetryHook, combineTelemetryHooks } from '../src/index.js';
import { InMemoryMetricsRecorder } from '@quarry-systems/pangolin-core';
import type { LifecycleEvent, TelemetryHook } from '@quarry-systems/pangolin-core';

const AT = '2026-01-01T00:00:00.000Z';

it('maps lifecycle events to dispatch metrics (outcome label + duration on finished/needs_input)', () => {
  const rec = new InMemoryMetricsRecorder();
  const hook = new MetricsTelemetryHook(rec);
  hook.emit({ kind: 'dispatch.accepted', dispatchId: 'd', target: 't', resolved: [], at: AT });
  hook.emit({ kind: 'dispatch.started', dispatchId: 'd', providerTaskId: 'p', at: AT });
  hook.emit({ kind: 'dispatch.finished', dispatchId: 'd', exitCode: 0, durationMs: 2000, at: AT });
  hook.emit({ kind: 'dispatch.failed', dispatchId: 'd', reason: 'x', at: AT });
  hook.emit({ kind: 'dispatch.cancelled', dispatchId: 'd', at: AT });
  const s = rec.snapshot();
  expect(s.counters['pangolin_dispatch_started_total']).toBe(1);
  expect(s.counters['pangolin_dispatch_completed_total{outcome="finished"}']).toBe(1);
  expect(s.counters['pangolin_dispatch_completed_total{outcome="failed"}']).toBe(1);
  expect(s.counters['pangolin_dispatch_completed_total{outcome="cancelled"}']).toBe(1);
  // accepted produces no metric:
  expect(s.counters['pangolin_dispatch_accepted_total']).toBeUndefined();
  // duration observed once (from finished; failed/cancelled carry no durationMs):
  expect(s.histograms['pangolin_dispatch_duration_seconds'].count).toBe(1);
  expect(s.histograms['pangolin_dispatch_duration_seconds'].sum).toBe(2);
});

it('combineTelemetryHooks fans out to all hooks and isolates a throwing one', () => {
  const seenA: string[] = [];
  const hookA: TelemetryHook = { name: 'a', emit: (e) => seenA.push(e.kind) };
  const hookB: TelemetryHook = {
    name: 'boom',
    emit: () => {
      throw new Error('b down');
    },
  };
  const seenC: string[] = [];
  const hookC: TelemetryHook = { name: 'c', emit: (e) => seenC.push(e.kind) };
  const combined = combineTelemetryHooks(hookA, hookB, hookC);
  const started: LifecycleEvent = {
    kind: 'dispatch.started',
    dispatchId: 'd',
    providerTaskId: 'p',
    at: AT,
  };
  expect(() => combined.emit(started)).not.toThrow();
  expect(seenA).toEqual(['dispatch.started']);
  expect(seenC).toEqual(['dispatch.started']); // C still ran despite B throwing
});
