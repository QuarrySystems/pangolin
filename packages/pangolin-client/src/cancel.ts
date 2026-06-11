// `dispatch.cancel(dispatchId)` — best-effort cancellation (§7.6).
//
// Looks up the persisted dispatch record for `dispatchId`, resolves the
// target's `ComputeProvider`, and calls `provider.cancel(handle, ctx)` if
// the provider supports it. The operation is idempotent: missing records,
// removed targets, providers without `cancel`, and re-cancels against
// already-stopped tasks all collapse to a silent no-op so callers can
// re-fire cancel without coordinating state.
//
// Grace semantics (e.g. SIGTERM-then-SIGKILL for Fargate / local-docker)
// are the provider's responsibility — this layer only routes the call.

import type { PangolinClient } from './client.js';
import { readDispatchRecord } from './retention.js';

/**
 * Best-effort cancellation of a dispatched task. Returns `undefined`
 * unconditionally; failures of any participant (storage, credentials,
 * provider) collapse to a silent no-op per §7.6's idempotency contract.
 */
export async function cancelDispatch(
  client: PangolinClient,
  dispatchId: string,
): Promise<void> {
  const record = await readDispatchRecord(client, dispatchId);
  if (!record) return; // already purged or never existed — no-op
  const targetCfg = client.targets[record.target];
  if (!targetCfg) return; // target removed since dispatch — silent no-op
  const compute = client.compute[targetCfg.compute];
  if (!compute || typeof compute.cancel !== 'function') return; // provider can't cancel
  const credentialProvider = client.credentials[targetCfg.credentials];
  if (!credentialProvider) return; // credentials gone — silent no-op
  let credentials;
  try {
    credentials = await credentialProvider.resolve();
  } catch {
    return; // can't resolve creds → best-effort gives up silently
  }
  try {
    await compute.cancel(
      { providerTaskId: record.providerTaskId },
      { credentials, telemetry: client.telemetry },
    );
  } catch {
    // Already stopped / provider rejected / network blip — silent no-op
  }
}
