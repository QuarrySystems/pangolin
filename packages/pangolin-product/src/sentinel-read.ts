// The I/O wrapper around parseOutputSentinel: builds the dispatch-record
// URI, fetches it, and delegates to the pure parser. Missing objects become
// `absent` rather than throwing, because a finished dispatch with no
// sentinel is a normal outcome — `writeSentinel` is best-effort and the
// entrypoint emits `dispatch.finished` regardless.

import { buildDispatchRecordUri, isStorageNotFound } from '@quarry-systems/pangolin-core';
import type { StorageProvider } from '@quarry-systems/pangolin-core';
import { parseOutputSentinel, type SentinelReadResult } from './sentinel-parse.js';

export async function readOutputSentinel(
  deps: { storage: StorageProvider; namespace: string },
  dispatchId: string,
): Promise<SentinelReadResult> {
  const uri = buildDispatchRecordUri(deps.namespace, dispatchId, 'output.json');
  let bytes: Uint8Array;
  try {
    bytes = await deps.storage.get(uri);
  } catch (err) {
    if (isStorageNotFound(err)) return { status: 'absent' };
    throw err; // DNS, throttle, misconfiguration — no longer silently 'absent'
  }
  return parseOutputSentinel(bytes);
}
