// pangolin-worker: read and hash the dispatch's self-reported dependency evidence.
//
// The evidence is `.pangolin/deps.json`, written inside the workspace by the
// consumer's own setup script or agent. Pangolin learns no package manager: it
// hashes the file and treats every field inside as OPAQUE, exactly as it already
// treats `executorManifest`. The body's shape is the consumer's business.

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { canonicalJsonString } from '@quarry-systems/pangolin-core';

/** Bodies above this are refused rather than hashed. Evidence is a few hundred
 *  bytes in practice; anything at this scale is a mistake or an attempt to make
 *  the pre-agent path expensive. */
const MAX_BYTES = 64 * 1024;

/**
 * Discriminated deliberately. The caller must distinguish "no evidence offered"
 * from "evidence offered but unusable": the second is logged (spec §9.6) while
 * neither fails the dispatch, and collapsing them would silently discard the
 * one case a consumer needs told about — they wrote a file and it did not count.
 */
export type DepsEvidenceRead =
  | { kind: 'ok'; hash: string }
  | { kind: 'absent' }
  | { kind: 'unusable'; reason: string };

/**
 * NEVER throws.
 *
 * This posture is deliberately different from BOTH of its neighbours, and the
 * difference is the point: the `needs_input` sentinel treats malformed as
 * `worker-failed`, and the setup script is a hard failure by design. Neither the
 * run's success nor its correctness depends on dependency evidence, so it must
 * never become a new way for a dispatch to die.
 *
 * Canonicalises with `canonicalJsonString` rather than
 * `JSON.stringify(JSON.parse(...))`, which is key-order SENSITIVE. A package
 * manager that rewrites the sentinel with the same content in a different key
 * order would otherwise produce `atSetup !== atFinish` and report a mid-run
 * dependency change that did not happen — a false positive on the exact signal
 * this evidence exists to carry.
 */
export async function readDepsEvidence(workspaceDir: string): Promise<DepsEvidenceRead> {
  let raw: Buffer;
  try {
    raw = await readFile(join(workspaceDir, '.pangolin', 'deps.json'));
  } catch {
    // Covers a missing file, a missing .pangolin/, and a missing workspaceDir
    // alike — all mean the same thing to a caller: nothing was offered.
    return { kind: 'absent' };
  }

  if (raw.byteLength > MAX_BYTES) {
    return { kind: 'unusable', reason: `oversized: ${raw.byteLength}B exceeds ${MAX_BYTES}B` };
  }

  try {
    const canonical = canonicalJsonString(JSON.parse(raw.toString('utf8')));
    return { kind: 'ok', hash: `sha256:${createHash('sha256').update(canonical).digest('hex')}` };
  } catch (err) {
    return {
      kind: 'unusable',
      reason: `unparseable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
