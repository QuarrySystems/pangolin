import {
  makeTimeoutExit,
  type ComputeProvider,
  type ProviderContext,
  type ResolvedCredentials,
  type TaskExit,
  type TaskHandle,
  type TelemetryHook,
} from '@quarry-systems/pangolin-core';

type BaseCtx = { credentials: ResolvedCredentials; telemetry?: TelemetryHook };

/**
 * Bound a provider's awaitExit by a wall-clock deadline. Resolves (never
 * rejects on timeout) so callers always reach a terminal state and the
 * orchestrator's detached await records `settled`. On deadline it aborts
 * ctx.signal (clean path for a good-citizen provider), best-effort reaps via
 * compute.cancel?(), and resolves a synthetic timeout TaskExit.
 *
 * deadlineSeconds === undefined preserves today's unbounded behavior (no
 * timer, no signal) for callers that opt out.
 */
export async function boundedAwaitExit(
  compute: ComputeProvider,
  handle: TaskHandle,
  baseCtx: BaseCtx,
  deadlineSeconds: number | undefined,
): Promise<TaskExit> {
  if (deadlineSeconds === undefined) {
    return compute.awaitExit(handle, baseCtx);
  }

  const ac = new AbortController();
  const ctx: ProviderContext = { ...baseCtx, signal: ac.signal };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleanupPromise: Promise<void> | undefined;

  const onDeadline = new Promise<TaskExit>((resolve) => {
    timer = setTimeout(() => {
      // Resolve the timeout promise BEFORE aborting so that Promise.race
      // settles on the timeout exit rather than any abort-listener resolution
      // from a good-citizen provider.
      resolve(makeTimeoutExit()); // R3: shared factory, not an inline literal
      // Track cleanup so callers observe cancel + signal.aborted after await.
      cleanupPromise = (async () => {
        ac.abort();
        try {
          await compute.cancel?.(handle, ctx);
        } catch {
          // best-effort reap — the synthetic exit stands regardless
        }
      })();
    }, deadlineSeconds * 1000);
  });

  try {
    const result = await Promise.race([compute.awaitExit(handle, ctx), onDeadline]);
    // If timeout fired, wait for cleanup so callers see signal.aborted === true
    // and cancel already called by the time the returned promise settles.
    if (cleanupPromise !== undefined) {
      await cleanupPromise;
    }
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
