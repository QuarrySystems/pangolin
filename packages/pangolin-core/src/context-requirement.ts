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
 *                `git init`-ed directory. This distinction is load-bearing: the
 *                worker's own `captureBaseline` runs `git init` without committing,
 *                so the two values differ precisely across that call.
 */
export type ContextRequirement =
  | { kind: 'paths'; glob: string; minCount?: number }
  | { kind: 'exec'; bin: string }
  | { kind: 'git'; needs: 'history' | 'worktree' };
