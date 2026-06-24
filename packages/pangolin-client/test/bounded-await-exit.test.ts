import { describe, it, expect, vi } from 'vitest';
import type {
  ComputeProvider,
  ProviderContext,
  TaskExit,
  TaskHandle,
} from '@quarry-systems/pangolin-core';
import { boundedAwaitExit } from '../src/bounded-await-exit.js';

const handle: TaskHandle = { providerTaskId: 't-1' };
const baseCtx = { credentials: { kind: 'none' } } as const;

function provider(over: Partial<ComputeProvider>): ComputeProvider {
  return {
    name: 'fake',
    run: async () => handle,
    awaitExit: async () => {
      throw new Error('not impl');
    },
    ...over,
  };
}

const ok: TaskExit = {
  exitCode: 0,
  startedAt: new Date(0),
  finishedAt: new Date(0),
  stdout: '',
  stderr: '',
};

describe('boundedAwaitExit', () => {
  it('passes through a fast exit untouched and does not cancel', async () => {
    const cancel = vi.fn(async () => {});
    const p = provider({ awaitExit: async () => ok, cancel });
    const exit = await boundedAwaitExit(p, handle, baseCtx, 3600);
    expect(exit).toEqual(ok);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('on deadline: aborts the signal, reaps via cancel, resolves with timeout failure', async () => {
    let seenSignal: AbortSignal | undefined;
    const cancel = vi.fn(async () => {});
    const p = provider({
      // never resolves until aborted; record the signal it received
      awaitExit: (_h: TaskHandle, ctx: ProviderContext) =>
        new Promise<TaskExit>((resolve) => {
          seenSignal = ctx.signal;
          ctx.signal?.addEventListener('abort', () => resolve(ok)); // good citizen path
        }),
      cancel,
    });
    // 0-second deadline => fires on next tick
    const exit = await boundedAwaitExit(p, handle, baseCtx, 0);
    expect(exit.providerFailureReason).toBe('timeout');
    expect(exit.exitCode).toBe(-1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(seenSignal?.aborted).toBe(true);
  });

  it('with no deadline, calls awaitExit once and never constructs a timer/signal', async () => {
    const awaitExit = vi.fn(async (_h: TaskHandle, ctx: ProviderContext) => {
      expect(ctx.signal).toBeUndefined();
      return ok;
    });
    const p = provider({ awaitExit });
    const exit = await boundedAwaitExit(p, handle, baseCtx, undefined);
    expect(exit).toEqual(ok);
    expect(awaitExit).toHaveBeenCalledTimes(1);
  });

  it('does not reject when cancel throws on deadline', async () => {
    const p = provider({
      awaitExit: () => new Promise<TaskExit>(() => {}), // hangs forever
      cancel: async () => {
        throw new Error('stop failed');
      },
    });
    const exit = await boundedAwaitExit(p, handle, baseCtx, 0);
    expect(exit.providerFailureReason).toBe('timeout');
  });
});
