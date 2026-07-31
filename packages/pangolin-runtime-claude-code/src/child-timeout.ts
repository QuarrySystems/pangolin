// Shared timeout enforcement for the adapter's two child processes: the
// `claude` run itself (claude-spawn.ts) and each `claude plugins install`
// (plugin-installer.ts). Both are spawned, both could hang, and neither had a
// bound — see KNOWN-ISSUES 9.
//
// Escalation is SIGTERM-then-SIGKILL rather than a bare SIGKILL: a terminated
// `claude` should get the chance to flush its output and remove partial state,
// and the captured stdout up to that point is worth keeping. SIGKILL is the
// backstop for a child that ignores or blocks on SIGTERM.
//
// The timers are `unref`'d so an armed timeout can never by itself keep the
// worker's event loop alive; the child's own stdio pipes do that while it runs.

/** Grace period between SIGTERM and SIGKILL when a child overruns its bound. */
export const DEFAULT_KILL_GRACE_SECONDS = 10;

export interface ChildTimeoutOptions {
  /**
   * Hard bound in seconds. Omitted or undefined means unbounded — the
   * pre-existing behaviour, kept so a caller that never sets it is unaffected.
   */
  timeoutSeconds?: number;
  /** Seconds to wait after SIGTERM before SIGKILL. Defaults to 10. */
  killGraceSeconds?: number;
}

/** The subset of `ChildProcess` this helper needs — keeps it trivially testable. */
interface Killable {
  kill(signal?: NodeJS.Signals): boolean;
  readonly pid?: number | undefined;
}

/**
 * True on platforms where a spawned child can lead its own process group, so a
 * negative-pid signal reaches its descendants too.
 */
const CAN_GROUP_KILL = process.platform !== 'win32';

/**
 * Spawn option that makes the child a process-group leader. Callers that use
 * `killTree` MUST spawn with this, or a signal reaches only the direct child.
 *
 * This is load-bearing, not incidental. `claude` spawns its own subprocesses;
 * signalling only the direct child leaves those descendants alive, still
 * holding the inherited stdout/stderr pipes — so `'close'` never fires and the
 * container hangs anyway, which is the exact failure this bound exists to
 * prevent. CI caught precisely that: a bash stub running `sleep 30` outlived
 * the SIGTERM sent to its parent and the test hung until vitest killed it.
 */
export const DETACH_FOR_GROUP_KILL = CAN_GROUP_KILL;

/**
 * Signal the child's whole process group, falling back to the direct child when
 * the group signal is unavailable (Windows) or the group is already gone.
 */
export function killTree(child: Killable, signal: NodeJS.Signals): void {
  if (CAN_GROUP_KILL && typeof child.pid === 'number') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // ESRCH (group already reaped) or EPERM — fall through to the direct kill.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already exited; nothing to signal.
  }
}

export interface ArmedTimeout {
  /** Cancel the timers. MUST be called when the child closes normally. */
  disarm(): void;
  /** True once the bound elapsed and SIGTERM was sent. */
  timedOut(): boolean;
  /** True once the grace period elapsed and SIGKILL was sent. */
  escalated(): boolean;
  /** Human-readable reason, or undefined if the bound never fired. */
  reason(): string | undefined;
}

/**
 * Arm a timeout against `child`. Returns a handle the caller disarms on
 * 'close'. A `timeoutSeconds` of undefined arms nothing and the returned handle
 * reports `timedOut() === false` forever.
 */
export function armChildTimeout(
  child: Killable,
  what: string,
  opts: ChildTimeoutOptions = {},
): ArmedTimeout {
  const seconds = opts.timeoutSeconds;
  let fired = false;
  let killed = false;

  if (seconds === undefined) {
    return {
      disarm: () => {},
      timedOut: () => false,
      escalated: () => false,
      reason: () => undefined,
    };
  }

  const graceSeconds = opts.killGraceSeconds ?? DEFAULT_KILL_GRACE_SECONDS;
  let escalationTimer: NodeJS.Timeout | undefined;

  const timer = setTimeout(() => {
    fired = true;
    killTree(child, 'SIGTERM');
    escalationTimer = setTimeout(() => {
      killed = true;
      killTree(child, 'SIGKILL');
    }, graceSeconds * 1000);
    escalationTimer.unref?.();
  }, seconds * 1000);
  timer.unref?.();

  return {
    disarm: () => {
      clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
    },
    timedOut: () => fired,
    escalated: () => killed,
    reason: () =>
      fired
        ? `${what} timed out after ${seconds}s — sent SIGTERM` +
          (killed ? `, then SIGKILL after a ${graceSeconds}s grace period` : '')
        : undefined,
  };
}
