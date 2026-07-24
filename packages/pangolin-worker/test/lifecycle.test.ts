import { describe, it, expect, vi, afterEach } from 'vitest';
import { LifecycleEmitter } from '../src/lifecycle.js';
import type { LifecycleEvent } from '@quarry-systems/pangolin-core';
import { createHmac } from 'node:crypto';

function computeSignature(
  hmacKey: string,
  dispatchId: string,
  timestamp: string,
  payload: string,
): string {
  const message = `${dispatchId}.${timestamp}.${payload}`;
  return createHmac('sha256', hmacKey).update(message).digest('hex');
}

describe('LifecycleEmitter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('emit', () => {
    it('is a no-op when callbackUrl is unset', async () => {
      const mockFetch = vi.fn();
      const emitter = new LifecycleEmitter({
        hmacKey: 'test-key',
        fetchImpl: mockFetch,
      });

      const event: LifecycleEvent = {
        kind: 'dispatch.accepted',
        dispatchId: 'd-123',
        target: 'test-target',
        resolved: [],
        at: '2026-05-21T12:00:00Z',
      };

      const outcome = await emitter.emit(event);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(outcome).toEqual({ delivered: false });
    });

    it('is a no-op when hmacKey is unset', async () => {
      const mockFetch = vi.fn();
      const emitter = new LifecycleEmitter({
        callbackUrl: 'https://example.com/callback',
        fetchImpl: mockFetch,
      });

      const event: LifecycleEvent = {
        kind: 'dispatch.accepted',
        dispatchId: 'd-123',
        target: 'test-target',
        resolved: [],
        at: '2026-05-21T12:00:00Z',
      };

      const outcome = await emitter.emit(event);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(outcome).toEqual({ delivered: false });
    });

    it('POSTs to callbackUrl with HMAC signature headers', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
      const callbackUrl = 'https://example.com/callback';
      const hmacKey = 'my-secret-key';
      const dispatchId = 'd-456';

      const emitter = new LifecycleEmitter({
        callbackUrl,
        hmacKey,
        fetchImpl: mockFetch as unknown as typeof fetch,
      });

      const event: LifecycleEvent = {
        kind: 'dispatch.started',
        dispatchId,
        providerTaskId: 'provider-789',
        at: '2026-05-21T12:00:00Z',
      };

      const outcome = await emitter.emit(event);

      expect(mockFetch).toHaveBeenCalledOnce();
      expect(outcome).toEqual({ delivered: true, status: 200 });
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(callbackUrl);
      expect(opts.method).toBe('POST');
      expect(opts.headers['Content-Type']).toBe('application/json');
      expect(opts.headers['X-Pangolin-Dispatch-Id']).toBe(dispatchId);
      expect(opts.headers['X-Pangolin-Timestamp']).toBeDefined();
      expect(opts.headers['X-Pangolin-Signature']).toBeDefined();

      const payload = opts.body;
      const signature = opts.headers['X-Pangolin-Signature'];
      const timestamp = opts.headers['X-Pangolin-Timestamp'];

      // Verify HMAC matches expected scheme
      const expectedSig = `sha256=${computeSignature(hmacKey, dispatchId, timestamp, payload)}`;
      expect(signature).toBe(expectedSig);
    });

    it('uses ISO timestamp from header for signature computation', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
      const hmacKey = 'test-key';
      const dispatchId = 'd-789';

      const emitter = new LifecycleEmitter({
        callbackUrl: 'https://example.com/callback',
        hmacKey,
        fetchImpl: mockFetch as unknown as typeof fetch,
      });

      const event: LifecycleEvent = {
        kind: 'dispatch.finished',
        dispatchId,
        exitCode: 0,
        durationMs: 1000,
        at: '2026-05-21T12:00:00Z',
      };

      await emitter.emit(event);

      const [, opts] = mockFetch.mock.calls[0];
      const payload = opts.body;
      const signature = opts.headers['X-Pangolin-Signature'];
      const timestamp = opts.headers['X-Pangolin-Timestamp'];

      // Manually recompute signature to verify it matches the header
      const manualSig = computeSignature(hmacKey, dispatchId, timestamp, payload);
      expect(signature).toBe(`sha256=${manualSig}`);
    });

    it('includes all event types in POST body as JSON', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));

      const emitter = new LifecycleEmitter({
        callbackUrl: 'https://example.com/callback',
        hmacKey: 'key',
        fetchImpl: mockFetch as unknown as typeof fetch,
      });

      const event: LifecycleEvent = {
        kind: 'dispatch.failed',
        dispatchId: 'd-999',
        reason: 'Out of memory',
        at: '2026-05-21T12:00:00Z',
      };

      await emitter.emit(event);

      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body);

      expect(body).toEqual(event);
    });

    it('sends header names that are valid HTTP field names', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
      const emitter = new LifecycleEmitter({
        callbackUrl: 'https://example.com/callback',
        hmacKey: 'k',
        fetchImpl: mockFetch as unknown as typeof fetch,
      });
      const event: LifecycleEvent = {
        kind: 'dispatch.started',
        dispatchId: 'd-1',
        providerTaskId: 'p-1',
        at: '2026-05-21T12:00:00Z',
      };
      await emitter.emit(event);

      const [, init] = mockFetch.mock.calls[0]!;
      // Fails by ASSERTION on main: expect(fn).not.toThrow() catches the TypeError and converts
      // it to an AssertionError. Stays live after the fix because production passes a plain object.
      let headers!: Headers;
      expect(() => {
        headers = new Headers(init.headers as HeadersInit);
      }).not.toThrow();
      // Positive control — keeps .not.toThrow() from passing vacuously.
      expect([...headers.keys()].sort()).toEqual([
        'content-type',
        'x-pangolin-dispatch-id',
        'x-pangolin-signature',
        'x-pangolin-timestamp',
      ]);
    });

    it('adds Authorization: Bearer when bearerToken is configured', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
      const emitter = new LifecycleEmitter({
        callbackUrl: 'https://example.com/callback',
        hmacKey: 'k',
        fetchImpl: mockFetch as unknown as typeof fetch,
        bearerToken: 'T0KEN',
      });
      const event: LifecycleEvent = {
        kind: 'dispatch.started',
        dispatchId: 'd-1',
        providerTaskId: 'p-1',
        at: '2026-05-21T12:00:00Z',
      };
      await emitter.emit(event);

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer T0KEN');
    });

    it('omits Authorization when no bearerToken is configured', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
      const emitter = new LifecycleEmitter({
        callbackUrl: 'https://example.com/callback',
        hmacKey: 'k',
        fetchImpl: mockFetch as unknown as typeof fetch,
      });
      const event: LifecycleEvent = {
        kind: 'dispatch.started',
        dispatchId: 'd-1',
        providerTaskId: 'p-1',
        at: '2026-05-21T12:00:00Z',
      };
      await emitter.emit(event);

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBeUndefined();
    });

    it('computes the HMAC signature identically whether or not bearerToken is set (bearer is admission, HMAC is integrity — independent)', async () => {
      const hmacKey = 'shared-key';
      const dispatchId = 'd-independent';
      const event: LifecycleEvent = {
        kind: 'dispatch.started',
        dispatchId,
        providerTaskId: 'p-1',
        at: '2026-05-21T12:00:00Z',
      };

      const withBearerFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
      const withBearerEmitter = new LifecycleEmitter({
        callbackUrl: 'https://example.com/callback',
        hmacKey,
        fetchImpl: withBearerFetch as unknown as typeof fetch,
        bearerToken: 'T0KEN',
      });
      await withBearerEmitter.emit(event);
      const [, withBearerInit] = withBearerFetch.mock.calls[0]!;
      const withBearerHeaders = withBearerInit.headers as Record<string, string>;

      const withoutBearerFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
      const withoutBearerEmitter = new LifecycleEmitter({
        callbackUrl: 'https://example.com/callback',
        hmacKey,
        fetchImpl: withoutBearerFetch as unknown as typeof fetch,
      });
      await withoutBearerEmitter.emit(event);
      const [, withoutBearerInit] = withoutBearerFetch.mock.calls[0]!;
      const withoutBearerHeaders = withoutBearerInit.headers as Record<string, string>;

      // Recompute each signature locally from its own request's timestamp/payload/dispatchId,
      // proving the presence of bearerToken does not perturb the HMAC — not just that the two
      // captured signatures happen to match (which a shared-clock coincidence could also produce).
      const withBearerExpected = `sha256=${computeSignature(
        hmacKey,
        dispatchId,
        withBearerHeaders['X-Pangolin-Timestamp'],
        withBearerInit.body as string,
      )}`;
      const withoutBearerExpected = `sha256=${computeSignature(
        hmacKey,
        dispatchId,
        withoutBearerHeaders['X-Pangolin-Timestamp'],
        withoutBearerInit.body as string,
      )}`;
      expect(withBearerHeaders['X-Pangolin-Signature']).toBe(withBearerExpected);
      expect(withoutBearerHeaders['X-Pangolin-Signature']).toBe(withoutBearerExpected);
    });

    it('reports a non-2xx (500) as an http-status failure', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }));
      const emitter = new LifecycleEmitter({
        callbackUrl: 'https://example.com/callback',
        hmacKey: 'k',
        fetchImpl: mockFetch as unknown as typeof fetch,
      });
      const event: LifecycleEvent = {
        kind: 'dispatch.started',
        dispatchId: 'd-1',
        providerTaskId: 'p-1',
        at: '2026-05-21T12:00:00Z',
      };
      const outcome = await emitter.emit(event);
      // Asserting the OBJECT is what discriminates: on main this is `undefined` vs an object,
      // an assertion failure. A toHaveBeenCalledOnce() check would be GREEN on main.
      expect(outcome).toEqual({ delivered: false, status: 500, reason: 'http-status' });
    });

    it('reports a non-2xx (403) as an http-status failure with matching status', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 }));
      const emitter = new LifecycleEmitter({
        callbackUrl: 'https://example.com/callback',
        hmacKey: 'k',
        fetchImpl: mockFetch as unknown as typeof fetch,
      });
      const event: LifecycleEvent = {
        kind: 'dispatch.started',
        dispatchId: 'd-1',
        providerTaskId: 'p-1',
        at: '2026-05-21T12:00:00Z',
      };
      const outcome = await emitter.emit(event);
      expect(outcome).toEqual({ delivered: false, status: 403, reason: 'http-status' });
    });

    it('reports a rejecting fetch as a network failure with no status key', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('connection refused'));
      const emitter = new LifecycleEmitter({
        callbackUrl: 'https://example.com/callback',
        hmacKey: 'k',
        fetchImpl: mockFetch as unknown as typeof fetch,
      });
      const event: LifecycleEvent = {
        kind: 'dispatch.started',
        dispatchId: 'd-1',
        providerTaskId: 'p-1',
        at: '2026-05-21T12:00:00Z',
      };
      const outcome = await emitter.emit(event);
      expect(outcome).toStrictEqual({ delivered: false, reason: 'network' });
      expect(outcome).not.toHaveProperty('status');
    });

    it('applies no kind-dependent branching: dispatch.started, dispatch.accepted, and a terminal kind all yield the identical http-status outcome against a 500 mock', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }));
      const emitter = new LifecycleEmitter({
        callbackUrl: 'https://example.com/callback',
        hmacKey: 'k',
        fetchImpl: mockFetch as unknown as typeof fetch,
      });

      const started: LifecycleEvent = {
        kind: 'dispatch.started',
        dispatchId: 'd-1',
        providerTaskId: 'p-1',
        at: '2026-05-21T12:00:00Z',
      };
      const accepted: LifecycleEvent = {
        kind: 'dispatch.accepted',
        dispatchId: 'd-2',
        target: 't',
        resolved: [],
        at: '2026-05-21T12:00:00Z',
      };
      const finished: LifecycleEvent = {
        kind: 'dispatch.finished',
        dispatchId: 'd-3',
        exitCode: 0,
        durationMs: 1,
        at: '2026-05-21T12:00:00Z',
      };

      const startedOutcome = await emitter.emit(started);
      const acceptedOutcome = await emitter.emit(accepted);
      const finishedOutcome = await emitter.emit(finished);

      expect(startedOutcome).toEqual({ delivered: false, status: 500, reason: 'http-status' });
      expect(acceptedOutcome).toEqual({ delivered: false, status: 500, reason: 'http-status' });
      expect(finishedOutcome).toEqual({ delivered: false, status: 500, reason: 'http-status' });
    });

    it('carries an AbortSignal on the fetch init and classifies a timeout on abort', async () => {
      const mockFetch = vi.fn((_url: string, init: RequestInit) => {
        const signal = init.signal as AbortSignal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('the operation was aborted'));
          });
        });
      });
      const emitter = new LifecycleEmitter({
        callbackUrl: 'https://example.com/callback',
        hmacKey: 'k',
        fetchImpl: mockFetch as unknown as typeof fetch,
        attemptTimeoutMs: 10,
      });
      const event: LifecycleEvent = {
        kind: 'dispatch.started',
        dispatchId: 'd-1',
        providerTaskId: 'p-1',
        at: '2026-05-21T12:00:00Z',
      };
      const outcome = await emitter.emit(event);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, init] = mockFetch.mock.calls[0]!;
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(outcome).toEqual({ delivered: false, reason: 'timeout' });
    });

    it.each([NaN, 5.5, Infinity, 2 ** 32, Number.MAX_SAFE_INTEGER])(
      'does not throw when attemptTimeoutMs is %s',
      async (attemptTimeoutMs) => {
        const mockFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
        const emitter = new LifecycleEmitter({
          callbackUrl: 'https://example.com/callback',
          hmacKey: 'k',
          fetchImpl: mockFetch as unknown as typeof fetch,
          attemptTimeoutMs,
        });
        const event: LifecycleEvent = {
          kind: 'dispatch.started',
          dispatchId: 'd-1',
          providerTaskId: 'p-1',
          at: '2026-05-21T12:00:00Z',
        };

        await expect(emitter.emit(event)).resolves.toEqual({ delivered: true, status: 200 });
      },
    );

    it('falls back to the default timeout instead of aborting when attemptTimeoutMs is negative', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
      const emitter = new LifecycleEmitter({
        callbackUrl: 'https://example.com/callback',
        hmacKey: 'k',
        fetchImpl: mockFetch as unknown as typeof fetch,
        attemptTimeoutMs: -1,
      });
      const event: LifecycleEvent = {
        kind: 'dispatch.started',
        dispatchId: 'd-1',
        providerTaskId: 'p-1',
        at: '2026-05-21T12:00:00Z',
      };

      const outcome = await emitter.emit(event);
      expect(outcome).toEqual({ delivered: true, status: 200 });

      const [, init] = mockFetch.mock.calls[0]!;
      const signal = init.signal as AbortSignal;
      // Yield to the macrotask queue: a 0 ms AbortSignal.timeout fires on the next
      // macrotask tick, which discriminates it from the 5 s default (which cannot have
      // fired yet). A resolving mock plus this check is wall-clock-free and still proves
      // -1 did not collapse to an instant abort.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(signal.aborted).toBe(false);
    });

    it('classifies on the signal, not the error message: an abort-worded rejection with no abort is a network failure', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('The operation was aborted'));
      const emitter = new LifecycleEmitter({
        callbackUrl: 'https://example.com/callback',
        hmacKey: 'k',
        fetchImpl: mockFetch as unknown as typeof fetch,
        attemptTimeoutMs: 5_000, // long enough that the signal cannot have fired
      });
      const event: LifecycleEvent = {
        kind: 'dispatch.started',
        dispatchId: 'd-1',
        providerTaskId: 'p-1',
        at: '2026-05-21T12:00:00Z',
      };
      await expect(emitter.emit(event)).resolves.toStrictEqual({
        delivered: false,
        reason: 'network',
      });
    });

    it.each([
      [204, true],
      [299, true],
      [300, false],
      [199, false],
    ])('status %i is delivered=%s', async (status, delivered) => {
      // A plain object, not `new Response(...)`: the Fetch API's Response constructor
      // rejects status codes outside 200-599 and disallows a body on 204, so it cannot
      // represent 199 or a bodyless 204 — but the emitter only reads `res.status`.
      const mockFetch = vi.fn().mockResolvedValue({ status } as unknown as Response);
      const emitter = new LifecycleEmitter({
        callbackUrl: 'https://example.com/callback',
        hmacKey: 'k',
        fetchImpl: mockFetch as unknown as typeof fetch,
      });
      const event: LifecycleEvent = {
        kind: 'dispatch.started',
        dispatchId: 'd-1',
        providerTaskId: 'p-1',
        at: '2026-05-21T12:00:00Z',
      };
      const outcome = await emitter.emit(event);
      expect(outcome).toEqual(
        delivered
          ? { delivered: true, status }
          : { delivered: false, status, reason: 'http-status' },
      );
    });

    it('aborts the in-flight fetch when the external signal fires', async () => {
      const ac = new AbortController();
      const mockFetch = vi.fn((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          (init.signal as AbortSignal).addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
          ac.abort();
        });
      });
      const emitter = new LifecycleEmitter({
        callbackUrl: 'https://example.com/callback',
        hmacKey: 'k',
        fetchImpl: mockFetch as unknown as typeof fetch,
      });
      const event: LifecycleEvent = {
        kind: 'dispatch.started',
        dispatchId: 'd-1',
        providerTaskId: 'p-1',
        at: '2026-05-21T12:00:00Z',
      };

      const outcome = await emitter.emit(event, { signal: ac.signal });

      expect(outcome).toEqual({ delivered: false, reason: 'network' });
    });

    it('still classifies the internal deadline as timeout when no external signal is passed', async () => {
      const mockFetch = vi.fn((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          (init.signal as AbortSignal).addEventListener('abort', () => {
            reject(new Error('t'));
          });
        });
      });
      const emitter = new LifecycleEmitter({
        callbackUrl: 'https://example.com/callback',
        hmacKey: 'k',
        fetchImpl: mockFetch as unknown as typeof fetch,
        attemptTimeoutMs: 20,
      });
      const event: LifecycleEvent = {
        kind: 'dispatch.started',
        dispatchId: 'd-1',
        providerTaskId: 'p-1',
        at: '2026-05-21T12:00:00Z',
      };

      const outcome = await emitter.emit(event);

      expect(outcome.reason).toBe('timeout');
    });
  });
});
