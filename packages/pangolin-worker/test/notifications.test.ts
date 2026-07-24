import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { loadCapabilityNotifications, fireNotifications } from '../src/notifications.js';
import type { LifecycleEvent, NotificationConfig } from '@quarry-systems/pangolin-core';

function computeSignature(
  hmacKey: string,
  dispatchId: string,
  timestamp: string,
  payload: string,
): string {
  const message = `${dispatchId}.${timestamp}.${payload}`;
  return createHmac('sha256', hmacKey).update(message).digest('hex');
}

describe('loadCapabilityNotifications', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'notifications-work-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('returns [] when pangolin-notifications.json is absent', async () => {
    const result = await loadCapabilityNotifications(workDir);
    expect(result).toEqual([]);
  });

  it('returns the parsed notification configs when file is present', async () => {
    const configs: NotificationConfig[] = [
      { when: ['dispatch.finished'], webhook: 'https://example.com/a' },
      {
        when: ['dispatch.failed', 'dispatch.cancelled'],
        webhook: 'https://example.com/b',
      },
    ];
    await writeFile(join(workDir, 'pangolin-notifications.json'), JSON.stringify(configs), 'utf-8');

    const result = await loadCapabilityNotifications(workDir);
    expect(result).toEqual(configs);
  });
});

