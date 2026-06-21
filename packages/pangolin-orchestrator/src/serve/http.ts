// packages/pangolin-orchestrator/src/serve/http.ts
//
// Opt-in HTTP observability for the serve() loop: /healthz (heartbeat liveness),
// /readyz (last-error-free-tick readiness), /metrics (Prometheus text). The decision
// logic (evaluateHealth) is pure and lives here; the server (startHealthServer, Task 4)
// is added below it.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { renderPrometheus, type MetricsSnapshot } from '@quarry-systems/pangolin-core';

/** Liveness/readiness heartbeat, shared BY REFERENCE between serve() and the HTTP server. */
export interface ServeHealth {
  /** True once the reconcile-first tick before the main loop has completed. */
  started: boolean;
  /** Epoch ms of the most recent loop iteration that finished (success OR caught error). */
  lastTickAt: number;
  /** Epoch ms of the most recent iteration that finished with NO outer-catch error. */
  lastTickOkAt: number;
}

export interface HealthVerdict {
  live: boolean;
  ready: boolean;
  reason: 'starting' | 'stale' | 'not-ready' | 'ok';
}

/** Pure decision. Liveness keys off lastTickAt; readiness off lastTickOkAt — NEVER swapped:
 *  driving restarts off readiness would cause dependency-outage restart storms. */
export function evaluateHealth(
  health: ServeHealth,
  now: number,
  t: { livenessTimeoutMs: number; readinessTimeoutMs: number },
): HealthVerdict {
  if (!health.started) return { live: false, ready: false, reason: 'starting' };
  if (now - health.lastTickAt > t.livenessTimeoutMs) {
    return { live: false, ready: false, reason: 'stale' };
  }
  const ready = now - health.lastTickOkAt <= t.readinessTimeoutMs;
  return { live: true, ready, reason: ready ? 'ok' : 'not-ready' };
}

export interface HealthServerOptions {
  port: number;
  host?: string;
  /** Shared by reference with serve(); read on each request. */
  health: ServeHealth;
  livenessTimeoutMs: number;
  readinessTimeoutMs: number;
  now: () => number;
  /** When omitted, /metrics returns 404 (metrics not enabled for this serve). */
  metricsSnapshot?: () => MetricsSnapshot;
}

export interface HealthServerHandle {
  /** Resolves once the listener is closed (idle connections are dropped first). */
  close(): Promise<void>;
  /** The bound port (resolves an ephemeral port when 0 was requested). */
  readonly port: number;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function handle(req: IncomingMessage, res: ServerResponse, opts: HealthServerOptions): void {
  if (req.method !== 'GET') {
    json(res, 405, { status: 'method-not-allowed' });
    return;
  }
  const path = (req.url ?? '').split('?')[0];
  // Snapshot the heartbeat fields into a local at entry — keeps the read race-free even if a
  // future edit introduces an `await` between field reads (Node is single-threaded today).
  const h: ServeHealth = { ...opts.health };
  const now = opts.now();

  if (path === '/healthz') {
    const v = evaluateHealth(h, now, opts);
    json(res, v.live ? 200 : 503, { status: v.live ? 'ok' : v.reason, lastTickAt: h.lastTickAt });
    return;
  }
  if (path === '/readyz') {
    const v = evaluateHealth(h, now, opts);
    json(res, v.ready ? 200 : 503, {
      status: v.ready ? 'ready' : v.reason,
      lastTickOkAt: h.lastTickOkAt,
    });
    return;
  }
  if (path === '/metrics') {
    if (!opts.metricsSnapshot) {
      json(res, 404, { status: 'metrics-disabled' });
      return;
    }
    let text: string;
    try {
      text = renderPrometheus(opts.metricsSnapshot());
    } catch (err) {
      console.error(
        `[pangolin serve] http metrics error: ${err instanceof Error ? err.message : String(err)}`,
      );
      json(res, 500, { status: 'error' });
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.end(text);
    return;
  }
  json(res, 404, { status: 'not-found' });
}

export function startHealthServer(opts: HealthServerOptions): Promise<HealthServerHandle> {
  const server = createServer((req, res) => {
    try {
      handle(req, res, opts);
    } catch (err) {
      console.error(
        `[pangolin serve] http handler error: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('{"status":"error"}');
      }
    }
  });

  return new Promise<HealthServerHandle>((resolve, reject) => {
    server.once('error', reject); // bind failure (e.g. EADDRINUSE) → reject (fail fast)
    server.listen(opts.port, opts.host ?? '0.0.0.0', () => {
      server.removeListener('error', reject);
      const addr = server.address();
      const boundPort = typeof addr === 'object' && addr !== null ? addr.port : opts.port;
      resolve({
        port: boundPort,
        close: () =>
          new Promise<void>((res) => {
            // Drop idle keep-alive connections so a lingering scraper can't stall shutdown.
            server.closeIdleConnections();
            server.close(() => res());
          }),
      });
    });
  });
}
