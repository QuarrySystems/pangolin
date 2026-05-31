// agora-worker: workspace escape — compute and upload the output sentinel.
//
// escapeWorkspace is called on the success path (exitCode === 0) before
// emitting dispatch.finished. It is best-effort: the caller wraps it in a
// try/catch and logs escape.failed rather than propagating the error.
//
// Two writes happen in sequence:
//   1. Upload the patch as a content-addressed artifact blob (if any changes).
//   2. Write .agora/output.json in-workspace AND upload the sentinel to the
//      per-dispatch dispatch-record URI (always, even when there is no patch).

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildAgoraUri,
  buildDispatchRecordUri,
  computeContentHash,
} from '@quarry-systems/agora-core';
import type { StorageProvider } from '@quarry-systems/agora-core';
import { computeWorkspacePatch, type WorkspaceBaseline } from './patch-capture.js';

/** The on-disk and in-storage sentinel shape (D7 strict subset). */
export interface OutputSentinel {
  schemaVersion: 1;
  patchRef?: string;
  summary?: string;
}

/**
 * Compute the workspace patch (if any), upload it as a content-addressed
 * artifact, write `.agora/output.json` in the workspace, and upload the
 * sentinel to the per-dispatch dispatch-record URI.
 *
 * Never throws — the caller (entrypoint.ts step 14) is expected to catch
 * and log `escape.failed` so a capture/upload failure never changes the
 * dispatch outcome.
 */
export async function escapeWorkspace(opts: {
  workspaceDir: string;
  storage: StorageProvider;
  namespace: string;
  dispatchId: string;
  baseline: WorkspaceBaseline;
  summary?: string;
}): Promise<OutputSentinel> {
  const { workspaceDir, storage, namespace, dispatchId, baseline, summary } = opts;

  // Step 1: compute the patch and upload it as a content-addressed artifact.
  let patchRef: string | undefined;
  const patch = await computeWorkspacePatch(workspaceDir, baseline);
  if (patch) {
    const contentHash = computeContentHash(patch);
    patchRef = buildAgoraUri({
      namespace,
      type: 'artifact',
      name: dispatchId,
      contentHash,
    });
    await storage.put(patchRef, patch);
  }

  // Step 2: build the sentinel object.
  const sentinel: OutputSentinel = { schemaVersion: 1 };
  if (patchRef !== undefined) sentinel.patchRef = patchRef;
  if (summary !== undefined) sentinel.summary = summary;

  const sentinelBytes = new TextEncoder().encode(JSON.stringify(sentinel));

  // Step 3: write .agora/output.json in the workspace (mkdir -p the .agora dir).
  const agoraDir = join(workspaceDir, '.agora');
  await mkdir(agoraDir, { recursive: true });
  await writeFile(join(agoraDir, 'output.json'), sentinelBytes);

  // Step 4: upload the sentinel to the per-dispatch dispatch-record URI.
  // This is a URI-addressed/overwrite put (not content-addressed).
  const dispatchRecordUri = buildDispatchRecordUri(namespace, dispatchId, 'output.json');
  await storage.put(dispatchRecordUri, sentinelBytes);

  return sentinel;
}
