// The I/O wrapper around parseOutputSentinel: builds the dispatch-record
// URI, fetches it, and delegates to the pure parser. Missing objects become
// `absent` rather than throwing, because a finished dispatch with no
// sentinel is a normal outcome — `writeSentinel` is best-effort and the
// entrypoint emits `dispatch.finished` regardless.

import { buildDispatchRecordUri } from '@quarry-systems/pangolin-core';
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
    if (isNotFound(err)) return { status: 'absent' };
    throw err; // unrelated storage errors propagate
  }
  return parseOutputSentinel(bytes);
}

// Duplicated from pangolin-client/src/retention.ts:90-97 BY DESIGN. Hoisting it
// into pangolin-core would put provider quirk-detection in the contract sink.
// The real defect is that StorageProvider has no typed not-found signal, so
// every caller sniffs. Tracked as follow-up; do not "fix" by adding a core dep.
function isNotFound(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  if ((err as { code?: unknown }).code === 'ENOENT') return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && /not found/i.test(message);
}
