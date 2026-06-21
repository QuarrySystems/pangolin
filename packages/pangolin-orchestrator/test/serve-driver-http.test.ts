import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { serve } from '../src/serve/driver.js';

/** Find a free TCP port by binding :0, reading it, and releasing it. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

/** Poll `fn` until it returns true or the timeout elapses. */
async function waitFor(fn: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function fakeOrch(opts: { tickThrowsAfter?: number } = {}) {
  let ticks = 0;
  return {
    recoverStranded() {},
    async tick() {
      ticks += 1;
      if (opts.tickThrowsAfter !== undefined && ticks > opts.tickThrowsAfter) {
        throw new Error('dep down');
      }
    },
    getStatus() {
      return [];
    },
    getAuditExport() {
      return { root: undefined };
    },
    cancelRun() {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const noTransport = {
  async pollInbox() {
    return [];
  },
  async ack() {},
  async deadLetter() {},
  async publish() {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

describe('serve() HTTP integration', () => {
  it('serves /healthz and /readyz 200 once the loop is ticking', async () => {
    const port = await freePort();
    const ac = new AbortController();
    const p = serve({
      orchestrator: fakeOrch(),
      transport: noTransport,
      signal: ac.signal,
      tickIntervalMs: 10,
      onError: () => {},
      http: { port },
    });
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/healthz`)).status === 200);
    expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
    ac.abort();
    await p;
  });

  it('degrades /readyz to 503 while /healthz stays 200 when ticks start failing', async () => {
    const port = await freePort();
    const ac = new AbortController();
    const p = serve({
      orchestrator: fakeOrch({ tickThrowsAfter: 1 }), // reconcile-first tick ok; loop ticks throw
      transport: noTransport,
      signal: ac.signal,
      tickIntervalMs: 10,
      onError: () => {},
      http: { port, livenessTimeoutMs: 5_000, readinessTimeoutMs: 50 },
    });
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/readyz`)).status === 503);
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200); // live, not ready
    ac.abort();
    await p;
  });

  it('opens no port when http is unset', async () => {
    const port = await freePort();
    const ac = new AbortController();
    const p = serve({
      orchestrator: fakeOrch(),
      transport: noTransport,
      signal: ac.signal,
      tickIntervalMs: 10,
      onError: () => {},
    });
    await new Promise((r) => setTimeout(r, 50));
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
    ac.abort();
    await p;
  });
});
