// The Prometheus-style series-key format, single-sourced. The recorder BUILDS keys with
// seriesKey(); the Prometheus renderer DECODES them with parseSeriesKey(). Keeping the builder
// and its inverse together (with a round-trip test) prevents the two from drifting.
//
// Label VALUES are assumed simple identifiers — the metric set uses only bounded outcome/queue —
// so NO escaping is performed; callers must not pass values containing `"`, `,`, or `}`.

/** `name` alone, or `name{k="v",…}` with labels sorted by key. */
export function seriesKey(name: string, labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k]}"`);
  return `${name}{${parts.join(',')}}`;
}

/** Inverse of seriesKey: recover the bare metric name and its labels from a series key. */
export function parseSeriesKey(key: string): { name: string; labels: Record<string, string> } {
  const brace = key.indexOf('{');
  if (brace === -1) return { name: key, labels: {} };
  const name = key.slice(0, brace);
  const inner = key.slice(brace + 1, key.lastIndexOf('}'));
  const labels: Record<string, string> = {};
  if (inner.length > 0) {
    for (const part of inner.split(',')) {
      const eq = part.indexOf('=');
      const k = part.slice(0, eq);
      // value is wrapped in quotes: strip the leading `="` and the trailing `"`.
      const v = part.slice(eq + 2, part.length - 1);
      labels[k] = v;
    }
  }
  return { name, labels };
}
