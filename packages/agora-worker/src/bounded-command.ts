// agora-worker: bounded child-process runner.
//
// Shared by the setup-script runner (gates the dispatch) and the self-verify
// runner (report-only). Spawns a command, captures stdout/stderr (each sliced
// to a budget so a chatty command can't balloon memory), bounds it by a
// timeout, and on timeout SIGKILLs the whole PROCESS GROUP (not just the
// shell) so a `sh -c "tsc && vitest"` doesn't orphan its grandchildren.
//
// Never rejects: callers inspect `timedOut` / `startError` / `exitCode`.

import { spawn } from "node:child_process";

export interface BoundedCommandResult {
  /** Process exit code; -1 when it timed out or failed to start. */
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** Set when the process could not be spawned at all. */
  startError?: Error;
}

export interface RunBoundedCommandOpts {
  command: string;
  /** When provided, the command is run directly (no shell). When omitted, the
   *  command is a shell string run via `shell: true` (→ `/bin/sh -c`). */
  args?: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutSeconds: number;
  /** Per-stream character cap. Unbounded when omitted. */
  maxOutputChars?: number;
}

// Group-kill on POSIX (the worker's real runtime) so shells don't orphan their
// children; plain kill on win32 (the dev/test host), where negative-pid group
// signals are unsupported.
function killTree(child: { pid?: number; kill: (sig: NodeJS.Signals) => boolean }): void {
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, "SIGKILL");
      return;
    }
  } catch {
    // fall through to a direct kill
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // process already gone
  }
}

export async function runBoundedCommand(
  opts: RunBoundedCommandOpts,
): Promise<BoundedCommandResult> {
  const cap = opts.maxOutputChars;
  const start = Date.now();
  const detached = process.platform !== "win32";

  return new Promise<BoundedCommandResult>((resolve) => {
    const child = opts.args
      ? spawn(opts.command, opts.args, { cwd: opts.cwd, env: opts.env, detached })
      : spawn(opts.command, { cwd: opts.cwd, env: opts.env, shell: true, detached });

    let stdout = "";
    let stderr = "";
    // Slice each chunk to the remaining budget so interim buffers stay bounded.
    const appender = (get: () => string, set: (s: string) => void) => (d: Buffer): void => {
      const cur = get();
      if (cap !== undefined && cur.length >= cap) return;
      const chunk = d.toString();
      const next = cap === undefined ? cur + chunk : cur + chunk.slice(0, cap - cur.length);
      set(next);
    };
    child.stdout?.on("data", appender(() => stdout, (s) => { stdout = s; }));
    child.stderr?.on("data", appender(() => stderr, (s) => { stderr = s; }));

    let settled = false;
    let timedOut = false;
    const finish = (r: Omit<BoundedCommandResult, "durationMs">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...r, durationMs: Date.now() - start });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      finish({ exitCode: -1, stdout, stderr, timedOut: true });
    }, opts.timeoutSeconds * 1000);

    child.on("error", (err) => {
      if (timedOut) return;
      finish({ exitCode: -1, stdout, stderr, timedOut: false, startError: err });
    });

    child.on("exit", (code) => {
      if (timedOut) return;
      finish({ exitCode: code ?? -1, stdout, stderr, timedOut: false });
    });
  });
}
