// Dispatch-record retention layer (§7.8).
//
// `writeDispatchRecord` serializes a terminal `DispatchResult` (plus the
// `providerTaskId`, `target`, retention window, and the wall-clock at which
// the record was sealed) into the reserved `dispatches/` URI prefix.
// `readDispatchRecord` reads the same record back.
//
// Retention itself is enforced by the storage backend — S3 object lifecycle
// rules or a local-fs sweep — not by this code. The `retentionDays` field
// is stored in the record metadata for the backend (or operator) to act on.
// All this layer guarantees is that the caller cannot request a retention
// window longer than the client's configured `maxDays`.

import {
  buildDispatchRecordUri,
  type DispatchResult,
} from '@quarry-systems/pangolin-core';
import type { PangolinClient } from './client.js';

/**
 * On-disk shape of a sealed dispatch record. Extends `DispatchResult` with
 * the runtime-bound identity (`providerTaskId`, `target`) and the retention
 * metadata (`retentionDays`, `recordedAt`).
 */
export interface DispatchRecord extends DispatchResult {
  providerTaskId: string;
  target: string;
  retentionDays: number;
  /** ISO 8601 timestamp at which `writeDispatchRecord` sealed the record. */
  recordedAt: string;
}

const RECORD_SUFFIX = 'record.json';

/**
 * Serialize and write a dispatch record under
 * `pangolin://<namespace>/dispatches/<dispatchId>/record.json`.
 *
 * Throws if `retentionDays` exceeds the client's configured `maxDays`. The
 * actual purge of expired records is the storage backend's responsibility.
 */
export async function writeDispatchRecord(
  client: PangolinClient,
  dispatchId: string,
  result: DispatchResult & { providerTaskId?: string; target?: string },
  retentionDays: number,
): Promise<void> {
  if (retentionDays > client.retention.maxDays) {
    throw new Error(
      `writeDispatchRecord: retentionDays ${retentionDays} exceeds client maxDays ${client.retention.maxDays}`,
    );
  }
  const { providerTaskId, target, ...rest } = result;
  const record: DispatchRecord = {
    ...(rest as DispatchResult),
    providerTaskId: providerTaskId ?? '',
    target: target ?? '',
    retentionDays,
    recordedAt: new Date().toISOString(),
  };
  const uri = buildDispatchRecordUri(client.namespace, dispatchId, RECORD_SUFFIX);
  await client.storage.put(uri, new TextEncoder().encode(JSON.stringify(record)));
}

/**
 * Read and deserialize a previously-sealed dispatch record.
 *
 * Returns `null` if the backend reports the object is missing — either
 * because it was never written, or because the storage-side retention sweep
 * has purged it. Re-throws any other backend error.
 */
export async function readDispatchRecord(
  client: PangolinClient,
  dispatchId: string,
): Promise<DispatchRecord | null> {
  const uri = buildDispatchRecordUri(client.namespace, dispatchId, RECORD_SUFFIX);
  try {
    const bytes = await client.storage.get(uri);
    return JSON.parse(new TextDecoder().decode(bytes)) as DispatchRecord;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (code === 'ENOENT') return true;
  const message = (err as { message?: unknown }).message;
  if (typeof message === 'string' && /not found/i.test(message)) return true;
  return false;
}
