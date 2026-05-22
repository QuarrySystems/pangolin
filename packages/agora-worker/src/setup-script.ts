// agora-worker: setup-script runner
//
// Executes the `agora-setup.sh` capability content after overlay completes,
// per agora-core spec §6.2 step 7 and §6.3.
//
// Execution is bounded by `AGORA_SETUP_TIMEOUT_SECONDS` (default 120 in the
// caller). Non-zero exit or timeout fails the dispatch with
// `reason: 'worker-failed'`; captured stdout/stderr is included in the
// worker's structured logs.

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";

export interface SetupScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Thrown when `agora-setup.sh` exits non-zero or is killed because the
 * configured timeout was exceeded. The carried `result` always includes
 * whatever stdout/stderr was captured before the failure.
 *
 * On timeout, `result.exitCode === -1`.
 */
export class SetupScriptError extends Error {
  constructor(public readonly result: SetupScriptResult) {
    super(`agora-setup.sh exited with code ${result.exitCode}`);
    this.name = "SetupScriptError";
  }
}

export interface RunSetupScriptOpts {
  workspaceDir: string;
  env: Record<string, string>;
  timeoutSeconds: number;
}

/**
 * Run `agora-setup.sh` in the given workspace if it exists, otherwise no-op.
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
  const scriptPath = join(opts.workspaceDir, "agora-setup.sh");
  try {
    await access(scriptPath);
  } catch {
    return null;
  }

  const start = Date.now();
  return new Promise<SetupScriptResult>((resolve, reject) => {
    const child = spawn("/bin/bash", [scriptPath], {
      cwd: opts.workspaceDir,
      env: opts.env,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      reject(
        new SetupScriptError({
          exitCode: -1,
          stdout,
          stderr,
          durationMs: Date.now() - start,
        }),
      );
    }, opts.timeoutSeconds * 1000);

    child.on("error", (err) => {
      clearTimeout(timer);
      if (timedOut) return;
      reject(err);
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      const result: SetupScriptResult = {
        exitCode: code ?? -1,
        stdout,
        stderr,
        durationMs: Date.now() - start,
      };
      if (result.exitCode !== 0) {
        reject(new SetupScriptError(result));
      } else {
        resolve(result);
      }
    });
  });
}
