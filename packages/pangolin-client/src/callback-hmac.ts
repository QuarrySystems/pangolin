import { randomBytes, createHmac } from 'node:crypto';
import type { SecretStore } from '@quarry-systems/pangolin-core';

/**
 * Mint a per-dispatch HMAC key, stage it in the injected SecretStore with a
 * TTL matching the dispatch's expected duration plus a 5-minute buffer, and
 * return the opaque ref plus the effective ttlSeconds.
 *
 * The worker fetches the key by ref (passed as `PANGOLIN_CALLBACK_TOKEN_REF`)
 * and uses {@link signCallback} to sign every callback POST so that the
 * client and worker compute identical signatures (§7.3).
 */
export async function mintCallbackHmac(opts: {
  store: SecretStore;
  dispatchId: string;
  dispatchTimeoutSeconds?: number;
  namePrefix?: string;
}): Promise<{ ref: string; ttlSeconds: number }> {
  const namePrefix = opts.namePrefix ?? 'pangolin/callback-hmac';
  const ttlSeconds = (opts.dispatchTimeoutSeconds ?? 7200) + 300;
  const key = randomBytes(32).toString('hex');
  const { ref } = await opts.store.stage({
    name: `${namePrefix}/${opts.dispatchId}`,
    value: key,
    ttlSeconds,
    tags: { 'pangolin:dispatchId': opts.dispatchId },
  });
  return { ref, ttlSeconds };
}

/**
 * Sign a callback payload per §7.3. The message is
 * `${dispatchId}.${timestampIso}.${payload}` and the digest is lowercase
 * hex HMAC-SHA256. Exported so the worker can compute identical
 * signatures from the same key.
 */
export function signCallback(opts: {
  hmacKey: string;
  dispatchId: string;
  timestampIso: string;
  payload: string;
}): string {
  const message = `${opts.dispatchId}.${opts.timestampIso}.${opts.payload}`;
  return createHmac('sha256', opts.hmacKey).update(message).digest('hex');
}
