// pangolin-worker: block-pipeline interpreter (Wave 1, §5 of block-runner design).
//
// Provides:
//   - BlockContext  — worker-side runtime context passed to each block
//   - PipelineResult — union of completed / failed / needs-input
//   - DEFAULT_VERIFY_TIMEOUT_SECONDS — single exported owner (entrypoint copy deleted next task)
//   - buildDefaultPipeline(subagent) — today's hardcoded steps as DATA, with the exact
//     entrypoint timeout guard reproduced: falsy/non-positive timeout → 600
//   - runPipeline(spec, ctx, opts) — executes spec.blocks in order, auto-appends seal
//
// Design guardrails (§4, §5 of spec):
//   (a) PipelineSpec is DATA in pangolin-core; BlockContext (runtime concerns) lives here ONLY.
//   (b) BlockContext is never exported from pangolin-core.
//   (c) No imports from pangolin-orchestrator.

import type { PipelineSpec, BlockSpec } from '@quarry-systems/pangolin-core';
import type { RuntimeAdapter, RuntimeUsage, StorageProvider, VerifyConfig } from '@quarry-systems/pangolin-core';
import { runBoundedCommand } from './bounded-command.js';
import { runVerify } from './verify.js';
import {
  capturePatch,
  captureOutputs,
  writeSentinel,
  type BlockOutcome,
  type OutputEntry,
  type OutputSentinel,
} from './output-sentinel.js';
import type { WorkspaceBaseline } from './patch-capture.js';
import type { VerifyOutcome } from '@quarry-systems/pangolin-core';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Worker-side runtime context — NEVER exported from pangolin-core (guardrail b). */
export interface BlockContext {
  workspaceDir: string;
  env: Record<string, string>;
  storage: StorageProvider;
  namespace: string;
  dispatchId: string;
  adapter: RuntimeAdapter;
  subagent: { systemPrompt?: string; promptTemplate?: string; model?: string };
  inputJson?: string;
  baseline: WorkspaceBaseline;
  redact(s: string): string;
  log(event: { kind: string; [k: string]: unknown }): void;
}

/** Terminal result of running a pipeline. */
export type PipelineResult =
  | { kind: 'completed'; outcomes: BlockOutcome[]; sentinel?: OutputSentinel; declared: boolean }
  | { kind: 'failed'; outcomes: BlockOutcome[]; exitCode: number }
  | { kind: 'needs-input'; sentinelPath: string; outcomes: BlockOutcome[] };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Single owner of the verify-timeout default after Wave 1 (the entrypoint's
 * copy is DELETED by the entrypoint-swap task — leaving it there would be an
 * unused-var lint failure). Exported so the entrypoint swap can reference it.
 */
export const DEFAULT_VERIFY_TIMEOUT_SECONDS = 600;

// ---------------------------------------------------------------------------
// buildDefaultPipeline
// ---------------------------------------------------------------------------

/**
 * Builds the default pipeline (today's hardcoded success-path steps as DATA).
 *
 * Reproduces the entrypoint's exact timeout guard:
 *   falsy/non-positive timeout → DEFAULT_VERIFY_TIMEOUT_SECONDS
 * including t = 0 → 600.
 */
export function buildDefaultPipeline(
  subagent: { verify?: VerifyConfig },
): PipelineSpec {
  const blocks: PipelineSpec['blocks'] = [];

  blocks.push({ kind: 'agent' });
  blocks.push({ kind: 'capture', what: 'patch' });

  if (subagent.verify) {
    const t = subagent.verify.timeout;
    const timeoutSeconds = typeof t === 'number' && t > 0 ? t : DEFAULT_VERIFY_TIMEOUT_SECONDS;
    blocks.push({
      kind: 'script',
      command: subagent.verify.command,
      timeoutSeconds,
      lens: 'verify',
    });
  }

  blocks.push({ kind: 'capture', what: 'outputs' });

  return {
    schemaVersion: 1,
    id: 'dev.default',
    blocks,
  };
}

// ---------------------------------------------------------------------------
// Block implementations (registry)
// ---------------------------------------------------------------------------

/**
 * Run an agent block: invoke ctx.adapter with the entrypoint's exact field mapping.
 * Returns the RuntimeExit so the caller can handle needs_input and non-zero exits.
 */
