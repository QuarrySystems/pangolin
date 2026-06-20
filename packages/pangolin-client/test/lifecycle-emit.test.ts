import { it, expect, vi } from 'vitest';
import { emitLifecycleEvent } from '../src/lifecycle-emit.js';
import { ConsoleTelemetryHook } from '../src/bundled-impls.js';
import type { LifecycleEvent, TelemetryHook } from '@quarry-systems/pangolin-core';

const sample: LifecycleEvent = {
  kind: 'dispatch.accepted',
  dispatchId: 'd1',
  target: 't',
  resolved: [],
  at: '2026-01-01T00:00:00.000Z',
};

it('emitLifecycleEvent forwards the event to the hook', () => {
  const seen: LifecycleEvent[] = [];
  const hook: TelemetryHook = { name: 'rec', emit: (e) => seen.push(e) };
  emitLifecycleEvent(hook, sample);
  expect(seen).toEqual([sample]);
});

it('emitLifecycleEvent is a no-op when telemetry is undefined', () => {
  expect(() => emitLifecycleEvent(undefined, sample)).not.toThrow();
});

it('emitLifecycleEvent swallows a throwing hook and logs loudly (never breaks the path)', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const hook: TelemetryHook = {
      name: 'boom',
      emit: () => {
        throw new Error('hook down');
      },
    };
    expect(() => emitLifecycleEvent(hook, sample)).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
    const msg = String(spy.mock.calls[0]![0]);
    expect(msg).toContain('boom'); // the hook name
    expect(msg).toContain('dispatch.accepted'); // the event kind
  } finally {
    spy.mockRestore();
  }
});

it('ConsoleTelemetryHook prints one JSON line per event to stderr', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    new ConsoleTelemetryHook().emit(sample);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(spy.mock.calls[0]![0]))).toEqual(sample);
  } finally {
    spy.mockRestore();
  }
});
