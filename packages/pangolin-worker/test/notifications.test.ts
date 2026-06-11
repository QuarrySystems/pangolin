import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import {
  loadCapabilityNotifications,
  fireNotifications,
} from '../src/notifications.js';
import type {
  LifecycleEvent,
  NotificationConfig,
} from '@quarry-systems/pangolin-core';

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
    await writeFile(
      join(workDir, 'pangolin-notifications.json'),
      JSON.stringify(configs),
      'utf-8',
    );

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

    await fireNotifications({
      event: makeFinishedEvent(),
      sources,
      hmacKey: 'k',
      fetchImpl,
    });

    expect(calls).toHaveLength(0);
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

    await fireNotifications({
      event: makeFinishedEvent(),
      sources,
      hmacKey: 'k',
      fetchImpl,
    });

    expect(calls).toHaveLength(2);
    const urls = calls.map(([url]) => url).sort();
    expect(urls).toEqual([
      'https://example.com/cap',
      'https://example.com/dispatch',
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

  it('signs the POST with HMAC matching signCallback scheme', async () => {
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
    const headers = init.headers as Record<string, string>;
    expect(init.method).toBe('POST');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Pangolin Scale-Dispatch-Id']).toBe(event.dispatchId);
    expect(headers['X-Pangolin Scale-Timestamp']).toBeDefined();

    const timestamp = headers['X-Pangolin Scale-Timestamp']!;
    const payload = init.body as string;
    const expectedSig = `sha256=${computeSignature(hmacKey, event.dispatchId, timestamp, payload)}`;
    expect(headers['X-Pangolin Scale-Signature']).toBe(expectedSig);

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
    await fireNotifications({
      event: makeFinishedEvent(),
      sources,
      hmacKey: 'k',
      fetchImpl,
    });

    expect(completed.sort()).toEqual([
      'https://example.com/ok1',
      'https://example.com/ok2',
    ]);
  });

  it('uses the global fetch when fetchImpl is not supplied', async () => {
    // We can't easily call real network; instead verify the function accepts
    // omitted fetchImpl without throwing at type-time / call-time when there
    // are no matching configs (so no network actually happens).
    await expect(
      fireNotifications({
        event: makeFinishedEvent(),
        sources: [[{ when: ['dispatch.failed'], webhook: 'https://example.com/x' }]],
        hmacKey: 'k',
      }),
    ).resolves.toBeUndefined();
  });

  it('handles empty sources array', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response('ok');
    }) as unknown as typeof fetch;

    await fireNotifications({
      event: makeFinishedEvent(),
      sources: [],
      hmacKey: 'k',
      fetchImpl,
    });

    expect(calls).toHaveLength(0);
  });
});
