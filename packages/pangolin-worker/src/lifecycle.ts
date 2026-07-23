import { createHmac } from 'node:crypto';
import type { LifecycleEvent } from '@quarry-systems/pangolin-core';

export type DeliveryFailureReason = 'http-status' | 'network' | 'timeout';

export interface DeliveryOutcome {
  delivered: boolean;
  status?: number;
  /** Closed enum — never a fetch error string, which can embed the callback URL (§3).
   *  'aborted' is deliberately absent: nothing in this slice produces it (slice C owns
   *  cancellation), and shipping an unreachable member from a published package is
   *  building ahead of demand. */
  reason?: DeliveryFailureReason;
}

export class LifecycleEmitter {
  constructor(private readonly opts: {
    callbackUrl?: string;
    hmacKey?: string;
    fetchImpl?: typeof fetch;
    /** Default 5_000. Injectable because the package has no vitest.config.* and runs at
     *  vitest's 5 s default testTimeout. Mirrors orchestrator/src/engine/tick.ts:22/:37.
     *  NOT an env var: the worker's env is minted by the client
     *  (pangolin-client/src/dispatch.ts:255-296), so a PANGOLIN_* knob is dead on arrival. */
    attemptTimeoutMs?: number;
  }) {}

  async emit(event: LifecycleEvent): Promise<DeliveryOutcome> {
    if (!this.opts.callbackUrl || !this.opts.hmacKey) return { delivered: false };

    const timestamp = new Date().toISOString();
    const payload = JSON.stringify(event);
    const signature = createHmac('sha256', this.opts.hmacKey)
      .update(`${event.dispatchId}.${timestamp}.${payload}`)
      .digest('hex');

    // A PLAIN OBJECT, deliberately. `new Headers({...})` here would validate
    // header VALUES too, and a caller-supplied dispatchId containing '\n' would throw out of
    // emit instead of returning an outcome. The real Headers is constructed in the TEST,
    // from whatever is passed here, which is what keeps that assertion live forever.
    const headers = {
      'Content-Type': 'application/json',
      'X-Pangolin-Signature': `sha256=${signature}`,
      'X-Pangolin-Dispatch-Id': event.dispatchId,
      'X-Pangolin-Timestamp': timestamp,
    };

    // Clamp before constructing: AbortSignal.timeout throws a RangeError on a negative,
    // NaN, or fractional delay (measured). Unclamped and outside the try, that is the same
    // escape-the-guarded-region shape as the reverted `new Headers` bug — lower likelihood,
    // identical failure mode.
    // Note: `Math.max(0, NaN)` is itself `NaN` (NaN comparisons are always false), so a plain
    // `Math.trunc(Math.max(0, requested))` does NOT clamp a NaN input — it must be special-cased.
    const requested = this.opts.attemptTimeoutMs ?? 5_000;
    const safeRequested = Number.isNaN(requested) ? 0 : requested;
    const signal = AbortSignal.timeout(Math.trunc(Math.max(0, safeRequested)));
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(this.opts.callbackUrl, {
        method: 'POST', headers, body: payload, signal,
      });
      return res.status >= 200 && res.status < 300
        ? { delivered: true, status: res.status }
        : { delivered: false, status: res.status, reason: 'http-status' };
    } catch {
      // Classify on the SIGNAL, not on the error's name or message: a hand-rolled mock
      // rejecting with new Error('aborted') must not be able to pin the wrong branch.
      return { delivered: false, reason: signal.aborted ? 'timeout' : 'network' };
    }
  }
}
