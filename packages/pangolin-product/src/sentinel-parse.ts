// Pure validation and defensive reconstruction of output sentinel bytes.
//
// Lifted from the orchestrator's private `readSentinel`
// (packages/pangolin-orchestrator/src/executors/dispatch.ts) and generalized
// to cover the full OutputSentinel shape. Free of I/O so the whole
// hostile-input matrix tests with byte literals: the sentinel is
// worker-written and untrusted, so every field is reconstructed by hand from
// type-guarded reads — the raw parsed object is never forwarded.

import { MAX_OUTPUT_ENTRIES } from '@quarry-systems/pangolin-core';
import type {
  OutputSentinel,
  OutputEntry,
  BlockOutcome,
  VerifyOutcome,
  DepsEvidence,
  RuntimeUsage,
} from '@quarry-systems/pangolin-core';

export type SentinelMalformedReason = 'not-json' | 'not-an-object' | 'bad-schema-version';

export type SentinelReadResult =
  | { status: 'ok'; sentinel: OutputSentinel }
  // 'absent' is never constructed by parseOutputSentinel below — a sibling
  // I/O module (the one that reads the sentinel file off disk) synthesizes
  // it when the file doesn't exist.
  | { status: 'absent' }
  | { status: 'malformed'; reason: SentinelMalformedReason };

const MAX_REPORT_CHARS = 16_000;

function buildVerify(raw: unknown): VerifyOutcome | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as Record<string, unknown>;
  if (typeof v.passed !== 'boolean') return undefined;
  const verify: VerifyOutcome = { passed: v.passed };
  if (typeof v.report === 'string') verify.report = v.report.slice(0, MAX_REPORT_CHARS);
  if (typeof v.durationMs === 'number' && Number.isFinite(v.durationMs)) {
    verify.durationMs = v.durationMs;
  }
  return verify;
}

/**
 * Mirrors buildVerify above. Both hashes are REQUIRED: spec §4.2 types them as
 * required strings, so a half-present pair is dropped entirely rather than
 * reported asymmetrically — "evidence from one phase only" is not a shape this
 * field can express, and inventing a placeholder for the missing half would
 * fabricate a hash.
 *
 * The `tier` guard is a security control, not a type formality. These bytes come
 * from a worker-written file inside the agent's own workspace, so the type
 * system polices nothing here; this runtime check is the only thing preventing a
 * forged `tier: 'attested'` from reaching an audit row and overclaiming. The
 * threat model's governing rule is that overclaiming is the one thing an audit
 * tool cannot afford, so an unrecognised tier drops the whole field rather than
 * being coerced to 'recorded'.
 */
function buildDeps(raw: unknown): DepsEvidence | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const d = raw as Record<string, unknown>;
  if (typeof d.atSetup !== 'string' || typeof d.atFinish !== 'string') return undefined;
  if (d.tier !== 'recorded') return undefined;
  return { atSetup: d.atSetup, atFinish: d.atFinish, tier: 'recorded' };
}

function buildOutputs(raw: unknown, max: number): OutputEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const outputs: OutputEntry[] = [];
  for (const e of raw.slice(0, max)) {
    if (
      e &&
      typeof e === 'object' &&
      typeof (e as Record<string, unknown>).path === 'string' &&
      typeof (e as Record<string, unknown>).ref === 'string'
    ) {
      outputs.push({
        path: (e as Record<string, unknown>).path as string,
        ref: (e as Record<string, unknown>).ref as string,
      });
    }
  }
  return outputs.length > 0 ? outputs : undefined;
}

function buildUsage(raw: unknown): RuntimeUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  if (!Array.isArray(u.models) || !u.models.every((m) => typeof m === 'string')) return undefined;
  const usage: RuntimeUsage = { models: [...(u.models as string[])] };
  if (typeof u.costUsd === 'number' && Number.isFinite(u.costUsd)) usage.costUsd = u.costUsd;
  if (typeof u.turns === 'number' && Number.isFinite(u.turns)) usage.turns = u.turns;
  if (typeof u.durationMs === 'number' && Number.isFinite(u.durationMs))
    usage.durationMs = u.durationMs;
  return usage;
}

function buildBlocks(raw: unknown, max: number): BlockOutcome[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const blocks: BlockOutcome[] = [];
  for (const b of raw.slice(0, max)) {
    if (!b || typeof b !== 'object') continue;
    const bo = b as Record<string, unknown>;
    if (typeof bo.kind !== 'string') continue;
    if (typeof bo.ordinal !== 'number' || !Number.isFinite(bo.ordinal)) continue;
    if (bo.status !== 'ok' && bo.status !== 'failed') continue;
    if (typeof bo.durationMs !== 'number' || !Number.isFinite(bo.durationMs)) continue;

    const block: BlockOutcome = {
      kind: bo.kind,
      ordinal: bo.ordinal,
      status: bo.status,
      durationMs: bo.durationMs,
    };
    if (typeof bo.exitCode === 'number' && Number.isFinite(bo.exitCode))
      block.exitCode = bo.exitCode;
    if (typeof bo.patchRef === 'string') block.patchRef = bo.patchRef;
    const verify = buildVerify(bo.verify);
    if (verify) block.verify = verify;
    const outputs = buildOutputs(bo.outputs, MAX_OUTPUT_ENTRIES);
    if (outputs) block.outputs = outputs;

    blocks.push(block);
  }
  return blocks.length > 0 ? blocks : undefined;
}

/**
 * Parse and defensively reconstruct an output sentinel from raw bytes. Never
 * throws. The sentinel is worker-written and untrusted — every field is
 * type-guarded and rebuilt from scratch; the parsed object is never forwarded
 * by reference.
 */
export function parseOutputSentinel(bytes: Uint8Array): SentinelReadResult {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { status: 'malformed', reason: 'not-json' };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 'malformed', reason: 'not-an-object' };
  }
  const src = raw as Record<string, unknown>;
  if (src.schemaVersion !== 1) return { status: 'malformed', reason: 'bad-schema-version' };

  const sentinel: OutputSentinel = { schemaVersion: 1 };
  if (typeof src.patchRef === 'string') sentinel.patchRef = src.patchRef;
  if (typeof src.summary === 'string') sentinel.summary = src.summary;

  const verify = buildVerify(src.verify);
  if (verify) sentinel.verify = verify;

  const deps = buildDeps(src.deps);
  if (deps) sentinel.deps = deps;

  const outputs = buildOutputs(src.outputs, MAX_OUTPUT_ENTRIES);
  if (outputs) sentinel.outputs = outputs;

  const usage = buildUsage(src.usage);
  if (usage) sentinel.usage = usage;

  const blocks = buildBlocks(src.blocks, MAX_OUTPUT_ENTRIES);
  if (blocks) sentinel.blocks = blocks;

  return { status: 'ok', sentinel };
}