describe('fireNotifications', () => {
  function makeFinishedEvent(): LifecycleEvent {
    return {
      kind: 'dispatch.finished',
      dispatchId: 'd-100',
      exitCode: 0,
      durationMs: 500,
      at: '2026-05-21T12:00:00Z',
    };
  }

  it('does not fire when no config matches the event kind', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response('ok');
    }) as unknown as typeof fetch;

    const sources: NotificationConfig[][] = [
      [{ when: ['dispatch.failed'], webhook: 'https://example.com/x' }],
    ];

    const outcomes = await fireNotifications({
      event: makeFinishedEvent(),
      sources,
      hmacKey: 'k',
      fetchImpl,
    });

    expect(calls).toHaveLength(0);
    expect(outcomes).toEqual([]);
  });

  it('POSTs to every matching webhook across all sources', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response('ok');
    }) as unknown as typeof fetch;

    const sources: NotificationConfig[][] = [
      // capability-content notifications
      [{ when: ['dispatch.finished'], webhook: 'https://example.com/cap' }],
      // dispatch-level notifications
      [
        { when: ['dispatch.finished'], webhook: 'https://example.com/dispatch' },
        { when: ['dispatch.failed'], webhook: 'https://example.com/never' },
      ],
    ];

    const outcomes = await fireNotifications({
      event: makeFinishedEvent(),
      sources,
      hmacKey: 'k',
      fetchImpl,
    });

    expect(calls).toHaveLength(2);
    const urls = calls.map(([url]) => url).sort();
    expect(urls).toEqual(['https://example.com/cap', 'https://example.com/dispatch']);
    expect(outcomes).toEqual([
      { label: 'https://example.com', delivered: true, status: 200 },
      { label: 'https://example.com', delivered: true, status: 200 },
    ]);
  });

  it('filters by when.includes(event.kind)', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response('ok');
    }) as unknown as typeof fetch;

    const sources: NotificationConfig[][] = [
      [
        { when: ['dispatch.finished', 'dispatch.failed'], webhook: 'https://example.com/multi' },
        { when: ['dispatch.cancelled'], webhook: 'https://example.com/skip' },
      ],
    ];

    await fireNotifications({
      event: makeFinishedEvent(),
      sources,
      hmacKey: 'k',
      fetchImpl,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe('https://example.com/multi');
  });

  it('signs the POST with HMAC matching signCallback scheme, using corrected header names as a plain object', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response('ok');
    }) as unknown as typeof fetch;

    const hmacKey = 'my-test-key';
    const event = makeFinishedEvent();
    const sources: NotificationConfig[][] = [
      [{ when: ['dispatch.finished'], webhook: 'https://example.com/sig' }],
    ];

    await fireNotifications({ event, sources, hmacKey, fetchImpl });

    expect(calls).toHaveLength(1);
    const [, init] = calls[0]!;

    // Plain object invariant: constructing a real Headers from whatever production passed
    // must not throw, and the key set (once normalized by Headers) is exactly the four
    // expected names.
    let headers!: Headers;
    expect(() => {
      headers = new Headers(init.headers as HeadersInit);
    }).not.toThrow();
    expect([...headers.keys()].sort()).toEqual([
      'content-type',
      'x-pangolin-dispatch-id',
      'x-pangolin-signature',
      'x-pangolin-timestamp',
    ]);

    expect(init.method).toBe('POST');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('X-Pangolin-Dispatch-Id')).toBe(event.dispatchId);
    expect(headers.get('X-Pangolin-Timestamp')).toBeDefined();

    const timestamp = headers.get('X-Pangolin-Timestamp')!;
    const payload = init.body as string;
    const expectedSig = `sha256=${computeSignature(hmacKey, event.dispatchId, timestamp, payload)}`;
    expect(headers.get('X-Pangolin-Signature')).toBe(expectedSig);

    // Body is the full event as JSON
    expect(JSON.parse(payload)).toEqual(event);
  });

  it('fires in parallel and does not let one failure block others', async () => {
    const completed: string[] = [];
    const fetchImpl = (async (url: string) => {
      if (url === 'https://example.com/fail') {
        throw new Error('network down');
      }
      // Small delay so we can observe that failure does not abort parallel calls
      await new Promise((resolve) => setTimeout(resolve, 5));
      completed.push(url);
      return new Response('ok');
    }) as unknown as typeof fetch;

    const sources: NotificationConfig[][] = [
      [
        { when: ['dispatch.finished'], webhook: 'https://example.com/fail' },
        { when: ['dispatch.finished'], webhook: 'https://example.com/ok1' },
        { when: ['dispatch.finished'], webhook: 'https://example.com/ok2' },
      ],
    ];

    // Must not throw, even though one webhook fails
    const outcomes = await fireNotifications({
      event: makeFinishedEvent(),
      sources,
      hmacKey: 'k',
      fetchImpl,
    });

    expect(completed.sort()).toEqual(['https://example.com/ok1', 'https://example.com/ok2']);
    expect(outcomes).toEqual([
      { label: 'https://example.com', delivered: false, reason: 'network' },
      { label: 'https://example.com', delivered: true, status: 200 },
      { label: 'https://example.com', delivered: true, status: 200 },
    ]);
  });

  it('returns [] and never reaches fetch when fetchImpl is omitted and no config matches', async () => {
    // Retitled from "uses the global fetch when fetchImpl is not supplied": with zero
    // matching configs, fetch (global or injected) is never called — this test only
    // proves the omitted-fetchImpl call shape resolves to [] without throwing.
    await expect(
      fireNotifications({
        event: makeFinishedEvent(),
        sources: [[{ when: ['dispatch.failed'], webhook: 'https://example.com/x' }]],
        hmacKey: 'k',
      }),
    ).resolves.toEqual([]);
  });

  it('handles empty sources array', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response('ok');
    }) as unknown as typeof fetch;

    const outcomes = await fireNotifications({
      event: makeFinishedEvent(),
      sources: [],
      hmacKey: 'k',
      fetchImpl,
    });

    expect(calls).toHaveLength(0);
    expect(outcomes).toEqual([]);
  });

  it('reports a 500-returning endpoint as failed rather than settled-ok', async () => {
    const fetchImpl = (async (url: string) =>
      url.endsWith('/dead')
        ? new Response('nope', { status: 500 })
        : new Response('ok', { status: 200 })) as unknown as typeof fetch;

    const outcomes = await fireNotifications({
      event: makeFinishedEvent(),
      sources: [
        [
          { when: ['dispatch.finished'], webhook: 'https://a.example.com/dead' },
          { when: ['dispatch.finished'], webhook: 'https://b.example.com/ok' },
        ],
      ],
      hmacKey: 'k',
      fetchImpl,
    });

    expect(outcomes).toEqual([
      { label: 'https://a.example.com', delivered: false, status: 500, reason: 'http-status' },
      { label: 'https://b.example.com', delivered: true, status: 200 },
    ]);
  });

  it('reports a rejecting fetch as a network failure', async () => {
    const fetchImpl = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;

    const outcomes = await fireNotifications({
      event: makeFinishedEvent(),
      sources: [[{ when: ['dispatch.finished'], webhook: 'https://example.com/x' }]],
      hmacKey: 'k',
      fetchImpl,
    });

    expect(outcomes).toEqual([
      { label: 'https://example.com', delivered: false, reason: 'network' },
    ]);
  });

  it('hands each fetch its own AbortSignal, proved by identity not timing', async () => {
    const signals: unknown[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      signals.push(init.signal);
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    await fireNotifications({
      event: makeFinishedEvent(),
      sources: [
        [
          { when: ['dispatch.finished'], webhook: 'https://a.example.com/x' },
          { when: ['dispatch.finished'], webhook: 'https://b.example.com/y' },
        ],
      ],
      hmacKey: 'k',
      fetchImpl,
    });

    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).toBeInstanceOf(AbortSignal);
    expect(signals[0]).not.toBe(signals[1]);
  });

  it('classifies a timeout on abort, distinct from an immediately-resolving sibling', async () => {
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (url.endsWith('/slow')) {
        const signal = init.signal as AbortSignal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('the operation was aborted'));
          });
        });
      }
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    const outcomes = await fireNotifications({
      event: makeFinishedEvent(),
      sources: [
        [
          { when: ['dispatch.finished'], webhook: 'https://a.example.com/slow' },
          { when: ['dispatch.finished'], webhook: 'https://b.example.com/fast' },
        ],
      ],
      hmacKey: 'k',
      fetchImpl,
      attemptTimeoutMs: 20,
    });

    expect(outcomes).toEqual([
      { label: 'https://a.example.com', delivered: false, reason: 'timeout' },
      { label: 'https://b.example.com', delivered: true, status: 200 },
    ]);
  });

  it('classifies on the signal, not the error message: an abort-worded rejection with no abort is a network failure', async () => {
    const fetchImpl = (async () => {
      throw new Error('The operation was aborted');
    }) as unknown as typeof fetch;

    const outcomes = await fireNotifications({
      event: makeFinishedEvent(),
      sources: [[{ when: ['dispatch.finished'], webhook: 'https://example.com/x' }]],
      hmacKey: 'k',
      fetchImpl,
      attemptTimeoutMs: 5_000, // long enough that the signal cannot have fired
    });

    expect(outcomes).toEqual([
      { label: 'https://example.com', delivered: false, reason: 'network' },
    ]);
  });

  it.each([NaN, 5.5, Infinity, 2 ** 32, Number.MAX_SAFE_INTEGER, -1, 0, 'garbage'])(
    'does not throw for attemptTimeoutMs = %s',
    async (attemptTimeoutMs) => {
      const fetchImpl = (async () =>
        new Response('ok', { status: 200 })) as unknown as typeof fetch;

      await expect(
        fireNotifications({
          event: makeFinishedEvent(),
          sources: [[{ when: ['dispatch.finished'], webhook: 'https://example.com/x' }]],
          hmacKey: 'k',
          fetchImpl,
          attemptTimeoutMs: attemptTimeoutMs as unknown as number,
        }),
      ).resolves.toEqual([{ label: 'https://example.com', delivered: true, status: 200 }]);
    },
  );

  it('does not throw out of fireNotifications when fetchImpl throws synchronously', async () => {
    const fetchImpl = (() => {
      throw new Error('sync boom');
    }) as unknown as typeof fetch;

    const outcomes = await fireNotifications({
      event: makeFinishedEvent(),
      sources: [[{ when: ['dispatch.finished'], webhook: 'https://a.example.com/x' }]],
      hmacKey: 'k',
      fetchImpl,
    });

    expect(outcomes).toEqual([
      { label: 'https://a.example.com', delivered: false, reason: 'network' },
    ]);
  });

  it('label never contains the raw webhook URL, even when it carries userinfo and a query token', async () => {
    const fetchImpl = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;

    const rawWebhook = 'https://user:secret@example.com/hook?token=abc123';
    const outcomes = await fireNotifications({
      event: makeFinishedEvent(),
      sources: [[{ when: ['dispatch.finished'], webhook: rawWebhook }]],
      hmacKey: 'k',
      fetchImpl,
    });

    expect(outcomes).toHaveLength(1);
    const [outcome] = outcomes;
    expect(outcome!.label).not.toContain('secret');
    expect(outcome!.label).not.toContain('abc123');
    expect(outcome!.label).toBe('https://example.com');
  });
});
