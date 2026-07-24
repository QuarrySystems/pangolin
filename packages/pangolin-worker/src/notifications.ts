// pangolin-worker: notifications (§6.2 step 12 / §6.3).
//
// Fires notification webhooks for each lifecycle event the dispatch produces.
// Notification configs are sourced from two places:
//
//   1. `pangolin-notifications.json` inside the post-overlay workspace
//      (capability-content scope), loaded with `loadCapabilityNotifications`.
//   2. The dispatch-level `notifications` array supplied on `DispatchWork`.
//
// Both sources are merged at fire time: for each `NotificationConfig` whose
// `when` array includes the current event kind, the worker POSTs an
// HMAC-signed payload to the webhook URL. The signature scheme matches
// `signCallback` from pangolin-client (§7.3): hex HMAC-SHA256 over
// `${dispatchId}.${timestamp}.${payload}`.
//
// All matching webhooks fire in parallel via `Promise.allSettled` so that one
// slow or failing endpoint cannot block the others — and a single failure
// never throws out of `fireNotifications`, because notification delivery is
// best-effort and must not abort the dispatch lifecycle.

import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import type { LifecycleEvent, NotificationConfig } from '@quarry-systems/pangolin-core';
import { safeEndpointLabel } from './safe-endpoint-label.js';
import type { DeliveryFailureReason } from './lifecycle.js';

export interface NotificationOutcome {
  /** safeEndpointLabel output — NEVER the raw webhook URL, which can carry credentials. */
  label: string;
  delivered: boolean;
  status?: number;
  reason?: DeliveryFailureReason;
}

/**
 * Load the capability-content notification configs from the post-overlay
 * workspace. Returns `[]` when `pangolin-notifications.json` is absent so the
 * caller can unconditionally merge with dispatch-level configs.
 */
export async function loadCapabilityNotifications(
  workspaceDir: string,
): Promise<NotificationConfig[]> {
  const path = join(workspaceDir, 'pangolin-notifications.json');
  try {
    await access(path);
  } catch {
    return [];
  }
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw) as NotificationConfig[];
}

/**
 * Fire all matching notification webhooks for a single lifecycle event.
 *
 * - `sources` is a list of `NotificationConfig[]` arrays — typically
 *   `[capabilityContentConfigs, dispatchLevelConfigs]` — flattened and
 *   filtered by `when.includes(event.kind)` to produce the set of webhooks
 *   to fire.
 * - All matching webhooks fire concurrently via `Promise.allSettled`; one
 *   failure does not block the others and does not throw out of this
 *   function.
 * - `fetchImpl` is injectable for tests; defaults to the global `fetch`.
 */
export async function fireNotifications(opts: {
  event: LifecycleEvent;
  sources: NotificationConfig[][];
  hmacKey: string;
  fetchImpl?: typeof fetch;
  /** Default 5_000, clamped per the shared shape (see lifecycle.ts). */
  attemptTimeoutMs?: number;
}): Promise<NotificationOutcome[]> {
  const fetchFn = opts.fetchImpl ?? fetch;

  const matches: NotificationConfig[] = [];
  for (const source of opts.sources) {
    for (const cfg of source) {
      if (cfg.when.includes(opts.event.kind)) {
        matches.push(cfg);
      }
    }
  }

  if (matches.length === 0) return [];

  const timestamp = new Date().toISOString();
  const payload = JSON.stringify(opts.event);
  const signature = createHmac('sha256', opts.hmacKey)
    .update(`${opts.event.dispatchId}.${timestamp}.${payload}`)
    .digest('hex');

  // A PLAIN OBJECT, deliberately — see the identical invariant in lifecycle.ts:46-49.
  // `new Headers({...})` here would validate header VALUES too, and a caller-supplied
  // dispatchId containing '\n' would throw out of fireNotifications instead of returning
  // an outcome array.
  const headers = {
    'Content-Type': 'application/json',
    'X-Pangolin-Signature': `sha256=${signature}`,
    'X-Pangolin-Dispatch-Id': opts.event.dispatchId,
    'X-Pangolin-Timestamp': timestamp,
  };

  // Clamp once, outside the map — see the identical shape in lifecycle.ts:57-75. Each
  // fetch below gets its OWN AbortSignal.timeout(delayMs); a signal shared across N
  // fetches would register N abort listeners on one object, which is semantically wrong
  // even though it can't be observed by wall-clock timing (see notifications.test.ts).
  const DEFAULT_ATTEMPT_TIMEOUT_MS = 5_000;
  const MAX_ATTEMPT_TIMEOUT_MS = 2_147_483_647; // Node's TIMEOUT_MAX
  const requested = opts.attemptTimeoutMs;
  const delayMs =
    Number.isFinite(requested) && (requested as number) > 0
      ? Math.trunc(Math.min(requested as number, MAX_ATTEMPT_TIMEOUT_MS))
      : DEFAULT_ATTEMPT_TIMEOUT_MS;

  const settled = await Promise.allSettled(
    matches.map((cfg) => {
      const signal = AbortSignal.timeout(delayMs);
      return fetchFn(cfg.webhook, {
        method: 'POST',
        headers,
        body: payload,
        signal,
      }).then(
        (res) => ({ res }),
        (err: unknown) => {
          // Classify on the SIGNAL, not on the error's name or message: a hand-rolled
          // mock rejecting with new Error('aborted') must not be able to pin the wrong
          // branch (mirrors lifecycle.ts:88-90).
          throw { aborted: signal.aborted, err };
        },
      );
    }),
  );

  return settled.map((result, i) => {
    const label = safeEndpointLabel(matches[i]!.webhook, i);
    if (result.status === 'fulfilled') {
      const { status } = result.value.res;
      return status >= 200 && status < 300
        ? { label, delivered: true, status }
        : { label, delivered: false, status, reason: 'http-status' as DeliveryFailureReason };
    }
    const rejection = result.reason as { aborted: boolean };
    return {
      label,
      delivered: false,
      reason: (rejection.aborted ? 'timeout' : 'network') as DeliveryFailureReason,
    };
  });
}
