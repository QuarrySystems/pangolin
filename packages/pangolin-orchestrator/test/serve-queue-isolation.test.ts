// Follow-up to KNOWN-ISSUES.md #7. Driving every configured queue introduced a new
// way for a queue to be silently never driven — the same failure mode #7 was about.
//
// serve() ticks queues sequentially. With a bare `for (const q of queues) await tick(q)`
// a throw from an EARLY queue aborts the whole iteration: later queues are never ticked,
// and the status publish below is skipped too. The next iteration starts at the same
// failing queue, so a deterministic fault on one queue starves every queue after it,
// indefinitely, with nothing naming the starved queues.
//
// The contract: every configured queue is ATTEMPTED on every iteration regardless of
// what its siblings did — while a failure still marks the iteration unhealthy, because
// /readyz staleness is derived from iterations completing cleanly.
import { describe, it, expect, vi } from 'vitest';
import type { SubmissionTransport } from '../src/index.js';
import { serve } from '../src/serve/driver.js';

const noTransport: SubmissionTransport = {
  async submit() {
    return '';
  },
  async pollInbox() {
    return [];
  },
  async ack() {},
  async deadLetter() {},
  async publish() {},
  async readOutbox() {
    return [];
  },
};

/** Orchestrator stub recording every tick, optionally throwing for named queues. */
function stubOrch(configured: string[], throwFor: string[] = []) {
  const ticked: string[] = [];
  return {
    ticked,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    orch: {
      recoverStranded() {},
      getConfiguredQueues() {
        return configured;
      },
      async tick(q: string) {
        ticked.push(q);
        if (throwFor.includes(q)) throw new Error(`tick failed for ${q}`);
      },
      getStatus() {
        return [];
      },
      getAuditExport() {
        return { root: undefined };
      },
      cancelRun() {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

async function serveBriefly(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  orch: any,
  onError: (e: unknown) => void,
  until: () => boolean,
): Promise<void> {
  const ac = new AbortController();
  const p = serve({
    orchestrator: orch,
    transport: noTransport,
    tickIntervalMs: 5,
    signal: ac.signal,
    onError,
  }).catch(onError); // reconcile-first failures propagate out of serve(); keep the test alive
  const start = Date.now();
  while (Date.now() - start < 5_000 && !until()) {
    await new Promise((r) => setTimeout(r, 5));
  }
  ac.abort();
  await p;
}

describe('#7 follow-up: one failing queue must not starve its siblings', () => {
  it('ticks every configured queue in an iteration even when an earlier one throws', async () => {
    const { ticked, orch } = stubOrch(['alpha', 'beta', 'gamma'], ['alpha']);
    const errors: unknown[] = [];

    await serveBriefly(
      orch,
      (e) => errors.push(e),
      () => ticked.filter((q) => q === 'gamma').length >= 2,
    );

    // Before the fix `ticked` was ['alpha','alpha','alpha',...] — beta and gamma never ran.
    expect(ticked).toContain('beta');
    expect(ticked).toContain('gamma');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('keeps driving healthy queues across many iterations while one stays broken', async () => {
    const { ticked, orch } = stubOrch(['bad', 'good'], ['bad']);

    await serveBriefly(
      orch,
      () => {},
      () => ticked.filter((q) => q === 'good').length >= 3,
    );

    const goodTicks = ticked.filter((q) => q === 'good').length;
    const badTicks = ticked.filter((q) => q === 'bad').length;
    expect(goodTicks).toBeGreaterThanOrEqual(3);
    // Both are attempted every iteration — the healthy one does not fall behind.
    expect(Math.abs(goodTicks - badTicks)).toBeLessThanOrEqual(1);
  });

  it('a single-queue failure still surfaces that exact error, unwrapped', async () => {
    // Preserves the pre-existing contract: onError receives the tick error itself, not
    // an aggregate, so single-queue deployments see no change.
    const { ticked, orch } = stubOrch(['default'], ['default']);
    const errors: unknown[] = [];

    await serveBriefly(
      orch,
      (e) => errors.push(e),
      () => ticked.length >= 2,
    );

    expect((errors[0] as Error).message).toBe('tick failed for default');
  });

  it('reports every failing queue when more than one breaks', async () => {
    const { ticked, orch } = stubOrch(['a', 'b'], ['a', 'b']);
    const errors: unknown[] = [];

    await serveBriefly(
      orch,
      (e) => errors.push(e),
      () => ticked.length >= 4,
    );

    const named = errors
      .map((e) => (e instanceof AggregateError ? e.errors.map((x) => String(x)).join() : String(e)))
      .join('\n');
    expect(named).toContain('a');
    expect(named).toContain('b');
  });

  it('a failing tick still marks the iteration unhealthy (readiness must degrade)', async () => {
    // /readyz staleness is derived from iterations reaching their end cleanly. Isolating
    // per-queue must not turn a broken tick into a "healthy" iteration.
    const { ticked, orch } = stubOrch(['solo'], ['solo']);
    const publish = vi.fn();

    const ac = new AbortController();
    const p = serve({
      orchestrator: orch,
      transport: { ...noTransport, publish },
      tickIntervalMs: 5,
      signal: ac.signal,
      onError: () => {},
    }).catch(() => {});
    const start = Date.now();
    while (Date.now() - start < 5_000 && ticked.length < 3) {
      await new Promise((r) => setTimeout(r, 5));
    }
    ac.abort();
    await p;

    // The iteration aborts before the publish block, exactly as it did pre-change.
    expect(publish).not.toHaveBeenCalled();
  });
});
