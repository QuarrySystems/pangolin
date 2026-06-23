import { describe, it, expect, vi } from 'vitest';
import { DispatchExecutor } from '../src/executors/dispatch.js';
import type { DispatchExecutorOptions } from '../src/executors/dispatch.js';

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
  const client = {
    namespace: 'ns',
    storage: { put: vi.fn(async () => {}), get: vi.fn(), resolveLatest: vi.fn(async () => null) },
    dispatch: { fire },
  } as unknown as DispatchExecutorOptions['client'];
  return { client, fire };
}
function makeExec(opts: { client: DispatchExecutorOptions['client']; maxRuntimeMs?: number }) {
  return new DispatchExecutor({
    client: opts.client,
    target: 'local',
    workerImage: 'img',
    maxRuntimeMs: opts.maxRuntimeMs,
  });
}

describe('DispatchExecutor timeout derivation', () => {
  it('passes timeoutSeconds derived from maxRuntimeMs', async () => {
    const { client, fire } = fakeClient();
    const ex = makeExec({ client, maxRuntimeMs: 90_000 });
    const workItem: unknown = { id: 'i1', inputs: { subagent: 'a' } };
    const ctx: unknown = { runId: 'r1' };
    await ex.fire(
      workItem as unknown as Parameters<typeof ex.fire>[0],
      ctx as unknown as Parameters<typeof ex.fire>[1],
    );
    expect(fire).toHaveBeenCalledWith(expect.objectContaining({ timeoutSeconds: 90 }));
  });

  it('omits timeoutSeconds when maxRuntimeMs is unset (client floor applies)', async () => {
    const { client, fire } = fakeClient();
    const ex = makeExec({ client });
    const workItem: unknown = { id: 'i1', inputs: { subagent: 'a' } };
    const ctx: unknown = { runId: 'r1' };
    await ex.fire(
      workItem as unknown as Parameters<typeof ex.fire>[0],
      ctx as unknown as Parameters<typeof ex.fire>[1],
    );
    const arg = fire.mock.calls[0][0];
    expect('timeoutSeconds' in arg).toBe(false);
  });
});
