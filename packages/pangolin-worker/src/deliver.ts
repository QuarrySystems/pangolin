// pangolin-worker: outcome-consumption for the delivery paths (lifecycle
// callback + notification webhooks) and their durable-record write.
//
// Grouped the way output-sentinel.ts groups its dispatch-record writes: one
// module owns "consume a DeliveryOutcome/NotificationOutcome[] and decide
// what to persist/log", separate from the emit/fire logic itself (lifecycle.ts,
// notifications.ts) and separate from result capture (output-sentinel.ts).

import {
  buildDispatchRecordUri,
  type StorageProvider,
  type LifecycleEvent,
  type NotificationConfig,
} from '@quarry-systems/pangolin-core';
import type { LifecycleEmitter, DeliveryOutcome } from './lifecycle.js';
import { fireNotifications } from './notifications.js';
import type { StructuredLogger } from './logger.js';

export interface DeliverContext {
  emitter: LifecycleEmitter;
  /** Optional — the storage-construction failure path has none. */
  storage?: StorageProvider;
  logger: StructuredLogger;
  namespace: string;
  dispatchId: string;
  notifications?: { sources: NotificationConfig[][]; hmacKey: string; fetchImpl?: typeof fetch };
}

/**
 * Durable record: write `{event, outcome}` to
 * `dispatches/<id>/undelivered/<kind>.json` — a URI-addressed overwrite put,
 * last-write-wins per kind. Exported for direct test.
 */
export async function persistUndelivered(
  storage: StorageProvider,
  namespace: string,
  dispatchId: string,
  event: LifecycleEvent,
  outcome: DeliveryOutcome,
): Promise<void> {
  const uri = buildDispatchRecordUri(namespace, dispatchId, `undelivered/${event.kind}.json`);
  await storage.put(uri, new TextEncoder().encode(JSON.stringify({ event, outcome })));
}

/**
 * Emit a lifecycle event and consume the outcome: on failure, persist the
 * undelivered record (when storage is present) and log; on success, do
 * nothing further.
 */
export async function deliverLifecycle(event: LifecycleEvent, ctx: DeliverContext): Promise<void> {
  const outcome: DeliveryOutcome = await ctx.emitter.emit(event);
  if (outcome.delivered) return;
  if (ctx.storage) {
    await persistUndelivered(ctx.storage, ctx.namespace, ctx.dispatchId, event, outcome);
    ctx.logger.log({
      kind: 'lifecycle.delivery.failed',
      dispatchId: ctx.dispatchId,
      eventKind: event.kind,
      reason: outcome.reason,
    });
  } else {
    ctx.logger.log({
      kind: 'lifecycle.delivery.unpersisted',
      dispatchId: ctx.dispatchId,
      eventKind: event.kind,
      reason: outcome.reason,
    });
  }
}

/**
 * Fan out notification webhooks for an event and log one line per failed
 * endpoint, using the outcome's own `label` (never re-derived, never the
 * raw URL — see NotificationOutcome in notifications.ts).
 */
export async function deliverNotifications(
  event: LifecycleEvent,
  ctx: DeliverContext,
): Promise<void> {
  if (!ctx.notifications) return;
  const outcomes = await fireNotifications({ event, ...ctx.notifications });
  for (const o of outcomes) {
    if (!o.delivered) {
      ctx.logger.log({
        kind: 'notifications.delivery.failed',
        endpoint: o.label,
        reason: o.reason,
      });
    }
  }
}
