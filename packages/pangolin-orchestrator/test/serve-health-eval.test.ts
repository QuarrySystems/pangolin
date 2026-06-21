import { describe, it, expect } from 'vitest';
import { evaluateHealth, type ServeHealth } from '../src/serve/http.js';

const T = { livenessTimeoutMs: 100, readinessTimeoutMs: 100 };

describe('evaluateHealth', () => {
  it('reports starting before the first tick', () => {
    const h: ServeHealth = { started: false, lastTickAt: 0, lastTickOkAt: 0 };
    expect(evaluateHealth(h, 1_000, T)).toEqual({ live: false, ready: false, reason: 'starting' });
  });

  it('reports ok when both timestamps are fresh', () => {
    const h: ServeHealth = { started: true, lastTickAt: 1_000, lastTickOkAt: 1_000 };
    expect(evaluateHealth(h, 1_050, T)).toEqual({ live: true, ready: true, reason: 'ok' });
  });

  it('reports stale (not live) when lastTickAt is too old', () => {
    const h: ServeHealth = { started: true, lastTickAt: 1_000, lastTickOkAt: 1_000 };
    expect(evaluateHealth(h, 1_500, T)).toEqual({ live: false, ready: false, reason: 'stale' });
  });

  it('LIVE BUT NOT READY when ticks progress yet the last one errored (deps down)', () => {
    // lastTickAt fresh (loop still iterating), lastTickOkAt stale (every tick throwing).
    const h: ServeHealth = { started: true, lastTickAt: 1_500, lastTickOkAt: 1_000 };
    expect(evaluateHealth(h, 1_550, T)).toEqual({ live: true, ready: false, reason: 'not-ready' });
  });
});
