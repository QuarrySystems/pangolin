// The sentinel wire shape: contract between the worker (writer) and readers.
// core is the sink every package already depends on. Types only — no
// StorageProvider, no I/O.

import type { VerifyOutcome } from './verify.js';
import type { RuntimeUsage } from './runtime-adapter.js';

/** Maximum number of output entries captured per run. Walk stops after this cap. */
export const MAX_OUTPUT_ENTRIES = 256;

/**
 * A single content-addressed deliverable captured from `workspace/outputs/`.
 * The `path` is posix-relative to `outputs/`; the `ref` is a pinned
 * pangolin:// artifact URI that resolves to the exact file bytes.
 */
export interface OutputEntry {
  /** Posix-relative path inside outputs/ (e.g. "report.pdf", "data/part-0.parquet"). */
  path: string;
  /** Pinned content-addressed URI: pangolin://<ns>/artifact/<dispatchId>/<sha256:...>. */
  ref: string;
}

/**
 * Per-block runtime evidence (spec §5 pin 3). Written ONLY for explicitly
 * declared pipelines — the implicit default pipeline writes the legacy sentinel
 * byte-for-byte. Placed here (beside OutputSentinel) to prevent a
 * runner↔sentinel circular import; sibling runners import BlockOutcome from
 * this file.
 */
export interface BlockOutcome {
  kind: string;
  ordinal: number;
  status: 'ok' | 'failed';
  exitCode?: number;
  durationMs: number;
  verify?: VerifyOutcome;
  patchRef?: string;
  outputs?: OutputEntry[];
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
  /**
   * Wave: model-cost-evidence — best-effort actual usage (model ids, cost,
   * turns, model time). Optional + additive — absence leaves the sentinel
   * hash unchanged (byte-identical to pre-usage shape).
   */
  usage?: RuntimeUsage;
  /**
   * Per-block runtime evidence (spec §5 pin 3). Optional + additive — absence
   * leaves the sentinel hash unchanged (byte-identical to pre-blocks shape).
   * Written only for explicitly declared pipelines.
   */
  blocks?: BlockOutcome[];
}
