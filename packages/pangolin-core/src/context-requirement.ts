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
      /**
       * Matched against each entry's path relative to the workspace root, with
       * `/` separators on every platform.
       *
       * Dialect, pinned so an evaluator cannot invent its own: `**` matches any
       * number of path segments, `*` matches any characters EXCEPT `/`, and
       * everything else is literal. There is no brace expansion, no character
       * class, and no special treatment of dotfiles — `.git/**` matches.
       *
       * DIRECTORIES COUNT AS MATCHES, not only files. `logs/**` is satisfied by
       * an empty `logs/sub/` directory. Require a file explicitly (`logs/*.txt`)
       * when that distinction matters.
       */
      glob: string;
      /**
       * Minimum number of matching entries required. Omitted means 1.
       *
       * A value below 1 is MALFORMED, not a permissive setting: a requirement
       * that zero matches satisfy is not a requirement. An evaluator must reject
       * it rather than clamp it — clamping would silently turn a typo into a
       * gate that can never fail, which is the failure mode this whole type
       * exists to remove.
       */
      minCount?: number;
    }
  | {
      kind: 'exec';
      /**
       * Resolved through the runtime `PATH`, NOT treated as a filesystem path —
       * `pnpm`, never `/usr/local/bin/pnpm`. The question asked is "can the
       * agent run this", so resolution uses the environment the agent will
       * receive, not the worker's own.
       */
      bin: string;
    }
  | { kind: 'git'; needs: 'history' | 'worktree' };
