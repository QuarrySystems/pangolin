import { describe, it, expect } from 'vitest';
import type { StorageProvider, LifecycleEvent } from '@quarry-systems/pangolin-core';
import { persistUndelivered, deliverLifecycle, deliverNotifications } from '../src/deliver.js';
import type { LifecycleEmitter, DeliveryOutcome } from '../src/lifecycle.js';
import type { StructuredLogger } from '../src/logger.js';

describe('persistUndelivered', () => {
  it('writes {event, outcome} to the per-kind undelivered URI', async () => {
    const puts: Array<{ uri: string; body: string }> = [];
    const storage = {
      put: async (uri: string, b: Uint8Array) => {
        puts.push({ uri, body: new TextDecoder().decode(b) });
        return { contentHash: 'h' };
      },
    } as unknown as StorageProvider;

    await persistUndelivered(
      storage,
      'ns',
      'D1',
      { kind: 'dispatch.failed', dispatchId: 'D1' } as LifecycleEvent,
      { delivered: false, reason: 'network' },
    );

    expect(puts[0]!.uri).toBe('pangolin://ns/dispatches/D1/undelivered/dispatch.failed.json');
    expect(JSON.parse(puts[0]!.body)).toEqual({
      event: { kind: 'dispatch.failed', dispatchId: 'D1' },
      outcome: { delivered: false, reason: 'network' },
    });
  });

  it('overwrites on a second failure of the same kind (last-write-wins)', async () => {
    const puts: Array<{ uri: string; body: string }> = [];
    const storage = {
      put: async (uri: string, b: Uint8Array) => {
        puts.push({ uri, body: new TextDecoder().decode(b) });
        return { contentHash: 'h' };
      },
    } as unknown as StorageProvider;

    const event = { kind: 'dispatch.failed', dispatchId: 'D1' } as LifecycleEvent;
    await persistUndelivered(storage, 'ns', 'D1', event, { delivered: false, reason: 'network' });
    await persistUndelivered(storage, 'ns', 'D1', event, { delivered: false, reason: 'timeout' });

    expect(puts).toHaveLength(2);
    expect(puts[0]!.uri).toBe(puts[1]!.uri);
    expect(JSON.parse(puts[1]!.body)).toEqual({
      event,
      outcome: { delivered: false, reason: 'timeout' },
    });
  });
});

