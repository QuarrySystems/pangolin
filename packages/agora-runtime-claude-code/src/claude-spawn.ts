// Spawns `claude --print "<prompt>" [...extraArgs]` with the workspace as
// cwd and the merged env per §5.8. Captures stdout/stderr in memory and
// returns the exit code. Used by the adapter's `invoke()` after prompt
// rendering and plugin install.
//
// `env` is passed through verbatim — the caller is responsible for the
// merge policy (no implicit inheritance from `process.env`).
//
// A spawn-time error (e.g. binary not found) rejects the promise; a
// non-zero exit from the child resolves with that exit code so callers
// can distinguish operational failures from environment misconfiguration.

import { spawn } from "node:child_process";

export interface ClaudeSpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SpawnClaudeOptions {
  prompt: string;
  workspaceDir: string;
  env: Record<string, string>;
  claudeBin?: string;
  /** Additional arguments appended after `--print <prompt>`. */
  extraArgs?: ReadonlyArray<string>;
  /**
   * When true, inserts `--dangerously-skip-permissions` between `--print`
   * and the prompt so claude bypasses the interactive tool-call gate.
   * The adapter chooses this based on `AGORA_CLAUDE_PERMISSION_MODE`
   * (see adapter.ts). Spawn itself is policy-free.
   */
  dangerouslySkipPermissions?: boolean;
}

export async function spawnClaude(
  opts: SpawnClaudeOptions,
): Promise<ClaudeSpawnResult> {
  const bin = opts.claudeBin ?? "claude";
  const args = [
    "--print",
    ...(opts.dangerouslySkipPermissions ? ["--dangerously-skip-permissions"] : []),
    opts.prompt,
    ...(opts.extraArgs ?? []),
  ];

  return new Promise<ClaudeSpawnResult>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.workspaceDir,
      env: opts.env,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer | string) => {
      stdout += typeof d === "string" ? d : d.toString();
    });
    child.stderr?.on("data", (d: Buffer | string) => {
      stderr += typeof d === "string" ? d : d.toString();
    });

    child.on("error", (err: Error) => {
      reject(err);
    });
    child.on("close", (code: number | null) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}
