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
  constructor(
    private readonly opts: {
      callbackUrl?: string;
      hmacKey?: string;
      fetchImpl?: typeof fetch;
      /** Default 5_000. Injectable because the package has no vitest.config.* and runs at
       *  vitest's 5 s default testTimeout. Mirrors orchestrator/src/engine/tick.ts:22/:37.
       *  NOT an env var: the worker's env is minted by the client
       *  (pangolin-client/src/dispatch.ts:255-296), so a PANGOLIN_* knob is dead on arrival. */
      attemptTimeoutMs?: number;
    },
  ) {}

  async emit(event: LifecycleEvent, opts?: { signal?: AbortSignal }): Promise<DeliveryOutcome> {
    // An absent `reason` here means "not configured, nothing attempted" — distinct from a
    // delivery attempt that failed (which always sets `reason`). A consumer checking only
    // `delivered` cannot tell the two apart from this return alone.
    if (!this.opts.callbackUrl || !this.opts.hmacKey) return { delivered: false };

    // These two calls sit outside the try and can throw: `JSON.stringify` on a circular
    // `event` or a BigInt field, and `createHmac` with `ERR_INVALID_ARG_TYPE` on a non-string
    // hmacKey. Both are unreachable from typed in-repo callers, so this is not a live bug —
    // but see the untyped-JS-caller threat model below, so the invariant is stated honestly.
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

    // Clamp before constructing: AbortSignal.timeout throws a RangeError on a delay that is
    // negative, NaN, fractional, +Infinity, or outside [0, 2^32-1] (measured). Unclamped and
    // outside the try, that is the same escape-the-guarded-region shape as the reverted
    // `new Headers` bug. `Number.isFinite` is false for undefined, null, NaN, +/-Infinity, and
    // any non-number (a string, or anything slipping past TypeScript from test/ or an untyped
    // JS caller of this published package); a negative or zero value is finite but still
    // garbage. Any of those falls back to the default rather than clamping to 0 —
    // `AbortSignal.timeout(0)` fires within a macrotask, so a garbage config must not
    // silently become "always times out".
    const DEFAULT_ATTEMPT_TIMEOUT_MS = 5_000;
    // Capped at 2^31-1 (Node's TIMEOUT_MAX), stricter than AbortSignal's own 2^32-1: delays
    // above 2^31-1 don't throw, they collapse to a 1 ms timer with a TimeoutOverflowWarning
    // (measured) — silently the dead-channel bug again.
    const MAX_ATTEMPT_TIMEOUT_MS = 2_147_483_647;
    const requested = this.opts.attemptTimeoutMs;
    const delayMs =
      Number.isFinite(requested) && (requested as number) > 0
        ? Math.trunc(Math.min(requested as number, MAX_ATTEMPT_TIMEOUT_MS))
        : DEFAULT_ATTEMPT_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(delayMs);
    // NOTE: AbortSignal.any sits before the try — an untyped caller passing a non-AbortSignal
    // would throw a TypeError out of emit (same escape-the-guarded-region shape slice A guarded
    // elsewhere). Unreachable from typed callers (only slice C passes opts.signal). Leave this
    // comment as the record.
    const signal = opts?.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(this.opts.callbackUrl, {
        method: 'POST',
        headers,
        body: payload,
        signal,
      });
      return res.status >= 200 && res.status < 300
        ? { delivered: true, status: res.status }
        : { delivered: false, status: res.status, reason: 'http-status' };
    } catch {
      // Classify on the INTERNAL timeout signal, not the composed one: an external abort
      // (slice C) must not read as 'timeout'. A hand-rolled mock rejecting with
      // new Error('aborted') must not be able to pin the wrong branch either.
      return { delivered: false, reason: timeout.aborted ? 'timeout' : 'network' };
    }
  }
}
