import { describe, it, expect, vi, afterEach } from 'vitest';
import { LifecycleEmitter } from '../src/lifecycle.js';
import type { LifecycleEvent } from '@quarry-systems/pangolin-core';
import { createHmac } from 'node:crypto';

function computeSignature(hmacKey: string, dispatchId: string, timestamp: string, payload: string): string {
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
        kind: 'dispatch.started', dispatchId: 'd-1', providerTaskId: 'p-1', at: '2026-05-21T12:00:00Z',
      };
      await emitter.emit(event);

      const [, init] = mockFetch.mock.calls[0]!;
      // Fails by ASSERTION on main: expect(fn).not.toThrow() catches the TypeError and converts
      // it to an AssertionError. Stays live after the fix because production passes a plain object.
      let headers!: Headers;
      expect(() => { headers = new Headers(init.headers as HeadersInit); }).not.toThrow();
      // Positive control — keeps .not.toThrow() from passing vacuously.
      expect([...headers.keys()].sort()).toEqual([
        'content-type', 'x-pangolin-dispatch-id', 'x-pangolin-signature', 'x-pangolin-timestamp',
      ]);
    });

    it('reports a non-2xx (500) as an http-status failure', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }));
      const emitter = new LifecycleEmitter({
        callbackUrl: 'https://example.com/callback',
        hmacKey: 'k',
        fetchImpl: mockFetch as unknown as typeof fetch,
      });
      const event: LifecycleEvent = {
        kind: 'dispatch.started', dispatchId: 'd-1', providerTaskId: 'p-1', at: '2026-05-21T12:00:00Z',
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
        kind: 'dispatch.started', dispatchId: 'd-1', providerTaskId: 'p-1', at: '2026-05-21T12:00:00Z',
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
        kind: 'dispatch.started', dispatchId: 'd-1', providerTaskId: 'p-1', at: '2026-05-21T12:00:00Z',
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
        kind: 'dispatch.started', dispatchId: 'd-1', providerTaskId: 'p-1', at: '2026-05-21T12:00:00Z',
      };
      const accepted: LifecycleEvent = {
        kind: 'dispatch.accepted', dispatchId: 'd-2', target: 't', resolved: [], at: '2026-05-21T12:00:00Z',
      };
      const finished: LifecycleEvent = {
        kind: 'dispatch.finished', dispatchId: 'd-3', exitCode: 0, durationMs: 1, at: '2026-05-21T12:00:00Z',
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
        kind: 'dispatch.started', dispatchId: 'd-1', providerTaskId: 'p-1', at: '2026-05-21T12:00:00Z',
      };
      const outcome = await emitter.emit(event);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, init] = mockFetch.mock.calls[0]!;
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(outcome).toEqual({ delivered: false, reason: 'timeout' });
    });

    it.each([-1, NaN, 5.5])(
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
          kind: 'dispatch.started', dispatchId: 'd-1', providerTaskId: 'p-1', at: '2026-05-21T12:00:00Z',
        };

        await expect(emitter.emit(event)).resolves.toEqual({ delivered: true, status: 200 });
      },
    );
  });
});
