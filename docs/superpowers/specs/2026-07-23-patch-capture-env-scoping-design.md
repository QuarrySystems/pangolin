---
title: Patch-Capture Git Spawn — Environment Scoping — Design Spec
date: 2026-07-23
status: draft
branch: security/worker-credential-custody
authors: [human:Brett, agent:claude-opus-4-8]
severity: high (verified credential exposure to sandboxed model-driven code)
supersedes: the F1 half of the withdrawn "Worker Credential Custody" draft; its F2 half was falsified in audit and moved to the sibling spec below
related:
  - ./2026-07-23-worker-env-block-exposure-design.md # the /proc path this spec does NOT close
  - ./2026-07-23-callback-delivery-reliability-design.md # sibling child-0 change; no file overlap
  - stoa://agora/tasks/task-patch-capture-silently-drops-every-edit-inside-a-nested-repository-gitlink # the adjacent defect in §5
  - C:/Users/brett/source/repos/My_Projects/ai-os/docs/superpowers/specs/2026-07-22-pangolin-dispatch-seam-charter.md # ai-os charter §6.2, where this was found (branch feat/pangolin-seam-charter)
---

# Patch-Capture Git Spawn — Environment Scoping — Design Spec

> **One line:** `patch-capture.ts` is the only subprocess in the worker that inherits the worker's full
> environment, and it runs `git` against a workspace the agent controls — so a repo-local `.git/config`
> hook executes **with the worker's credentials**. Pass git an explicit, minimal environment. That is the
> whole change.

---

## 1. The defect

### 1.1 The escape (reproduced twice, independently)

Three facts compose:

1. `captureBaseline` runs `git init -q` (`patch-capture.ts:19`) **before the adapter**
   (`entrypoint.ts:453`), so `.git/` exists in the workspace.
2. The agent's cwd **is** that workspace (`claude-spawn.ts:66`), it runs as the same uid
   (`Dockerfile:71` creates one user, `:102` is `USER pangolin:pangolin`, nothing re-escalates), and
   permission bypass is on by default (`adapter.ts:103-113`, `resolveBypassFlag` defaulting to `bypass`
   at `:105`). So `.git/config` is agent-writable.
3. Ordinary `git add` / `git diff` execute commands named by repo-local config — `core.fsmonitor`,
   `filter.<n>.clean`, `diff.<n>.textconv`, `core.hooksPath`.

`patch-capture.ts:63` spawns git with **no `env` option**, so the hook inherits the worker's full
`process.env`.

Reproduced 2026-07-22 with real git, and reproduced independently in audit against `node:20-slim` +
git 2.39.5 (the base image per `Dockerfile:59`, `:66`): a repo-local `core.fsmonitor` **executed during
`git add -A`** and read back a planted `AWS_SESSION_TOKEN` verbatim.

**The tampering is invisible to review.** Git never tracks `.git/`, so a planted config never appears in
the produced patch — a consumer reviewing the patch cannot see that the run was compromised.

### 1.2 Why environment scoping is the fix rather than a fix

The agent already has arbitrary code execution as uid 1000 — it *is* the agent. This defect does not
grant execution; it grants **the worker's ambient environment**. Scoping the spawn's environment removes
the payoff, which is why the change is small.

`patch-capture.ts:63` is the **only** inheriting spawn in the repo. Every other command path passes an
explicit `env`: `bounded-command.ts:64-65`, `verify.ts:47`, `setup-script.ts:66`, `claude-spawn.ts:67`,
`plugin-installer.ts:52`. This change makes the codebase consistent rather than special-cased.

### 1.3 What this spec does NOT close

**A repo-local `.git/config` hook still executes.** After this change it runs as the worker's child, in
the worker's process tree, with an environment worth nothing — but it runs, and it can detach and outlive
the agent. This spec accepts that: the agent already had execution, and the hook gains it nothing. It is
stated because §3 relies on it, and because an earlier draft both used and dismissed the same capability.

**The worker's exec-time environment block remains readable at `/proc/<pid>/environ`.** Same uid, no
`hidepid`. That is a separate, verified exposure with a different mechanism and its own spec
(`2026-07-23-worker-env-block-exposure-design.md`). **This change does not reduce it**, and the two must
not be conflated — an earlier draft did, and specified a fix that could not work.

