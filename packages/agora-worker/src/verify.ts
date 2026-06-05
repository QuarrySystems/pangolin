// agora-worker: self-verify runner (Gap A)
//
// After the runtime adapter produces its edit, the worker optionally runs a
// configured verify command in the workspace and REPORTS the result alongside
// the patch. The command is an arbitrary, LANGUAGE-AGNOSTIC shell string
// supplied by the subagent definition — e.g. `dotnet test`, `cargo test`,
// `pytest`, `go test ./...`, or `pnpm exec tsc --noEmit && pnpm vitest run`.
// The worker neither knows nor cares which toolchain it is; the toolchain
// comes from the worker image / workspace the operator supplies.
//
// Unlike the setup-script runner (which gates the dispatch by throwing on a
// non-zero exit), verify is report-only: a non-zero exit, a timeout, or a
// failure to start all resolve to `{ passed: false }`. It NEVER throws and
// never changes the dispatch outcome — it only adds a signal to the sealed
// output sentinel so the operator can read pass/fail without re-running by
// hand. Gating on verify is a deliberate future pull, not part of v1.

import type { VerifyOutcome } from "@quarry-systems/agora-core";
import { runBoundedCommand } from "./bounded-command.js";

export interface RunVerifyOpts {
  workspaceDir: string;
  /** Shell command string; run via `shell:true` (→ /bin/sh -c in the container). */
  command: string;
  env: Record<string, string>;
  timeoutSeconds: number;
  /** Max characters of captured output retained in `report`. */
  reportLimit?: number;
}

const DEFAULT_REPORT_LIMIT = 8_000;

function truncate(s: string, limit: number): string {
  return s.length <= limit ? s : s.slice(0, limit) + "\n…[truncated]";
}

/**
 * Run the verify command in the workspace, time-bounded, and report pass/fail.
 * Resolves (never rejects) with a {@link VerifyOutcome}. Report-only: a non-zero
 * exit, a timeout, or a failure to start all map to `passed: false`.
 */
export async function runVerify(opts: RunVerifyOpts): Promise<VerifyOutcome> {
  const limit = opts.reportLimit ?? DEFAULT_REPORT_LIMIT;
  const result = await runBoundedCommand({
    command: opts.command,
    cwd: opts.workspaceDir,
    env: opts.env,
    timeoutSeconds: opts.timeoutSeconds,
    maxOutputChars: limit,
  });

  let report: string;
  if (result.startError) {
    report = `[verify failed to start] ${result.startError.message}`;
  } else {
    report = result.stdout + result.stderr;
    if (result.timedOut) report += "\n[verify timed out]";
  }
  report = truncate(report, limit);

  return {
    passed: !result.timedOut && result.startError === undefined && result.exitCode === 0,
    report: report.length > 0 ? report : undefined,
    durationMs: result.durationMs,
  };
}
