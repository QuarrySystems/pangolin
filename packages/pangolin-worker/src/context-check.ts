// pangolin-worker: staged-workspace context requirement evaluator.
//
// Evaluates a requirement list against a real workspace directory and returns
// one result PER requirement — never fewer — because the failure detail must
// name which requirement failed and what was observed instead.
//
// Glob engine decision, made here rather than left open: reuse the existing
// `matchesGlob` from `overlay-engine.ts` (exported by this task for reuse)
// paired with `readdir(dir, { recursive: true })`. Rationale: a third glob
// matcher inside one package would diverge in semantics, and adding a
// dependency would put `package.json` + `pnpm-lock.yaml` in scope and route
// through `check:deps` (`ci.yml:53`). Do NOT reach for `fs.promises.glob` —
// it typechecks against the repo's `@types/node` and passes on CI's Node 22,
// then throws at runtime in the worker image, which is pinned to Node 20
// (`Dockerfile:23`).

import { access, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, delimiter } from 'node:path';
import type { ContextRequirement } from '@quarry-systems/pangolin-core';
import { matchesGlob } from './overlay-engine.js';

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
        const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
        let found = '';
        for (const d of dirs) {
          try {
            await access(join(d, requirement.bin));
            found = join(d, requirement.bin);
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
        let n = 0;
        try {
          // Short-circuit at `want`: the flagship glob is `node_modules/**`,
          // and continuing to walk matches past the point the requirement is
          // already decided would cost the cycle this check exists to save.
          for (const rel of await readdir(workspaceDir, { recursive: true })) {
            if (matchesGlob(String(rel).split('\\').join('/'), requirement.glob) && ++n >= want) {
              break;
            }
          }
        } catch {
          // workspaceDir does not exist or is unreadable — zero matches,
          // fail closed rather than throwing.
        }
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
        // history: >=1 commit, via `git rev-parse HEAD` — patch-capture.ts's
        // spawn is the repo's precedent for shelling out to git, but this
        // check runs against the CALLER'S env (mirroring the `exec` case
        // above), not a hardened env, because the question is "can the agent
        // resolve git", not "run git safely against untrusted content".
        // Both arms fail CLOSED when git cannot run at all.
        const gitEnv: Record<string, string> = { ...env };
        const args =
          requirement.needs === 'worktree'
            ? ['-C', workspaceDir, '-c', 'safe.directory=*', 'rev-parse', '--is-inside-work-tree']
            : ['-C', workspaceDir, '-c', 'safe.directory=*', 'rev-parse', 'HEAD'];

        let met = false;
        let observed = '';
        try {
          const result = await runGit(args, gitEnv);
          met = result.code === 0;
          observed = met
            ? `git ${requirement.needs} check passed`
            : `git ${requirement.needs} check failed: ${result.stderr.trim() || `exited ${result.code}`}`;
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

/** Spawn `git` with `args` against `env`. Resolves with the exit code and
 *  stderr text on ANY exit (including nonzero) so callers can distinguish
 *  "git ran and said no" from "git could not run at all" (which rejects). */
function runGit(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stderr: string }> {
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
    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        resolve({ code, stderr: Buffer.concat(stderrChunks).toString('utf8') });
      }
    });
  });
}