---

## 2. Design

`patch-capture.ts`'s private `git()` helper passes an explicit `env` instead of inheriting.

| Variable | Value | Why |
|---|---|---|
| `PATH` | `process.env.PATH` when set, else `/usr/local/bin:/usr/bin:/bin` | explicit rather than relying on glibc's `/bin:/usr/bin` `execvp` fallback |
| `HOME` | the literal `/nonexistent` | a fixed value with no directory to create, own, or clean up |
| `GIT_CONFIG_GLOBAL` | `/dev/null` | neutralises `~/.gitconfig` and `$XDG_CONFIG_HOME/git/config` |
| `GIT_CONFIG_NOSYSTEM` | `1` | neutralises `/etc/gitconfig` |
| `GIT_TERMINAL_PROMPT` | `0` | capture must never block on a credential prompt |
| `LC_ALL` | `C` | deterministic output; capture parses git's stdout |

Everything else — every `AWS_*`, every `PANGOLIN_*`, `ANTHROPIC_API_KEY`, and anything a future deploy
adds — is **absent**. This is an allow-list, and §4.1 tests it as one.

The existing `-C <dir>` form and the `-c safe.directory=*` / `user.email` / `user.name` /
`commit.gpgsign=false` overrides are unchanged.

**Verified to work, not assumed.** Audit ran the exact `captureBaseline` → `computeWorkspacePatch`
sequence under precisely this environment in the base image: `init` / `add` / `write-tree` / `add` /
`diff --cached <tree> -- . :(exclude).pangolin` all exit 0 with the correct diff. **`GIT_EXEC_PATH` is
not needed** — git injects it and prepends `/usr/lib/git-core` to `PATH` itself. Nor are
`LD_LIBRARY_PATH`, `LANG`, `TMPDIR`, or `XDG_*`. With a hook planted, the captured environment contained
only `GIT_EXEC_PATH`, `HOME`, `GIT_CONFIG_*`, `GIT_PREFIX`, `GIT_CONFIG_PARAMETERS`, `PATH`,
`GIT_TERMINAL_PROMPT`, `LC_ALL`, `PWD` — nothing credential-bearing.

**On proxy variables.** `runtime-env-filter.ts:17-18` flags `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` /
`NODE_EXTRA_CA_CERTS` as a migration concern for the *agent*. They are irrelevant here: this helper runs
only local plumbing (`init`, `add`, `write-tree`, `diff`) and never performs network I/O. Stated because
a reviewer will otherwise ask.

**Testability seam.** Environment construction is extracted into an exported pure function —
`buildGitEnv(): Record<string, string>` — so §4.1 can assert the exact key set without injecting a fake
`spawn` and without `vi.mock('node:child_process')`. The private `git()` helper calls it. This is the
only public-surface change, and it exists so the fix is falsifiable.

---

## 3. Non-goals, with reasons

- **Closing the `/proc` path.** Different mechanism, different blast radius, its own spec (§1.3). Named
  here so nobody assumes this change covers it.
- **`GIT_DIR` relocation.** Buys nothing **for the credential path** once this lands, and at a shared uid
  it is obscurity rather than a boundary — the agent can write wherever the worker can. It *would* close
  the still-executing-hook path §1.3 accepts; that is a capture-integrity concern, not a credential one,
  and not worth the behaviour change here.
- **uid separation.** Not available: the container is non-root with no `sudo` and no `setcap`.
  `node:20-slim` does ship suid-root binaries (`/usr/bin/{passwd,su,chfn,chsh,mount,umount,newgrp,gpasswd}`),
  but root's `/etc/shadow` entry is locked (`*`), so `su` grants nothing. Note the narrow claim: uid
  separation **for the git subprocess** would not close this path, because a hook running as another uid
  with an inherited environment still reads the same variables. Separating the **agent** is a different
  proposition — it *would* close the `/proc` path — and belongs to the sibling spec.
- **Nested-repo patch capture.** Verified broken independently (§5); logged, not fixed. This change must
  not alter it, and §4.5 pins it.
- **Constraining what the agent may execute.** Out of scope by construction — §1.2.

---

## 4. Testing

