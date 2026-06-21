import { describe, it, expect } from 'vitest';
import { seriesKey, parseSeriesKey } from '../src/metrics-series-key.js';

describe('series-key format', () => {
  it('builds `name` alone and `name{k="v",…}` with labels sorted', () => {
    expect(seriesKey('pangolin_x_total')).toBe('pangolin_x_total');
    expect(seriesKey('pangolin_y_total', { queue: 'default', outcome: 'finished' })).toBe(
      'pangolin_y_total{outcome="finished",queue="default"}',
    );
  });

  it('parseSeriesKey is the exact inverse of seriesKey (round-trip)', () => {
    expect(parseSeriesKey(seriesKey('pangolin_x_total'))).toEqual({
      name: 'pangolin_x_total',
      labels: {},
    });
    const labels = { outcome: 'finished', queue: 'default' };
    expect(parseSeriesKey(seriesKey('pangolin_y_total', labels))).toEqual({
      name: 'pangolin_y_total',
      labels,
    });
  });
});