async function runAgentBlock(
  ordinal: number,
  ctx: BlockContext,
): Promise<{ outcome: BlockOutcome; needsInputSentinelPath?: string; shouldAbort?: boolean; exitCode?: number; usage?: RuntimeUsage }> {
  const startedAt = Date.now();

  const runtimeExit = await ctx.adapter.invoke(
    {
      systemPrompt: ctx.subagent.systemPrompt,
      promptTemplate: ctx.subagent.promptTemplate,
      input: ctx.inputJson !== undefined ? (JSON.parse(ctx.inputJson) as Record<string, unknown>) : undefined,
      model: ctx.subagent.model,
      workspaceDir: ctx.workspaceDir,
    },
    {
      dispatchId: ctx.dispatchId,
      env: ctx.env,
    },
  );

  const durationMs = Date.now() - startedAt;

  // Emit runtime.adapter.ran exactly as the entrypoint does today.
  ctx.log({
    kind: 'runtime.adapter.ran',
    exitCode: runtimeExit.exitCode,
    durationMs,
    stdout: runtimeExit.stdout,
    stderr: runtimeExit.stderr,
  });

  const outcome: BlockOutcome = {
    kind: 'agent',
    ordinal,
    status: runtimeExit.exitCode === 0 && !runtimeExit.needsInputSentinelPath
      ? 'ok'
      : runtimeExit.needsInputSentinelPath
        ? 'ok'   // needs_input is not a failure of the block itself
        : 'failed',
    exitCode: runtimeExit.exitCode !== 0 ? runtimeExit.exitCode : undefined,
    durationMs,
  };

  return {
    outcome,
    needsInputSentinelPath: runtimeExit.needsInputSentinelPath,
    shouldAbort: runtimeExit.exitCode !== 0 && !runtimeExit.needsInputSentinelPath,
    exitCode: runtimeExit.exitCode,
    usage: runtimeExit.usage,
  };
}

/**
 * Merge one agent block's reported usage into the running aggregate
 * (model-cost-evidence wave): `models` unioned (deduped, first-seen order);
 * `costUsd`/`turns`/`durationMs` summed across blocks that report them —
 * absent values are skipped, not zeroed. When NO agent block reports usage,
 * the aggregate stays undefined and the sentinel gets no `usage` key at all.
 */
function mergeUsage(acc: RuntimeUsage | undefined, u: RuntimeUsage): RuntimeUsage {
  if (acc === undefined) {
    // First reporter: copy verbatim (own arrays — never alias the adapter's object).
    return { ...u, models: [...u.models] };
  }
  for (const m of u.models) {
    if (!acc.models.includes(m)) acc.models.push(m);
  }
  if (u.costUsd !== undefined) acc.costUsd = (acc.costUsd ?? 0) + u.costUsd;
  if (u.turns !== undefined) acc.turns = (acc.turns ?? 0) + u.turns;
  if (u.durationMs !== undefined) acc.durationMs = (acc.durationMs ?? 0) + u.durationMs;
  return acc;
}

/**
 * Run a script block with gate or verify lens.
 * Gate: non-zero/timeout/start-error → shouldAbort=true.
 * Verify: never aborts; delegates to runVerify literally.
 */
