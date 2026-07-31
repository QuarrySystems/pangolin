// Spawns `claude --print --output-format json [...flags] "<prompt>" [...extraArgs]`
// with the workspace as cwd and the merged env per §5.8. Captures stdout/stderr
// in memory and returns the exit code. Used by the adapter's `invoke()` after
// prompt rendering and plugin install.
//
// `env` is passed through verbatim — the caller is responsible for the
// merge policy (no implicit inheritance from `process.env`).
//
// A spawn-time error (e.g. binary not found) rejects the promise; a
// non-zero exit from the child resolves with that exit code so callers
// can distinguish operational failures from environment misconfiguration.

import { spawn } from 'node:child_process';
import {
  armChildTimeout,
  DETACH_FOR_GROUP_KILL,
  type ChildTimeoutOptions,
} from './child-timeout.js';

/**
 * Exit code reported when the agent overran `timeoutSeconds`. 124 is the
 * conventional timeout status (GNU `timeout` uses it), so it is distinguishable
 * from any exit the agent itself could plausibly produce.
 */
export const TIMEOUT_EXIT_CODE = 124;

export interface ClaudeSpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SpawnClaudeOptions extends ChildTimeoutOptions {
  prompt: string;
  workspaceDir: string;
  env: Record<string, string>;
  claudeBin?: string;
  /** Additional arguments appended after `--print <prompt>`. */
  extraArgs?: ReadonlyArray<string>;
  /**
   * When true, inserts `--dangerously-skip-permissions` between `--output-format json`
   * and the prompt so claude bypasses the interactive tool-call gate.
   * The adapter chooses this based on `PANGOLIN_CLAUDE_PERMISSION_MODE`
   * (see adapter.ts). Spawn itself is policy-free.
   */
  dangerouslySkipPermissions?: boolean;
  /**
   * When provided, passes `--model <model>` to the claude CLI.
   * The caller is responsible for resolving level aliases (fast/standard/max)
   * to actual model IDs before passing here. See adapter.ts + model-map.ts.
   */
  model?: string;
}

/**
 * Result for a run the bound terminated. stdout captured before the kill is
 * preserved — a partial transcript is often the only evidence of where the
 * agent got stuck.
 */
function timedOutResult(stdout: string, stderr: string, reason: string): ClaudeSpawnResult {
  const line = `pangolin: ${reason}`;
  return {
    exitCode: TIMEOUT_EXIT_CODE,
    stdout,
    stderr: stderr ? `${stderr}\n${line}` : line,
  };
}

/** Pure arg construction — exported for platform-independent testing. */
export function buildClaudeArgs(
  opts: Pick<SpawnClaudeOptions, 'prompt' | 'dangerouslySkipPermissions' | 'model' | 'extraArgs'>,
): string[] {
  return [
    '--print',
    '--output-format',
    'json',
    ...(opts.dangerouslySkipPermissions ? ['--dangerously-skip-permissions'] : []),
    ...(opts.model ? ['--model', opts.model] : []),
    opts.prompt,
    ...(opts.extraArgs ?? []),
  ];
}

export async function spawnClaude(opts: SpawnClaudeOptions): Promise<ClaudeSpawnResult> {
  const bin = opts.claudeBin ?? 'claude';
  const args = buildClaudeArgs(opts);

  return new Promise<ClaudeSpawnResult>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.workspaceDir,
      env: opts.env,
      // Own process group, so a timeout can signal `claude`'s descendants too.
      // Without it a killed agent's children survive holding the stdout pipe.
      detached: DETACH_FOR_GROUP_KILL,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer | string) => {
      stdout += typeof d === 'string' ? d : d.toString();
    });
    child.stderr?.on('data', (d: Buffer | string) => {
      stderr += typeof d === 'string' ? d : d.toString();
    });

    // A timeout is an operational failure of the run, not an environment
    // misconfiguration, so it RESOLVES with a non-zero code per this file's
    // documented split — the worker then reports a failed dispatch with a
    // reason instead of a container that never exits.
    const timeout = armChildTimeout(child, 'claude agent', opts);

    let settled = false;

    child.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      timeout.disarm();
      reject(err);
    });

    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      timeout.disarm();
      if (timeout.timedOut()) {
        resolve(timedOutResult(stdout, stderr, timeout.reason()!));
        return;
      }
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });

    // Timeout-path safety net. 'close' waits for every inherited pipe to be
    // released, so a descendant that survived the kill would otherwise hang
    // this promise forever — the very outcome the bound exists to prevent, and
    // exactly what CI caught. 'exit' fires on process exit regardless of stdio,
    // so once we have killed the child we settle from whichever arrives first.
    // Only ever reached after a timeout, so the normal path still resolves on
    // 'close' and keeps its flush guarantee.
    child.on('exit', () => {
      if (settled || !timeout.timedOut()) return;
      settled = true;
      timeout.disarm();
      resolve(timedOutResult(stdout, stderr, timeout.reason()!));
    });
  });
}
