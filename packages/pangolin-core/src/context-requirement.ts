// @quarry-systems/pangolin-core — staged-workspace context requirements.

/**
 * A property of the staged workspace that can be OBSERVED, not inferred.
 *
 * Deliberately excludes anything asserting intent — "patch applied", "snapshot at
 * revision" — because verifying those requires the diff and the base, which is
 * re-doing the work rather than checking it.
 *
 * `git.needs` semantics, fixed here so two implementers cannot diverge:
 *   'worktree' — a `.git` entry exists and the directory is usable as a working
 *                tree. TRUE for a freshly `git init`-ed directory with no commits.
 *   'history'  — the repository has at least ONE COMMIT. FALSE for a freshly
 *                `git init`-ed directory. This distinction is load-bearing: on a
 *                workspace that is not already a git repository, the worker's own
 *                `captureBaseline` (which runs `git init` without committing) makes
 *                'worktree' satisfiable while leaving 'history' unsatisfiable — the
 *                two values diverge exactly there.
 */
export type ContextRequirement =
  | {
      kind: 'paths';
      /** Matched relative to the workspace root. */
      glob: string;
      /** Minimum number of matches required. Omitted means 1 — never 0; a
       *  requirement that zero matches satisfy is not a requirement. */
      minCount?: number;
    }
  /** `bin` is resolved through PATH, not treated as a filesystem path. */
  | { kind: 'exec'; bin: string }
  | { kind: 'git'; needs: 'history' | 'worktree' };
