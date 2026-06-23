import { describe, it, expect, vi } from 'vitest';
import { DispatchExecutor } from '../src/executors/dispatch.js';

function fakeClient() {
  const fire = vi.fn(async () => ({
    dispatchId: 'd1',
    awaitExit: async () => ({ exitCode: 0 }),
    resolved: {
      subagent: { name: 'a', contentHash: 'h' },
      capabilities: [],
      env: [],
      secretRefs: {},
      workerImage: 'img',
    },
    reconcile: async () => ({ exitCode: 0 }),
    cleanup: () => {},
  }));
  return {
    namespace: 'ns',
    storage: { put: vi.fn(async () => {}), get: vi.fn(), resolveLatest: vi.fn(async () => null) },
    dispatch: { fire },
  } as unknown as Parameters<typeof makeExec>[0]['client'];
}
function makeExec(opts: { client: any; maxRuntimeMs?: number }) {
  return new DispatchExecutor({
    client: opts.client,
    target: 'local',
    workerImage: 'img',
    maxRuntimeMs: opts.maxRuntimeMs,
  });
}

describe('DispatchExecutor timeout derivation', () => {
  it('passes timeoutSeconds derived from maxRuntimeMs', async () => {
    const client = fakeClient();
    const ex = makeExec({ client, maxRuntimeMs: 90_000 });
    await ex.fire({ id: 'i1', inputs: { subagent: 'a' } } as any, { runId: 'r1' } as any);
    expect((client as any).dispatch.fire).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutSeconds: 90 }),
    );
  });

  it('omits timeoutSeconds when maxRuntimeMs is unset (client floor applies)', async () => {
    const client = fakeClient();
    const ex = makeExec({ client });
    await ex.fire({ id: 'i1', inputs: { subagent: 'a' } } as any, { runId: 'r1' } as any);
    const arg = (client as any).dispatch.fire.mock.calls[0][0];
    expect('timeoutSeconds' in arg).toBe(false);
  });
});
