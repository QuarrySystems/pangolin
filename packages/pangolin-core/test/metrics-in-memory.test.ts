import { it, expect } from 'vitest';
import { InMemoryMetricsRecorder } from '../src/metrics-in-memory.js';

it('counter sums by series key; labels produce a sorted series key', () => {
  const r = new InMemoryMetricsRecorder();
  r.counter('pangolin_x_total');
  r.counter('pangolin_x_total', 2);
  r.counter('pangolin_done_total', 1, { b: '2', a: '1' });
  const s = r.snapshot();
  expect(s.counters['pangolin_x_total']).toBe(3);
  expect(s.counters['pangolin_done_total{a="1",b="2"}']).toBe(1);
});

it('gauge is last-write-wins per series', () => {
  const r = new InMemoryMetricsRecorder();
  r.gauge('pangolin_queue_depth', 5, { queue: 'default' });
  r.gauge('pangolin_queue_depth', 2, { queue: 'default' });
  expect(r.snapshot().gauges['pangolin_queue_depth{queue="default"}']).toBe(2);
});

it('histogram accumulates count, sum, and cumulative buckets (+Inf = count)', () => {
  const r = new InMemoryMetricsRecorder([1, 10]);
  r.histogram('pangolin_dispatch_duration_seconds', 0.5); // <= 1 and <= 10
  r.histogram('pangolin_dispatch_duration_seconds', 5); // <= 10 only
  r.histogram('pangolin_dispatch_duration_seconds', 50); // neither bounded bucket
  const h = r.snapshot().histograms['pangolin_dispatch_duration_seconds'];
  expect(h.count).toBe(3);
  expect(h.sum).toBe(55.5);
  expect(h.buckets['1']).toBe(1);
  expect(h.buckets['10']).toBe(2);
  expect(h.buckets['+Inf']).toBe(3);
});

it('snapshot returns an independent copy (mutating after snapshot does not change it)', () => {
  const r = new InMemoryMetricsRecorder();
  r.counter('pangolin_x_total');
  const s = r.snapshot();
  r.counter('pangolin_x_total');
  expect(s.counters['pangolin_x_total']).toBe(1); // snapshot frozen at time of call
});
