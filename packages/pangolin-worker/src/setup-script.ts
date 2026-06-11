// pangolin-worker: setup-script runner
//
// Executes the `pangolin-setup.sh` capability content after overlay completes,
// per pangolin-core spec §6.2 step 7 and §6.3.
//
// Execution is bounded by `PANGOLIN_SETUP_TIMEOUT_SECONDS` (default 120 in the
// caller). Non-zero exit or timeout fails the dispatch with
// `reason: 'worker-failed'`; captured stdout/stderr is included in the
// worker's structured logs.

import { access } from "node:fs/promises";
import { join } from "node:path";
import { runBoundedCommand } from "./bounded-command.js";

export interface SetupScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Thrown when `pangolin-setup.sh` exits non-zero or is killed because the
 * configured timeout was exceeded. The carried `result` always includes
 * whatever stdout/stderr was captured before the failure.
 *
 * On timeout, `result.exitCode === -1`.
 */
export class SetupScriptError extends Error {
  constructor(public readonly result: SetupScriptResult) {
    super(`pangolin-setup.sh exited with code ${result.exitCode}`);
    this.name = "SetupScriptError";
  }
}

export interface RunSetupScriptOpts {
  workspaceDir: string;
  env: Record<string, string>;
  timeoutSeconds: number;
}

/**
 * Run `pangolin-setup.sh` in the given workspace if it exists, otherwise no-op.
 *
 * - Returns `null` when the script is absent.
 * - Resolves to a `SetupScriptResult` (exitCode 0, stdout/stderr captured)
 *   on success.
 * - Rejects with `SetupScriptError` on non-zero exit.
 * - Rejects with `SetupScriptError` (exitCode -1) when the script exceeds
 *   `timeoutSeconds`; the child is SIGKILLed.
 */
export async function runSetupScriptIfPresent(
  opts: RunSetupScriptOpts,
): Promise<SetupScriptResult | null> {
  const scriptPath = join(opts.workspaceDir, "pangolin-setup.sh");
  try {
    await access(scriptPath);
  } catch {
    return null;
  }

  const r = await runBoundedCommand({
    command: "/bin/bash",
    args: [scriptPath],
    cwd: opts.workspaceDir,
    env: opts.env,
    timeoutSeconds: opts.timeoutSeconds,
  });

  // A spawn failure (e.g. no /bin/bash) is a real error, not a script result.
  if (r.startError) throw r.startError;

  const result: SetupScriptResult = {
    exitCode: r.exitCode,
    stdout: r.stdout,
    stderr: r.stderr,
    durationMs: r.durationMs,
  };
  // Timeout (exitCode -1) and any non-zero exit fail the dispatch.
  if (r.timedOut || result.exitCode !== 0) throw new SetupScriptError(result);
  return result;
}