async function runScriptBlock(
  block: Extract<BlockSpec, { kind: 'script' }>,
  ordinal: number,
  ctx: BlockContext,
): Promise<{ outcome: BlockOutcome; shouldAbort: boolean; exitCode?: number; verifyOutcome?: VerifyOutcome }> {
  const lens = block.lens ?? 'gate';
  const timeoutSeconds = block.timeoutSeconds ?? DEFAULT_VERIFY_TIMEOUT_SECONDS;

  if (lens === 'verify') {
    // Delegates to runVerify literally — one primitive, never a reimplementation.
    // Report-only: timeout/start-error → passed: false. Never aborts.
    const startedAt = Date.now();
    const verifyOutcome = await runVerify({
      workspaceDir: ctx.workspaceDir,
      command: block.command,
      env: ctx.env,
      timeoutSeconds,
    });
    const durationMs = Date.now() - startedAt;

    // Redact the report (entrypoint redacts verify.report — reproduce).
    const redactedOutcome: VerifyOutcome =
      verifyOutcome.report !== undefined
        ? { ...verifyOutcome, report: ctx.redact(verifyOutcome.report) }
        : verifyOutcome;

    const outcome: BlockOutcome = {
      kind: 'script',
      ordinal,
      status: 'ok', // verify-lens never fails the block
      durationMs: verifyOutcome.durationMs ?? durationMs,
      verify: redactedOutcome,
    };

    return { outcome, shouldAbort: false, verifyOutcome: redactedOutcome };
  }

  // Gate lens (default): run via runBoundedCommand
  const startedAt = Date.now();
  const result = await runBoundedCommand({
    command: block.command,
    cwd: ctx.workspaceDir,
    env: ctx.env,
    timeoutSeconds,
  });
  const durationMs = Date.now() - startedAt;

  // Redact stdout/stderr before storing in outcome.
  const stdout = ctx.redact(result.stdout);
  const stderr = ctx.redact(result.stderr);

  const isFailure = result.timedOut || result.startError !== undefined || result.exitCode !== 0;

  // Emit gate diagnostics (symmetric with entrypoint's setup-script.ran / runtime.adapter.ran).
  ctx.log({
    kind: 'script.gate.ran',
    exitCode: result.exitCode,
    durationMs,
    stdout,
    stderr,
  });

  const outcome: BlockOutcome = {
    kind: 'script',
    ordinal,
    status: isFailure ? 'failed' : 'ok',
    exitCode: result.exitCode !== 0 ? result.exitCode : undefined,
    durationMs,
  };

  return {
    outcome,
    shouldAbort: isFailure,
    exitCode: result.exitCode,
  };
}

/**
 * Run a capture block (patch or outputs). Best-effort: failure logs escape.failed
 * and returns a 'failed' outcome, but DOES NOT abort the pipeline.
 */
async function runCaptureBlock(
  block: Extract<BlockSpec, { kind: 'capture' }>,
  ordinal: number,
  ctx: BlockContext,
): Promise<{ outcome: BlockOutcome; patchRef?: string; outputs?: OutputEntry[] }> {
  const startedAt = Date.now();

  if (block.what === 'patch') {
    try {
      const patchRef = await capturePatch({
        workspaceDir: ctx.workspaceDir,
        storage: ctx.storage,
        namespace: ctx.namespace,
        dispatchId: ctx.dispatchId,
        baseline: ctx.baseline,
      });
      const durationMs = Date.now() - startedAt;
      const outcome: BlockOutcome = {
        kind: 'capture',
        ordinal,
        status: 'ok',
        durationMs,
        patchRef,
      };
      return { outcome, patchRef };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      ctx.log({
        kind: 'escape.failed',
        dispatchId: ctx.dispatchId,
        detail: (err as Error).message,
      });
      const outcome: BlockOutcome = {
        kind: 'capture',
        ordinal,
        status: 'failed',
        durationMs,
      };
      return { outcome };
    }
  } else {
    // what === 'outputs'
    try {
      const outputs = await captureOutputs({
        workspaceDir: ctx.workspaceDir,
        storage: ctx.storage,
        namespace: ctx.namespace,
        dispatchId: ctx.dispatchId,
      });
      const durationMs = Date.now() - startedAt;
      const outcome: BlockOutcome = {
        kind: 'capture',
        ordinal,
        status: 'ok',
        durationMs,
        outputs,
      };
      return { outcome, outputs };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      ctx.log({
        kind: 'escape.failed',
        dispatchId: ctx.dispatchId,
        detail: (err as Error).message,
      });
      const outcome: BlockOutcome = {
        kind: 'capture',
        ordinal,
        status: 'failed',
        durationMs,
      };
      return { outcome };
    }
  }
}

// ---------------------------------------------------------------------------
// runPipeline
// ---------------------------------------------------------------------------

