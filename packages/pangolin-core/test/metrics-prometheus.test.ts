import { describe, it, expect } from 'vitest';
import { renderPrometheus } from '../src/metrics-prometheus.js';
import type { MetricsSnapshot } from '../src/metrics.js';

describe('renderPrometheus', () => {
  it('renders an empty snapshot as the empty string', () => {
    expect(renderPrometheus({ counters: {}, gauges: {}, histograms: {} })).toBe('');
  });

  it('renders counters and gauges, TYPE once per family across label-series', () => {
    const snap: MetricsSnapshot = {
      counters: {
        'pangolin_dispatch_completed_total{outcome="finished"}': 3,
        'pangolin_dispatch_completed_total{outcome="failed"}': 1,
      },
      gauges: { 'pangolin_queue_depth{queue="default"}': 5 },
      histograms: {},
    };
    const out = renderPrometheus(snap);
    // exactly one TYPE line for the counter family:
    expect(out.match(/# TYPE pangolin_dispatch_completed_total counter/g)).toHaveLength(1);
    expect(out).toContain('pangolin_dispatch_completed_total{outcome="finished"} 3');
    expect(out).toContain('pangolin_dispatch_completed_total{outcome="failed"} 1');
    expect(out).toContain('# TYPE pangolin_queue_depth gauge');
    expect(out).toContain('pangolin_queue_depth{queue="default"} 5');
  });

  it('renders a histogram: cumulative buckets + +Inf, _sum, _count', () => {
    const snap: MetricsSnapshot = {
      counters: {},
      gauges: {},
      histograms: {
        pangolin_dispatch_duration_seconds: {
          count: 2,
          sum: 7,
          buckets: { '1': 1, '10': 2, '+Inf': 2 },
        },
      },
    };
    const out = renderPrometheus(snap).split('\n');
    expect(out).toContain('# TYPE pangolin_dispatch_duration_seconds histogram');
    expect(out).toContain('pangolin_dispatch_duration_seconds_bucket{le="1"} 1');
    expect(out).toContain('pangolin_dispatch_duration_seconds_bucket{le="10"} 2');
    expect(out).toContain('pangolin_dispatch_duration_seconds_bucket{le="+Inf"} 2');
    expect(out).toContain('pangolin_dispatch_duration_seconds_sum 7');
    expect(out).toContain('pangolin_dispatch_duration_seconds_count 2');
  });

  it('injects le into a labelled histogram series and keeps it last', () => {
    const snap: MetricsSnapshot = {
      counters: {},
      gauges: {},
      histograms: {
        'h_seconds{queue="default"}': { count: 1, sum: 2, buckets: { '5': 1, '+Inf': 1 } },
      },
    };
    const out = renderPrometheus(snap);
    expect(out).toContain('h_seconds_bucket{queue="default",le="5"} 1');
    expect(out).toContain('h_seconds_sum{queue="default"} 2');
  });

  it('renders non-finite numbers as Prometheus literals, never "Infinity"', () => {
    const snap: MetricsSnapshot = {
      counters: {},
      gauges: { g: Infinity, n: NaN, neg: -Infinity },
      histograms: {},
    };
    const out = renderPrometheus(snap);
    expect(out).toContain('g +Inf');
    expect(out).toContain('n NaN');
    expect(out).toContain('neg -Inf');
    expect(out).not.toContain('Infinity');
  });
});