**The acceptance bar is that tests 1 and 2 fail against current `main`.** Test 5 pins existing behaviour
and must pass both before and after.

1. **The environment is exactly the allow-list.** Assert `buildGitEnv()` returns **exactly** the six keys
   — an equality assertion on the key set, not "contains no `AWS_*`". A deny-list assertion would pass a
   partial implementation that leaked `ANTHROPIC_API_KEY` or a credential variable added by a future
   deploy.
2. **End-to-end: a planted hook learns nothing.** Build a workspace with a repo-local `core.fsmonitor`
   pointing at a script that writes its own environment to a file, run the real
   `captureBaseline` → `computeWorkspacePatch` sequence with credential variables present in the worker's
   environment, and assert the captured environment contains none of them. This reproduces the original
   finding, so it must fail before the fix. **POSIX-only** — a shell-script hook is a cross-platform
   hazard the existing five tests avoid; skip on `win32`. CI is `ubuntu-latest` with git present
   (`.github/workflows/ci.yml`), so it runs where it matters.
3. **Capture still works under the scoped environment.** The existing five `patch-capture.test.ts` cases
   pass unmodified — this changes the environment, not the capture contract.
4. **`HOME=/nonexistent` is harmless.** Exercise the full sequence with that value in the base image and
   assert exit 0 and a correct diff. This is the row most likely to cause a silent regression.
5. **Characterisation: nested-repo capture is unchanged.** With a committed repo inside the workspace and
   edits both inside and outside it, assert the patch is non-null, **contains** the top-level change, and
   **does not contain** the nested edit. Passes before and after.

**Why silent regression is the risk to design against.** `captureBaseline` swallows its own errors and
returns `{ unavailable: true }` (`patch-capture.ts:23-25`), and `computeWorkspacePatch` returns `null` on
throw (`:46-48`). Capture broken by this change would produce empty patches on successful dispatches with
no log line. There is no runtime kill-switch and none is proposed — the change has no config surface, so
**the pre-merge tests are the gate**, not production observation. If it regresses, revert.

---

## 5. Adjacent defect found while investigating (logged, not fixed)

**Patch capture silently drops every edit inside a nested repository.** Git records a nested `.git` as a
**gitlink** — a pointer to that repo's HEAD. An agent editing files inside it does not move HEAD, so the
gitlink is byte-identical and the diff is empty. Reproduced twice: a top-level new file appeared in the
patch; an edit inside the nested repo did not, with exit 0 and no error.

**The signal exists and is discarded.** Audit found git emits `warning: adding embedded git repository`
on stderr at baseline time, and `git()` returns only stdout on exit 0 (`patch-capture.ts:89-91`),
dropping stderr. Detecting this is therefore cheaper than it looks.

Logged as `agora` wiki task
`task-patch-capture-silently-drops-every-edit-inside-a-nested-repository-gitlink`, which carries the
reproduction and four candidate fix shapes. Out of scope here; §4.5 pins the behaviour.

---

## 6. Documentation this change obliges

- **`docs-site/src/content/docs/explanation/threat-model.md`** — the *Identity theft* row states the
  mitigation as *"the worker→runtime env firewall is default-DENY … every `PANGOLIN_*` var and the whole
  AWS credential chain are dropped"*, with an Honest-limit column mentioning only the
  `PANGOLIN_RUNTIME_ENV_ALLOW` footgun. **That mitigation does not hold as written** — the agent need not
  run `env`/`printenv`, it reads `/proc/1/environ`. The Honest-limit column must state the shared-uid
  reality. This is a correction of *current* fact, independent of either fix, so it ships with whichever
  lands first — this one. The claim recurs in the diagram (`:48`) and at `:97`.
- **`packages/pangolin-worker/src/runtime-env-filter.ts:19-20`** — the comment *"git is unaffected:
  patch-capture spawns git with the worker's own unfiltered process.env"* becomes false the moment this
  lands, and must be updated in the same change.

---

## 7. Verification

Repo gate: `pnpm lint && pnpm typecheck && pnpm test`, plus `pnpm check:deps`.

Beyond the gate, the PR should record one run of §4.2 against the **built worker image** rather than the
base image — the base-image reproduction is strong evidence, but the shipped image is the artifact that
matters.