describe('deliverLifecycle', () => {
  it('persists and logs when a delivery fails and storage is present', async () => {
    const puts: string[] = [];
    const storage = {
      put: async (uri: string) => {
        puts.push(uri);
        return { contentHash: 'h' };
      },
    } as unknown as StorageProvider;
    const emitter = {
      emit: async () => ({ delivered: false, reason: 'network' }) as DeliveryOutcome,
    } as unknown as LifecycleEmitter;
    const logs: unknown[] = [];

    await deliverLifecycle({ kind: 'dispatch.failed', dispatchId: 'D1' } as LifecycleEvent, {
      emitter,
      storage,
      logger: { log: (l: unknown) => logs.push(l) } as unknown as StructuredLogger,
      namespace: 'ns',
      dispatchId: 'D1',
    });

    expect(puts[0]).toContain('/undelivered/dispatch.failed.json');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      kind: 'lifecycle.delivery.failed',
      dispatchId: 'D1',
      eventKind: 'dispatch.failed',
      reason: 'network',
    });
  });

  it('does not throw and logs lifecycle.delivery.persist_failed when storage.put rejects', async () => {
    const storage = {
      put: async () => {
        throw new Error('storage unavailable at /some/secret/path');
      },
    } as unknown as StorageProvider;
    const emitter = {
      emit: async () => ({ delivered: false, reason: 'network' }) as DeliveryOutcome,
    } as unknown as LifecycleEmitter;
    const logs: unknown[] = [];

    await expect(
      deliverLifecycle({ kind: 'dispatch.failed', dispatchId: 'D1' } as LifecycleEvent, {
        emitter,
        storage,
        logger: { log: (l: unknown) => logs.push(l) } as unknown as StructuredLogger,
        namespace: 'ns',
        dispatchId: 'D1',
      }),
    ).resolves.toBeUndefined();

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      kind: 'lifecycle.delivery.persist_failed',
      dispatchId: 'D1',
      eventKind: 'dispatch.failed',
      reason: 'network',
    });
  });

  it('does not persist or log when nothing was attempted (delivered:false, no reason) even with storage present', async () => {
    const puts: string[] = [];
    const storage = {
      put: async (uri: string) => {
        puts.push(uri);
        return { contentHash: 'h' };
      },
    } as unknown as StorageProvider;
    const emitter = {
      emit: async () => ({ delivered: false }) as DeliveryOutcome,
    } as unknown as LifecycleEmitter;
    const logs: unknown[] = [];

    await deliverLifecycle({ kind: 'dispatch.failed', dispatchId: 'D1' } as LifecycleEvent, {
      emitter,
      storage,
      logger: { log: (l: unknown) => logs.push(l) } as unknown as StructuredLogger,
      namespace: 'ns',
      dispatchId: 'D1',
    });

    expect(puts).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });

  it('emits but does not persist (and does not throw) when storage is undefined', async () => {
    const emitter = {
      emit: async () => ({ delivered: false, reason: 'network' }) as DeliveryOutcome,
    } as unknown as LifecycleEmitter;
    const logs: Array<{ kind: string }> = [];

    await expect(
      deliverLifecycle({ kind: 'dispatch.failed', dispatchId: 'D1' } as LifecycleEvent, {
        emitter,
        logger: { log: (l: { kind: string }) => logs.push(l) } as unknown as StructuredLogger,
        namespace: 'ns',
        dispatchId: 'D1',
      }),
    ).resolves.toBeUndefined();

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ kind: 'lifecycle.delivery.unpersisted' });
  });

  it('does not persist or log when delivery succeeds', async () => {
    const puts: string[] = [];
    const storage = {
      put: async (uri: string) => {
        puts.push(uri);
        return { contentHash: 'h' };
      },
    } as unknown as StorageProvider;
    const emitter = {
      emit: async () => ({ delivered: true, status: 200 }) as DeliveryOutcome,
    } as unknown as LifecycleEmitter;
    const logs: unknown[] = [];

    await deliverLifecycle({ kind: 'dispatch.finished', dispatchId: 'D1' } as LifecycleEvent, {
      emitter,
      storage,
      logger: { log: (l: unknown) => logs.push(l) } as unknown as StructuredLogger,
      namespace: 'ns',
      dispatchId: 'D1',
    });

    expect(puts).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });
});

describe('deliverNotifications', () => {
  it('logs one line per failed endpoint using the outcome label, and does not log a healthy one', async () => {
    const emitter = {} as unknown as LifecycleEmitter;
    const logs: unknown[] = [];
    const secretUrl = 'https://user:secret-token@evil.example.com/webhook?token=abc123';

    // fetchImpl: first call (secretUrl) fails, second (healthy.example.com) succeeds.
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('evil.example.com')) {
        throw new Error('network down');
      }
      return { status: 200 } as Response;
    }) as unknown as typeof fetch;

    await deliverNotifications({ kind: 'dispatch.failed', dispatchId: 'D1' } as LifecycleEvent, {
      emitter,
      logger: { log: (l: unknown) => logs.push(l) } as unknown as StructuredLogger,
      namespace: 'ns',
      dispatchId: 'D1',
      notifications: {
        sources: [
          [
            { when: ['dispatch.failed'], webhook: secretUrl },
            { when: ['dispatch.failed'], webhook: 'https://healthy.example.com/hook' },
          ],
        ],
        hmacKey: 'k',
        fetchImpl,
      },
    });

    expect(logs).toHaveLength(1);
    const line = logs[0] as { kind: string; endpoint: string; reason: string };
    expect(line.kind).toBe('notifications.delivery.failed');
    expect(line.endpoint).not.toContain('secret-token');
    expect(line.endpoint).not.toContain('token=abc123');
    expect(line.endpoint).not.toContain('evil.example.com/webhook');
  });

  it('does nothing when ctx.notifications is absent', async () => {
    const emitter = {} as unknown as LifecycleEmitter;
    const logs: unknown[] = [];

    await deliverNotifications({ kind: 'dispatch.failed', dispatchId: 'D1' } as LifecycleEvent, {
      emitter,
      logger: { log: (l: unknown) => logs.push(l) } as unknown as StructuredLogger,
      namespace: 'ns',
      dispatchId: 'D1',
    });

    expect(logs).toHaveLength(0);
  });
});
