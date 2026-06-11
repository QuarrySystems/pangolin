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
    const child = spawn('git', [
      '-C', dir,
      '-c', 'safe.directory=*',
      '-c', 'user.email=pangolin@local',
      '-c', 'user.name=pangolin',
      '-c', 'commit.gpgsign=false',
      ...args,
    ]);

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

    child.on('exit', (code, signal) => settle(() => {
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks).toString('utf8'));
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const reason = signal ? `killed by ${signal}` : `exited ${code}`;
      reject(new Error(`git ${args.join(' ')} ${reason}: ${stderr}`));
    }));
  });
}
