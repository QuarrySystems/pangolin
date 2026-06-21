import { it, expect, vi } from 'vitest';
import { NoopMetricsRecorder, recordMetric } from '../src/metrics.js';
import type { MetricsRecorder } from '../src/metrics.js';

it('NoopMetricsRecorder drops every call without throwing', () => {
  const r = new NoopMetricsRecorder();
  expect(r.name).toBe('noop');
  expect(() => {
    r.counter('x');
    r.gauge('y', 1);
    r.histogram('z', 2);
  }).not.toThrow();
});

it('recordMetric is a no-op when the recorder is undefined', () => {
  expect(() =>
    recordMetric(undefined, () => {
      throw new Error('should not run');
    }),
  ).not.toThrow();
});

it('recordMetric forwards to the recorder', () => {
  const calls: string[] = [];
  const r: MetricsRecorder = {
    name: 'rec',
    counter: (n) => calls.push(`counter:${n}`),
    gauge: () => {},
    histogram: () => {},
  };
  recordMetric(r, (m) => m.counter('pangolin_x_total'));
  expect(calls).toEqual(['counter:pangolin_x_total']);
});

it('recordMetric swallows a throwing recorder and logs to stderr (never breaks the caller)', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const r: MetricsRecorder = {
      name: 'boom',
      counter: () => {
        throw new Error('rec down');
      },
      gauge: () => {},
      histogram: () => {},
    };
    expect(() => recordMetric(r, (m) => m.counter('x'))).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]![0])).toContain('boom');
  } finally {
    spy.mockRestore();
  }
});
