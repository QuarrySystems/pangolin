// pangolin-worker: git-based workspace diff capturer
//
// captureBaseline  — snapshots the post-overlay/post-setup tree WITHOUT
//                    committing (no HEAD movement, no pre-existing repo
//                    pollution). Returns an opaque tree OID.
// computeWorkspacePatch — produces the unified diff of subsequent changes,
//                         excluding .pangolin/. Pure of storage/sentinel concerns.

import { spawn } from 'node:child_process';

/** Opaque baseline handle (a git tree oid, or unavailable when git can't run). */
export type WorkspaceBaseline = { treeOid: string } | { unavailable: true };

/** Init (idempotent) + stage everything + write-tree. No commit, no HEAD move.
 *  Returns { unavailable: true } if git cannot run — capture is best-effort and
 *  never fails the dispatch. */
export async function captureBaseline(workspaceDir: string): Promise<WorkspaceBaseline> {
  try {
    await git(workspaceDir, ['init', '-q']);
    await git(workspaceDir, ['add', '-A']);
    const treeOid = (await git(workspaceDir, ['write-tree'])).trim();
    return { treeOid };
  } catch {
    return { unavailable: true };
  }
}

/** Stage current state and diff it against the baseline tree, excluding .pangolin/.
 *  Returns the unified-diff bytes, or null when no change / no baseline. */
export async function computeWorkspacePatch(
  workspaceDir: string,
  baseline: WorkspaceBaseline,
): Promise<Uint8Array | null> {
  if ('unavailable' in baseline) return null;
  try {
    await git(workspaceDir, ['add', '-A']);
    const diff = await git(workspaceDir, [
      'diff',
      // `diff.external` and `diff.<driver>.textconv` also execute commands, and
      // unlike fsmonitor/pager they are per-driver, so no single `-c` disables
      // them — these flags are the only complete answer.
      '--no-ext-diff',
      '--no-textconv',
      '--cached',
      baseline.treeOid,
      '--',
      '.',
      ':(exclude).pangolin',
    ]);
    return diff.length === 0 ? null : new TextEncoder().encode(diff);
  } catch {
    return null;
  }
}

/** The complete environment `git` runs with. Exported so the allow-list is assertable as a set.
 *  Everything absent is the point: no AWS_*, no PANGOLIN_*, nothing a future deploy adds. */
export function buildGitEnv(): Record<string, string> {
  return {
    // Node resolves the `git` binary through the PASSED env; omitting this risks ENOENT.
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    // A fixed value with no directory to create, own, or clean up. ~/.gitconfig is a live
    // attack vector (HOME is in runtime-env-filter's BUILTIN_ALLOW), and GIT_CONFIG_GLOBAL
    // below neutralises it regardless.
    HOME: '/nonexistent',
    GIT_CONFIG_GLOBAL: '/dev/null', // kills ~/.gitconfig and $XDG_CONFIG_HOME/git/config
    GIT_CONFIG_NOSYSTEM: '1', // kills /etc/gitconfig
    GIT_TERMINAL_PROMPT: '0', // capture must never block on a credential prompt
    LC_ALL: 'C', // deterministic stdout; capture parses it
  };
}

/**
 * Spawn `git -C <dir>` with fixed config for a clean/non-interactive container
 * context:
 *   -c safe.directory=* -c user.email=pangolin@local -c user.name=pangolin
 *   -c commit.gpgsign=false
 *
 * Resolves with stdout (utf-8) on exit code 0; rejects on nonzero exit
 * (includes stderr in the error message). Uses spawn (not exec) to avoid
 * shell quoting issues with the ':(exclude).pangolin' pathspec.
 */
function git(dir: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      'git',
      [
        '-C',
        dir,
        '-c',
        'safe.directory=*',
        '-c',
        'user.email=pangolin@local',
        '-c',
        'user.name=pangolin',
        '-c',
        'commit.gpgsign=false',
        // Neutralise repo-local config directives that make git EXECUTE a
        // command. GIT_CONFIG_GLOBAL/GIT_CONFIG_NOSYSTEM in buildGitEnv() kill
        // ~/.gitconfig and /etc/gitconfig, but neither touches the workspace's
        // own .git/config — and capture runs against a tree the agent (or, for
        // a review-before-merge consumer, an untrusted contributor) controls.
        // `-c` beats repo-local config, so these win.
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.pager=cat',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      { env: buildGitEnv() },
    );

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    child.on('error', (err) => settle(() => reject(err)));

    child.on('exit', (code, signal) =>
      settle(() => {
        if (code === 0) {
          resolve(Buffer.concat(stdoutChunks).toString('utf8'));
          return;
        }
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        const reason = signal ? `killed by ${signal}` : `exited ${code}`;
        reject(new Error(`git ${args.join(' ')} ${reason}: ${stderr}`));
      }),
    );
  });
}
