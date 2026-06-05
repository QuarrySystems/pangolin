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

import { lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import {
  buildAgoraUri,
  buildDispatchRecordUri,
  computeContentHash,
} from '@quarry-systems/agora-core';
import type { StorageProvider } from '@quarry-systems/agora-core';
import { computeWorkspacePatch, type WorkspaceBaseline } from './patch-capture.js';
import type { VerifyOutcome } from '@quarry-systems/agora-core';

/** Per-file size ceiling for output captures. Files larger than this are skipped. */
export const MAX_OUTPUT_FILE_BYTES = 100 * 1024 * 1024; // 100 MiB

/** Maximum number of output entries captured per run. Walk stops after this cap. */
export const MAX_OUTPUT_ENTRIES = 256;

/**
 * A single content-addressed deliverable captured from `workspace/outputs/`.
 * The `path` is posix-relative to `outputs/`; the `ref` is a pinned
 * agora:// artifact URI that resolves to the exact file bytes.
 */
export interface OutputEntry {
  /** Posix-relative path inside outputs/ (e.g. "report.pdf", "data/part-0.parquet"). */
  path: string;
  /** Pinned content-addressed URI: agora://<ns>/artifact/<dispatchId>/<sha256:...>. */
  ref: string;
}

/** The on-disk and in-storage sentinel shape (D7 strict subset). */
export interface OutputSentinel {
  schemaVersion: 1;
  patchRef?: string;
  summary?: string;
  /**
   * Self-verify result (Gap A): the worker's own run of the project's
   * (language-agnostic) verify command over its edit — `dotnet test`,
   * `cargo test`, `pytest`, `tsc && vitest`, etc. Optional + additive — the
   * versioned sentinel stays backward-compatible (old readers ignore it;
   * absence leaves the hash unchanged). Report-only: a failed verify does not
   * change the dispatch outcome, only this signal.
   */
  verify?: VerifyOutcome;
  /**
   * Wave A (§5 output side): content-addressed deliverables captured from
   * workspace/outputs/. Optional + additive — absence leaves the hash
   * unchanged. Files over MAX_OUTPUT_FILE_BYTES are skipped; walk stops at
   * MAX_OUTPUT_ENTRIES. Entries are sorted deterministically (posix path).
   */
  outputs?: OutputEntry[];
}

/**
 * Compute the workspace patch (the agent's edit, diffed from `baseline`) and
 * upload it as a content-addressed artifact. Returns the `patchRef`, or
 * `undefined` when there was no change. Capture this BEFORE any post-edit step
 * (e.g. self-verify) so build artifacts from that step never pollute the patch.
 */
export async function capturePatch(opts: {
  workspaceDir: string;
  storage: StorageProvider;
  namespace: string;
  dispatchId: string;
  baseline: WorkspaceBaseline;
}): Promise<string | undefined> {
  const { workspaceDir, storage, namespace, dispatchId, baseline } = opts;
  const patch = await computeWorkspacePatch(workspaceDir, baseline);
  if (!patch) return undefined;
  const contentHash = computeContentHash(patch);
  const patchRef = buildAgoraUri({ namespace, type: 'artifact', name: dispatchId, contentHash });
  await storage.put(patchRef, patch);
  return patchRef;
}

/**
 * Walk `workspaceDir/outputs/` recursively (sorted, deterministic), stat each
 * file, skip any file whose byte size exceeds MAX_OUTPUT_FILE_BYTES, upload
 * each retained file as a content-addressed artifact, and return the entries.
 *
 * Returns `undefined` when `outputs/` is absent or contains no regular files
 * that fit within the size cap (so the written sentinel — and its hash — is
 * byte-identical to a pre-Wave-A sentinel for the same inputs).
 *
 * Walk stops after MAX_OUTPUT_ENTRIES entries regardless of how many files
 * remain; the entrypoint may log a warning for the skipped remainder.
 */
export async function captureOutputs(opts: {
  workspaceDir: string;
  storage: StorageProvider;
  namespace: string;
  dispatchId: string;
}): Promise<OutputEntry[] | undefined> {
  const { workspaceDir, storage, namespace, dispatchId } = opts;
  const outputsDir = join(workspaceDir, 'outputs');

  // Check outputs/ exists — readdir throws ENOENT if absent.
  let allEntries: string[];
  try {
    // Node >= 20: recursive readdir returns paths relative to outputsDir.
    // On Windows the separator is '\'; normalize to posix for determinism.
    const raw = await readdir(outputsDir, { recursive: true });
    allEntries = raw
      .map((e) => (sep !== '/' ? (e as string).split(sep).join('/') : (e as string)))
      .sort();
  } catch {
    return undefined; // outputs/ absent or unreadable
  }

  const entries: OutputEntry[] = [];
  // Symlink containment: readdir's recursive walk enumerates THROUGH symlinked
  // directories, so a symlinked dir's children surface as ordinary entries whose
  // own lstat is a regular file — skipping the symlink entry alone is not enough;
  // everything beneath it must be skipped too. The sorted order above guarantees
  // a symlink path is visited before any of its children, so a prefix list suffices.
  const skippedLinkPrefixes: string[] = [];
  for (const relPosix of allEntries) {
    if (skippedLinkPrefixes.some((p) => relPosix.startsWith(p))) continue;
    const absPath = join(outputsDir, relPosix);

    // Skip symlinks — a symlink pointing at a directory outside outputs/ would
    // cause readdir's recursive walk to enumerate files beyond the outputs/ tree.
    let linkStat: { isSymbolicLink(): boolean };
    try {
      linkStat = await lstat(absPath);
    } catch {
      continue; // race: entry disappeared between readdir and lstat
    }
    if (linkStat.isSymbolicLink()) {
      skippedLinkPrefixes.push(relPosix + '/');
      continue;
    }

    // Stat to distinguish files from directories and check the size cap.
    let fileStat: { size: number; isFile(): boolean };
    try {
      fileStat = await stat(absPath);
    } catch {
      continue; // race: file disappeared between lstat and stat
    }
    if (!fileStat.isFile()) continue; // skip subdirectory entries
    if (fileStat.size > MAX_OUTPUT_FILE_BYTES) continue; // oversized — skip

    // Read, content-address, and upload.
    const bytes = await readFile(absPath);
    const contentHash = computeContentHash(bytes);
    const ref = buildAgoraUri({ namespace, type: 'artifact', name: dispatchId, contentHash });
    await storage.put(ref, bytes);

    entries.push({ path: relPosix, ref });
    if (entries.length >= MAX_OUTPUT_ENTRIES) break;
  }

  return entries.length > 0 ? entries : undefined;
}

/**
 * Build the output sentinel from an already-captured `patchRef` (+ optional
 * summary/verify/outputs), write it to `.agora/output.json`, and upload it to
 * the per-dispatch dispatch-record URI.
 */
export async function writeSentinel(opts: {
  workspaceDir: string;
  storage: StorageProvider;
  namespace: string;
  dispatchId: string;
  patchRef?: string;
  summary?: string;
  verify?: VerifyOutcome;
  /** Wave A (§5): content-addressed deliverables from workspace/outputs/. */
  outputs?: OutputEntry[];
}): Promise<OutputSentinel> {
  const { workspaceDir, storage, namespace, dispatchId, patchRef, summary, verify, outputs } = opts;

  const sentinel: OutputSentinel = { schemaVersion: 1 };
  if (patchRef !== undefined) sentinel.patchRef = patchRef;
  if (summary !== undefined) sentinel.summary = summary;
  if (verify !== undefined) sentinel.verify = verify;
  if (outputs !== undefined) sentinel.outputs = outputs;

  const sentinelBytes = new TextEncoder().encode(JSON.stringify(sentinel));

  // Write .agora/output.json in the workspace (mkdir -p the .agora dir).
  const agoraDir = join(workspaceDir, '.agora');
  await mkdir(agoraDir, { recursive: true });
  await writeFile(join(agoraDir, 'output.json'), sentinelBytes);

  // Upload the sentinel to the per-dispatch dispatch-record URI (URI-addressed
  // overwrite put, not content-addressed).
  const dispatchRecordUri = buildDispatchRecordUri(namespace, dispatchId, 'output.json');
  await storage.put(dispatchRecordUri, sentinelBytes);

  return sentinel;
}

/**
 * Convenience: capture the patch and write the sentinel in one step. Use the
 * split `capturePatch` + `writeSentinel` directly when a post-edit step must
 * run between them (see entrypoint self-verify).
 */
export async function escapeWorkspace(opts: {
  workspaceDir: string;
  storage: StorageProvider;
  namespace: string;
  dispatchId: string;
  baseline: WorkspaceBaseline;
  summary?: string;
  verify?: VerifyOutcome;
  /** Wave A (§5): content-addressed deliverables from workspace/outputs/. */
  outputs?: OutputEntry[];
}): Promise<OutputSentinel> {
  const patchRef = await capturePatch(opts);
  return writeSentinel({
    workspaceDir: opts.workspaceDir,
    storage: opts.storage,
    namespace: opts.namespace,
    dispatchId: opts.dispatchId,
    patchRef,
    summary: opts.summary,
    verify: opts.verify,
    outputs: opts.outputs,
  });
}
