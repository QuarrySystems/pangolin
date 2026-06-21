// Pure Prometheus text-exposition renderer (version 0.0.4) for a MetricsSnapshot. Dependency-free;
// the only core companion to the snapshot. Heavier OTel/prom-client adapters stay out of core.

import type { MetricsSnapshot } from './metrics.js';
import { parseSeriesKey } from './metrics-series-key.js';

/** Render a number as Prometheus requires: +Inf / -Inf / NaN literals for non-finite values.
 *  JS `String(Infinity)` === 'Infinity' is INVALID exposition format and poisons the whole scrape. */
function fmt(n: number): string {
  if (Number.isFinite(n)) return String(n);
  if (Number.isNaN(n)) return 'NaN';
  return n > 0 ? '+Inf' : '-Inf';
}

/** `{k="v",…}` (sorted) for a label record, or '' when empty. */
function fmtLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return `{${keys.map((k) => `${k}="${labels[k]}"`).join(',')}}`;
}

/** `{k="v",…,extraKey="extraVal"}` — existing labels (sorted) plus one trailing label (e.g. le). */
function fmtLabelsWith(labels: Record<string, string>, extraKey: string, extraVal: string): string {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k]}"`);
  parts.push(`${extraKey}="${extraVal}"`);
  return `{${parts.join(',')}}`;
}

/** Group a snapshot map's entries by bare metric name, preserving first-seen order. */
function groupByName<T>(
  record: Record<string, T>,
): Array<{
  name: string;
  series: Array<{ key: string; labels: Record<string, string>; value: T }>;
}> {
  const order: string[] = [];
  const groups = new Map<
    string,
    Array<{ key: string; labels: Record<string, string>; value: T }>
  >();
  for (const [key, value] of Object.entries(record)) {
    const { name, labels } = parseSeriesKey(key);
    let bucket = groups.get(name);
    if (!bucket) {
      bucket = [];
      groups.set(name, bucket);
      order.push(name);
    }
    bucket.push({ key, labels, value });
  }
  return order.map((name) => ({ name, series: groups.get(name)! }));
}

export function renderPrometheus(snapshot: MetricsSnapshot): string {
  const lines: string[] = [];

  for (const type of [
    { kind: 'counter' as const, record: snapshot.counters },
    { kind: 'gauge' as const, record: snapshot.gauges },
  ]) {
    for (const { name, series } of groupByName(type.record)) {
      lines.push(`# TYPE ${name} ${type.kind}`);
      for (const s of series) lines.push(`${s.key} ${fmt(s.value)}`);
    }
  }

  for (const { name, series } of groupByName(snapshot.histograms)) {
    lines.push(`# TYPE ${name} histogram`);
    for (const { labels, value: h } of series) {
      const bounds = Object.keys(h.buckets)
        .filter((b) => b !== '+Inf')
        .sort((a, b) => Number(a) - Number(b));
      for (const b of bounds) {
        lines.push(`${name}_bucket${fmtLabelsWith(labels, 'le', b)} ${fmt(h.buckets[b]!)}`);
      }
      lines.push(
        `${name}_bucket${fmtLabelsWith(labels, 'le', '+Inf')} ${fmt(h.buckets['+Inf'] ?? h.count)}`,
      );
      lines.push(`${name}_sum${fmtLabels(labels)} ${fmt(h.sum)}`);
      lines.push(`${name}_count${fmtLabels(labels)} ${fmt(h.count)}`);
    }
  }

  return lines.length === 0 ? '' : lines.join('\n') + '\n';
}
