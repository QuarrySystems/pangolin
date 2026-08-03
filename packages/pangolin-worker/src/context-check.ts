// pangolin-worker: staged-workspace context requirement evaluator.
//
// Evaluates a requirement list against a real workspace directory and returns
// one result PER requirement — never fewer — because the failure detail must
// name which requirement failed and what was observed instead.
//
// Glob engine decision, made here rather than left open: reuse the existing
// `matchesGlob` from `overlay-engine.ts` (exported by this task for reuse).
// Rationale: a third glob matcher inside one package would diverge in
// semantics, and adding a dependency would put `package.json` +
// `pnpm-lock.yaml` in scope and route through `check:deps` (`ci.yml:53`).
// Do NOT reach for `fs.promises.glob` — it typechecks against the repo's
// `@types/node` and passes on CI's Node 22, then throws at runtime in the
// worker image, which is pinned to Node 20 (`Dockerfile:23`).
//
// The `paths` walk (below, `countGlobMatches`) reads one directory at a time
// via `readdir(dir, { withFileTypes: true })` rather than a single
// `readdir(dir, { recursive: true })` call, so it can return as soon as
// `minCount` is reached instead of materializing every path in the tree
// first. It builds each relative path by hand (`prefix + '/' + entry.name`)
// instead of reading `Dirent.parentPath` / `Dirent.path` — those two differ
// between Node 20 (worker image) and Node 22 (CI), which is exactly the
// Node-version hazard called out above for `fs.promises.glob`.

import { access, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, delimiter } from 'node:path';
import type { Dirent } from 'node:fs';
import type { ContextRequirement } from '@quarry-systems/pangolin-core';
import { matchesGlob } from './overlay-engine.js';
import { buildGitEnv } from './patch-capture.js';

export interface RequirementResult {
  requirement: ContextRequirement;
  met: boolean;
  observed: string;
}

/**
 * `env` is the MERGED runtime env — the same one the agent receives — not the
 * worker's `process.env`. Resolving `exec` (and `git`) against the worker's
 * PATH answers a different question than "can the agent run this".
 *
 * EXHAUSTIVE BY CONSTRUCTION: every branch pushes exactly one result, and the
 * default pushes `met:false`. A requirement producing NO result would read as
 * satisfied downstream (`results.filter(r => !r.met)` would be empty) — a
 * silently unchecked requirement, which is the failure this module exists to
 * prevent.
 *
 * FAIL-CLOSED, deliberately diverging from captureBaseline's best-effort
 * posture (patch-capture.ts:23-25): if `git` cannot be run at all, the
 * requirement is `met:false`, not "skip".
 */
export async function checkContextRequirements(
  workspaceDir: string,
  reqs: ContextRequirement[],
  env: Record<string, string>,
): Promise<RequirementResult[]> {
  const out: RequirementResult[] = [];
  for (const requirement of reqs) {
    switch (requirement.kind) {
      case 'exec': {
        // The question is "can the agent RUN this", so BOTH checks are needed
        // and neither alone is sufficient. Measured in the Linux worker image:
        //   access(0644 file, F_OK) -> pass   (why the default is wrong)
        //   access(0644 file, X_OK) -> fail   (X_OK catches the non-executable)
        //   access(directory,  X_OK) -> PASS  (X_OK does NOT catch a directory —
        //                                      on a dir the bit means traversable)
        // so the isFile() stat is what rejects a directory named `pnpm` sitting
        // on PATH. Platform caveat: Windows has no execute bit and degrades
        // X_OK to F_OK, so only the isFile() half is observable there; the full
        // distinction holds on the Linux image, which is where it matters.
        const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
        let found = '';
        for (const d of dirs) {
          const candidate = join(d, requirement.bin);
          try {
            const st = await stat(candidate);
            if (!st.isFile()) continue;
            await access(candidate, constants.X_OK);
            found = candidate;
            break;
          } catch {
            /* next */
          }
        }
        out.push({
          requirement,
          met: found !== '',
          observed: found || `not on PATH (${dirs.length} entries searched)`,
        });
        break;
      }
      case 'paths': {
        const want = requirement.minCount ?? 1;
        const n = await countGlobMatches(workspaceDir, requirement.glob, want);
        out.push({
          requirement,
          met: n >= want,
          observed: `${n} match(es) for ${requirement.glob}, wanted ${want}`,
        });
        break;
      }
      case 'git': {
        // worktree: `.git` present and usable, via `git rev-parse
        // --is-inside-work-tree` — TRUE for a freshly `git init`-ed dir with
        // no commits, per the type's pinned semantics.
        // history: >=1 commit, via `git rev-parse HEAD`.
        //
        // Spawned with `buildGitEnv()` (patch-capture.ts) — the SAME narrow,
        // credential-free six-key env `captureBaseline`/`computeWorkspacePatch`
        // use, NOT the merged runtime env `exec` above resolves against.
        // Two reasons this diverges from `exec`:
        //   1. `GIT_DIR`/`GIT_WORK_TREE`/`GIT_COMMON_DIR` riding on the merged
        //      env override `-C workspaceDir`, so git would answer about a
        //      DIFFERENT repository than the one being checked — a
        //      false-satisfied `met:true` for a workspace with no git at
        //      all, which is exactly the failure this module exists to
        //      prevent. A test pins this.
        //   2. it avoids handing the agent's credentials to a child process
        //      run against an agent-controlled `.git` tree —
        //      `patch-capture.ts`'s `git()` deliberately does the same.
        // The only thing carried over from the passed `env` is `PATH`,
        // because the question is still "can the agent resolve git", same
        // as the `exec` case above — not "run git safely against untrusted
        // content", which `buildGitEnv()`'s other five keys handle.
        // Both arms fail CLOSED when git cannot run at all.
        const base = buildGitEnv();
        const gitEnv: Record<string, string> = { ...base, PATH: env.PATH ?? base.PATH };
        // The three hardening flags mirror patch-capture.ts's `git()`. Verified
        // NOT live for `rev-parse` specifically — a repo-local
        // `core.fsmonitor` is not executed by either arm — but carried anyway
        // so the asymmetry is not a trap for whoever adds a `status`/`log`/
        // `diff` arm later, where it WOULD be live.
        const args = [
          '-C',
          workspaceDir,
          '-c',
          'safe.directory=*',
          '-c',
          'core.fsmonitor=false',
          '-c',
          'core.pager=cat',
          '-c',
          'core.hooksPath=/dev/null',
          'rev-parse',
          requirement.needs === 'worktree' ? '--is-inside-work-tree' : 'HEAD',
        ];

        let met = false;
        let observed = '';
        try {
          const result = await runGit(args, gitEnv);
          met = result.code === 0;
          const reason = result.signal ? `killed by ${result.signal}` : `exited ${result.code}`;
          observed = met
            ? `git ${requirement.needs} check passed`
            : `git ${requirement.needs} check failed: ${result.stderr.trim() || reason}`;
        } catch (err) {
          observed = `git unavailable: ${err instanceof Error ? err.message : String(err)}`;
        }
        out.push({ requirement, met, observed });
        break;
      }
      default: {
        const never: never = requirement;
        out.push({ requirement: never, met: false, observed: 'unknown requirement kind' });
      }
    }
  }
  return out;
}

