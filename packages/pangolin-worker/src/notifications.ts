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
import type {
  LifecycleEvent,
  NotificationConfig,
} from '@quarry-systems/pangolin-core';

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
}): Promise<void> {
  const fetchFn = opts.fetchImpl ?? fetch;

  const matches: NotificationConfig[] = [];
  for (const source of opts.sources) {
    for (const cfg of source) {
      if (cfg.when.includes(opts.event.kind)) {
        matches.push(cfg);
      }
    }
  }

  if (matches.length === 0) return;

  const timestamp = new Date().toISOString();
  const payload = JSON.stringify(opts.event);
  const signature = createHmac('sha256', opts.hmacKey)
    .update(`${opts.event.dispatchId}.${timestamp}.${payload}`)
    .digest('hex');

  const headers = {
    'Content-Type': 'application/json',
    'X-Pangolin Scale-Signature': `sha256=${signature}`,
    'X-Pangolin Scale-Dispatch-Id': opts.event.dispatchId,
    'X-Pangolin Scale-Timestamp': timestamp,
  };

  await Promise.allSettled(
    matches.map((cfg) =>
      fetchFn(cfg.webhook, {
        method: 'POST',
        headers,
        body: payload,
      }),
    ),
  );
}
