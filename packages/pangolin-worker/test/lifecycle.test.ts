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

      await emitter.emit(event);

      expect(mockFetch).not.toHaveBeenCalled();
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

      await emitter.emit(event);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('POSTs to callbackUrl with HMAC signature headers', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      const callbackUrl = 'https://example.com/callback';
      const hmacKey = 'my-secret-key';
      const dispatchId = 'd-456';

      const emitter = new LifecycleEmitter({
        callbackUrl,
        hmacKey,
        fetchImpl: mockFetch,
      });

      const event: LifecycleEvent = {
        kind: 'dispatch.started',
        dispatchId,
        providerTaskId: 'provider-789',
        at: '2026-05-21T12:00:00Z',
      };

      await emitter.emit(event);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(callbackUrl);
      expect(opts.method).toBe('POST');
      expect(opts.headers['Content-Type']).toBe('application/json');
      expect(opts.headers['X-Pangolin Scale-Dispatch-Id']).toBe(dispatchId);
      expect(opts.headers['X-Pangolin Scale-Timestamp']).toBeDefined();
      expect(opts.headers['X-Pangolin Scale-Signature']).toBeDefined();

      const payload = opts.body;
      const signature = opts.headers['X-Pangolin Scale-Signature'];
      const timestamp = opts.headers['X-Pangolin Scale-Timestamp'];

      // Verify HMAC matches expected scheme
      const expectedSig = `sha256=${computeSignature(hmacKey, dispatchId, timestamp, payload)}`;
      expect(signature).toBe(expectedSig);
    });

    it('uses ISO timestamp from header for signature computation', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      const hmacKey = 'test-key';
      const dispatchId = 'd-789';

      const emitter = new LifecycleEmitter({
        callbackUrl: 'https://example.com/callback',
        hmacKey,
        fetchImpl: mockFetch,
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
      const signature = opts.headers['X-Pangolin Scale-Signature'];
      const timestamp = opts.headers['X-Pangolin Scale-Timestamp'];

      // Manually recompute signature to verify it matches the header
      const manualSig = computeSignature(hmacKey, dispatchId, timestamp, payload);
      expect(signature).toBe(`sha256=${manualSig}`);
    });

    it('includes all event types in POST body as JSON', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });

      const emitter = new LifecycleEmitter({
        callbackUrl: 'https://example.com/callback',
        hmacKey: 'key',
        fetchImpl: mockFetch,
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
  });
});