/** Spawn `git` with `args` against `env`. Resolves with the exit code,
 *  signal, and stderr text on ANY exit (including nonzero) so callers can
 *  distinguish "git ran and said no" from "git could not run at all" (which
 *  rejects). Mirrors `killed by ${signal}` from patch-capture.ts's `git()`:
 *  a signal-killed process reports `code: null`, which reads misleadingly as
 *  `exited null` unless the signal is carried separately. */
function runGit(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { env });
    const stderrChunks: Buffer[] = [];

    child.stdout?.on('data', () => {
      /* discard */
    });
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    let settled = false;
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    // 'close' rather than 'exit': 'exit' can fire before the stderr stream has
    // finished flushing, and stderr IS the user-facing diagnostic here — losing
    // it would fall back to a bare `exited 128`. patch-capture.ts uses 'exit',
    // but there stderr is only error text; here it is the product.
    child.on('close', (code, signal) => {
      if (!settled) {
        settled = true;
        resolve({ code, signal, stderr: Buffer.concat(stderrChunks).toString('utf8') });
      }
    });
  });
}

/**
 * Count entries (files AND directories) beneath `baseDir` whose
 * workspace-relative path matches `glob`, stopping as soon as `want`
 * matches are found. A REAL short-circuit: each directory is read one at a
 * time, so an early match skips reading the rest of the tree entirely,
 * rather than the earlier approach of materializing every path up front and
 * only skipping further `matchesGlob` calls.
 *
 * Builds each relative path by hand with `/` as the separator — see the
 * module header for why this reads `Dirent.name` rather than
 * `Dirent.parentPath`/`Dirent.path`.
 *
 * An unreadable directory (including a nonexistent `baseDir`) counts as zero
 * matches for that subtree — fail closed, consistent with the rest of this
 * module, rather than throwing and discarding matches already found
 * elsewhere in the tree.
 *
 * COST, stated because the short-circuit only helps one direction: a MET
 * requirement stops at the first `want` matches and is cheap. An UNMET one
 * necessarily walks the entire tree — `.git` and `node_modules` included —
 * with no depth cap, entry cap, or timeout, on the pre-agent critical path.
 * That is bounded by one failing dispatch (the run fails immediately after),
 * so it is accepted rather than optimised; do not read the short-circuit as
 * making the miss case cheap. If that ever becomes a problem, the fix is to
 * prune descent using the glob's literal leading segment — `sub/**` need only
 * enter `sub`.
 */
async function countGlobMatches(baseDir: string, glob: string, want: number): Promise<number> {
  let n = 0;

  async function walk(dir: string, prefix: string): Promise<void> {
    if (n >= want) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable / nonexistent — zero matches for this subtree
    }
    for (const entry of entries) {
      if (n >= want) return;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (matchesGlob(rel, glob)) {
        n++;
        if (n >= want) return;
      }
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), rel);
      }
    }
  }

  await walk(baseDir, '');
  return n;
}
