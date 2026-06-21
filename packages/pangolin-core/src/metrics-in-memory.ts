import type { MetricsRecorder, MetricsSnapshot } from './metrics.js';
import { seriesKey } from './metrics-series-key.js';

const DEFAULT_BUCKETS = [0.5, 1, 5, 10, 30, 60, 300, 900, 1800, 3600, 7200];

interface Hist {
  count: number;
  sum: number;
  cumulative: number[]; // aligned to `buckets`; cumulative[i] = #observations <= buckets[i]
}

/** In-memory aggregating recorder. The reference impl: collection only, no exposure. Read the
 *  current values via `snapshot()`; a future /metrics endpoint or a Prometheus/OTel adapter renders. */
export class InMemoryMetricsRecorder implements MetricsRecorder {
  readonly name = 'in-memory';
  private readonly _counters = new Map<string, number>();
  private readonly _gauges = new Map<string, number>();
  private readonly _hists = new Map<string, Hist>();

  constructor(private readonly buckets: number[] = DEFAULT_BUCKETS) {}

  counter(name: string, value = 1, labels?: Record<string, string>): void {
    const k = seriesKey(name, labels);
    this._counters.set(k, (this._counters.get(k) ?? 0) + value);
  }

  gauge(name: string, value: number, labels?: Record<string, string>): void {
    this._gauges.set(seriesKey(name, labels), value);
  }

  histogram(name: string, value: number, labels?: Record<string, string>): void {
    const k = seriesKey(name, labels);
    let h = this._hists.get(k);
    if (!h) {
      h = { count: 0, sum: 0, cumulative: this.buckets.map(() => 0) };
      this._hists.set(k, h);
    }
    h.count += 1;
    h.sum += value;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]!) h.cumulative[i]! += 1;
    }
  }

  snapshot(): MetricsSnapshot {
    const counters: Record<string, number> = {};
    for (const [k, v] of this._counters) counters[k] = v;
    const gauges: Record<string, number> = {};
    for (const [k, v] of this._gauges) gauges[k] = v;
    const histograms: MetricsSnapshot['histograms'] = {};
    for (const [k, h] of this._hists) {
      const buckets: Record<string, number> = {};
      for (let i = 0; i < this.buckets.length; i++) {
        buckets[String(this.buckets[i])] = h.cumulative[i]!;
      }
      buckets['+Inf'] = h.count;
      histograms[k] = { count: h.count, sum: h.sum, buckets };
    }
    return { counters, gauges, histograms };
  }
}
