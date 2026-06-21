import { describe, it, expect, afterEach } from 'vitest';
import { startHealthServer, type HealthServerHandle, type ServeHealth } from '../src/serve/http.js';
import type { MetricsSnapshot } from '@quarry-systems/pangolin-core';

let handle: HealthServerHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

const TIMEOUTS = { livenessTimeoutMs: 100, readinessTimeoutMs: 100 };

async function start(
  health: ServeHealth,
  now: number,
  metricsSnapshot?: () => MetricsSnapshot,
): Promise<HealthServerHandle> {
  handle = await startHealthServer({
    port: 0,
    health,
    now: () => now,
    metricsSnapshot,
    ...TIMEOUTS,
  });
  return handle;
}

const fresh = (): ServeHealth => ({ started: true, lastTickAt: 1_000, lastTickOkAt: 1_000 });

describe('startHealthServer', () => {
  it('/healthz 200 when live, 503 when stale, 503 starting before first tick', async () => {
    const h = await start(fresh(), 1_050);
    expect((await fetch(`http://127.0.0.1:${h.port}/healthz`)).status).toBe(200);
    await h.close();
    const h2 = await start({ started: false, lastTickAt: 0, lastTickOkAt: 0 }, 5_000);
    expect((await fetch(`http://127.0.0.1:${h2.port}/healthz`)).status).toBe(503);
    await h2.close();
    const h3 = await start(fresh(), 9_999);
    expect((await fetch(`http://127.0.0.1:${h3.port}/healthz`)).status).toBe(503);
  });

  it('/readyz tracks lastTickOkAt INDEPENDENTLY of lastTickAt (live but not ready)', async () => {
    // lastTickAt fresh (loop alive), lastTickOkAt stale (deps down): healthz 200, readyz 503.
    const h = await start({ started: true, lastTickAt: 1_500, lastTickOkAt: 1_000 }, 1_550);
    expect((await fetch(`http://127.0.0.1:${h.port}/healthz`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${h.port}/readyz`)).status).toBe(503);
  });

  it('/metrics renders a provided snapshot; 404 with no provider; 500 when it throws', async () => {
    const snap: MetricsSnapshot = { counters: { c: 2 }, gauges: {}, histograms: {} };
    const h = await start(fresh(), 1_050, () => snap);
    const ok = await fetch(`http://127.0.0.1:${h.port}/metrics`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('text/plain; version=0.0.4');
    expect(await ok.text()).toContain('c 2');
    await h.close();

    const h2 = await start(fresh(), 1_050); // no provider
    expect((await fetch(`http://127.0.0.1:${h2.port}/metrics`)).status).toBe(404);
    await h2.close();

    const h3 = await start(fresh(), 1_050, () => {
      throw new Error('snapshot boom');
    });
    expect((await fetch(`http://127.0.0.1:${h3.port}/metrics`)).status).toBe(500);
  });

  it('404 for unknown paths and 405 for non-GET', async () => {
    const h = await start(fresh(), 1_050);
    expect((await fetch(`http://127.0.0.1:${h.port}/nope`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${h.port}/healthz`, { method: 'POST' })).status).toBe(
      405,
    );
  });
});