/**
 * Execute spec.blocks in order, then auto-append seal (writeSentinel) on the
 * completed path.
 *
 * Gate failure (script gate non-zero/timeout/start-error, agent non-zero exit):
 *   → 'failed' with exit code, no sentinel, no further blocks.
 * Agent needs_input:
 *   → 'needs-input', no sentinel, no further blocks.
 * Adapter throw:
 *   → propagates out of runPipeline (chassis maps it to worker-failed).
 * Capture-block failures:
 *   → NOT a gate; log escape.failed, outcome status 'failed', pipeline continues.
 * Seal failure:
 *   → log escape.failed via ctx.log, result stays 'completed'.
 *
 * The `blocks` evidence is passed to writeSentinel ONLY when opts.declared.
 * The FIRST verify-lens outcome populates sentinel.verify either way.
 */
export async function runPipeline(
  spec: PipelineSpec,
  ctx: BlockContext,
  opts: { declared: boolean },
): Promise<PipelineResult> {
  const outcomes: BlockOutcome[] = [];

  // Aggregates for the seal
  let lastPatchRef: string | undefined;
  let firstVerifyOutcome: VerifyOutcome | undefined;
  let lastOutputs: OutputEntry[] | undefined;
  let aggregatedUsage: RuntimeUsage | undefined;

  for (const [index, block] of spec.blocks.entries()) {
    const ordinal = index;

    if (block.kind === 'agent') {
      // adapter.invoke throws → propagates (no catch here)
      const agentResult = await runAgentBlock(ordinal, ctx);
      outcomes.push(agentResult.outcome);

      // Aggregate best-effort usage across agent blocks (for the seal).
      if (agentResult.usage !== undefined) {
        aggregatedUsage = mergeUsage(aggregatedUsage, agentResult.usage);
      }

      // needs_input: stop immediately, return needs-input (no sentinel)
      if (agentResult.needsInputSentinelPath) {
        return {
          kind: 'needs-input',
          sentinelPath: agentResult.needsInputSentinelPath,
          outcomes,
        };
      }

      // Non-zero exit: gate failure — abort, no sentinel
      if (agentResult.shouldAbort) {
        return {
          kind: 'failed',
          outcomes,
          exitCode: agentResult.exitCode ?? 1,
        };
      }
    } else if (block.kind === 'script') {
      const scriptResult = await runScriptBlock(block, ordinal, ctx);
      outcomes.push(scriptResult.outcome);

      // Capture the first verify-lens outcome for the sentinel
      if (scriptResult.verifyOutcome && firstVerifyOutcome === undefined) {
        firstVerifyOutcome = scriptResult.verifyOutcome;
      }

      // Gate abort
      if (scriptResult.shouldAbort) {
        return {
          kind: 'failed',
          outcomes,
          exitCode: scriptResult.exitCode ?? 1,
        };
      }
    } else if (block.kind === 'capture') {
      // NOT a gate — failure logs escape.failed, pipeline continues
      const captureResult = await runCaptureBlock(block, ordinal, ctx);
      outcomes.push(captureResult.outcome);

      // Track aggregates regardless of success/failure
      if (captureResult.patchRef !== undefined) {
        lastPatchRef = captureResult.patchRef;
      }
      if (captureResult.outputs !== undefined) {
        lastOutputs = captureResult.outputs;
      }
    } else {
      // Unrecognized block kind — log and fail the pipeline immediately.
      // Prevents invisible data loss when a future/corrupt spec reaches runtime.
      ctx.log({ kind: 'pipeline.unknown-block', ordinal, blockKind: (block as { kind?: string }).kind });
      return { kind: 'failed', outcomes, exitCode: 1 };
    }
    // Note: 'seal' is never authored — reserved, runner-appended (validated away by validatePipelineSpec)
  }

  // All blocks completed — auto-append seal (best-effort)
  let sentinel: OutputSentinel | undefined;
  try {
    sentinel = await writeSentinel({
      workspaceDir: ctx.workspaceDir,
      storage: ctx.storage,
      namespace: ctx.namespace,
      dispatchId: ctx.dispatchId,
      patchRef: lastPatchRef,
      verify: firstVerifyOutcome,
      outputs: lastOutputs,
      usage: aggregatedUsage,
      ...(opts.declared && outcomes.length > 0 ? { blocks: outcomes } : {}),
    });
  } catch (err) {
    ctx.log({
      kind: 'escape.failed',
      dispatchId: ctx.dispatchId,
      detail: (err as Error).message,
    });
  }

  return {
    kind: 'completed',
    outcomes,
    sentinel,
    declared: opts.declared,
  };
}
