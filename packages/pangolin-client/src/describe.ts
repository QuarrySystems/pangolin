// `dispatch.describe(dispatchId)` — read-side of `writeDispatchRecord` (§4.6).
//
// Loads the persisted dispatch record from storage and returns the full
// `DispatchResult` shape, including captured stdout/stderr, lifecycle
// `failure` block, and `needsInput` block. If the record cannot be found —
// because it was never written, or because the storage-side retention sweep
// has purged it past the configured window (§7.8) — this throws
// `DispatchRecordExpiredError`. Per §7.8 the caller cannot distinguish
// "expired" from "never existed"; both surface as the same error.

import type { DispatchResult } from '@quarry-systems/pangolin-core';
import type { PangolinClient } from './client.js';
import { readDispatchRecord } from './retention.js';

/**
 * Thrown by `describeDispatch` when the requested dispatch record is not
 * present in storage. Carries the `dispatchId` the caller asked about so
 * error handlers can surface it without re-parsing the message.
 */
export class DispatchRecordExpiredError extends Error {
  constructor(public readonly dispatchId: string) {
    super(`dispatch record expired: ${dispatchId}`);
    this.name = 'DispatchRecordExpiredError';
  }
}

/**
 * Read a previously-sealed dispatch record and return the full
 * `DispatchResult` shape (the on-disk record extends `DispatchResult` with
 * `providerTaskId`, `target`, `retentionDays`, and `recordedAt`, all of
 * which are preserved on the returned object for callers that want them).
 *
 * Throws `DispatchRecordExpiredError` if `readDispatchRecord` returns
 * `null` (record missing or purged). Unrelated storage errors are
 * re-thrown unchanged.
 */
export async function describeDispatch(
  client: PangolinClient,
  dispatchId: string,
): Promise<DispatchResult> {
  const record = await readDispatchRecord(client, dispatchId);
  if (!record) throw new DispatchRecordExpiredError(dispatchId);
  return record;
}
