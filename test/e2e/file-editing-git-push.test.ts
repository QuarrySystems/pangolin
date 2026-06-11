// E2E contract: §6.5 — file-editing dispatch produces a real git push.
//
// §6.5 spells out the file-editing pattern: the worker filesystem is
// ephemeral, there is no built-in "clone before exec" step, and code-
// modifying dispatches are emergent from
//
//   (a) a capability bundle granting `Bash(git:*)` + `Edit` + `Write`,
//   (b) a `GH_TOKEN`-shaped env secret resolving credentials,
//   (c) a sub-agent prompt directing Claude Code to clone, edit, commit,
//       and push to a branch named conventionally `pangolin/dispatch-${ID}`.
//
// This test exercises the full pattern end-to-end. A bare git repository
// is created in `beforeEach` to stand in for the remote. The capability
// bundle ships a `.claude/settings.json` that flips the permissions
// listed in §6.6's "Adapter-level hardening" table. The subagent's
// system prompt directs Claude Code to operate against the stub remote.
// After dispatch completes, the test inspects the bare repo's `branch -a`
// output for an `pangolin/dispatch-*` ref and asserts that its tip carries
// the edit the sub-agent was instructed to make.
//
// SKIP semantics
// --------------
// The test is gated by `itIfDocker` so machines without a reachable
// Docker daemon (controller's dev box, CI without DinD) PASS-as-skipped.
// On top of that, the placeholder all-zero `WORKER_IMAGE` digest will
// fail to pull on any real daemon — so even with Docker present, the
// test effectively skips until `PANGOLIN_E2E_WORKER_IMAGE` points at a
// published worker image. Both gates are intentional: the contract this
// file pins is what the pipeline SHOULD do when wired with real
// infrastructure; the assertions exist so the wiring task lands against
// a pre-existing target rather than a from-scratch design.
//
// Worker → bare-repo reachability
// -------------------------------
// `LocalDockerProvider.run()` does NOT mount volumes from the host into
// the worker container (no `Binds` / `Mounts` / `HostConfig`), so the
// worker cannot reach a host-side bare repo via `file:///<host-path>`
// out of the box. Two acceptable strategies for downstream wiring:
//
//   1. Custom `dockerOpts` injecting a Dockerode that adds a bind mount
//      from `<bareRepo>` → `/pangolin-remote` and passes `file:///pangolin-remote`
//      to the sub-agent as the clone URL. (Pure file:// — no networking.)
//   2. Stand up a `git daemon --reuseaddr --base-path=<dir> --export-all`
//      on the host and pass `git://host.docker.internal:<port>/<name>`
//      to the sub-agent. Requires Docker Desktop's host-gateway alias
//      (on Linux: `--add-host host.docker.internal:host-gateway`).
//
// Both strategies live downstream of `LocalDockerProvider` as it stands
// today. This test passes the remote URL via the env bundle's `values:`
// (a non-secret config), and the sub-agent prompt is shape-neutral about
// the scheme — so wiring either strategy is a matter of substituting the
// `REMOTE_URL` value, not rewriting the test. The contract under
// observation (a branch lands on the bare repo) is the same either way.

import { describe, expect, beforeEach, afterEach } from 'vitest';
import { makeClient } from './helpers/make-client.js';
import { probeDocker, itIfDocker } from './helpers/docker-skip.js';
import { useTempStorageRoot } from './helpers/temp-storage.js';
import { WORKER_IMAGE } from './helpers/worker-image.js';
import { execSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

probeDocker();
const storageRoot = useTempStorageRoot('e2e-git-storage');

let bareRepo: string;

beforeEach(async () => {
  // A bare repo stands in for the remote `git push` target. `git init
  // --bare` produces a directory whose contents ARE a git repository
  // (no working tree) — exactly the shape `git push <url> <branch>`
  // expects to land branches against.
  bareRepo = await mkdtemp(join(tmpdir(), 'e2e-git-bare-'));
  execSync(`git init --bare "${bareRepo}"`, { stdio: 'pipe' });
});

afterEach(async () => {
  // `force: true` swallows the "directory already removed" error if the
  // test's own cleanup beat us. `recursive: true` walks the .git
  // internals (refs/, objects/, etc.) bare repos lay down.
  await rm(bareRepo, { recursive: true, force: true });
});

describe('E2E: §6.5 — file-editing dispatch produces git push to a stub remote', () => {
  itIfDocker(
    'subagent clones, edits, and pushes to a branch named pangolin/dispatch-<id> on the stub bare repo',
    async () => {
      const client = makeClient({
        namespace: 'git-push',
        storageRoot: storageRoot(),
      });

      // §6.6 adapter-level hardening: the stock `.claude/settings.json`
      // ALLOWS only read-only Bash patterns + Read/Glob/Grep/WebFetch.
      // §6.5 explicitly names the capability bundle as the lever for
      // adding Edit/Write/`Bash(git:*)`. The settings document below is
      // byte-identical to `examples/manifest/caps/git-write/.claude/settings.json`
      // — that file is the canonical reference for this pattern, and
      // co-locating the same JSON here keeps the e2e contract honest
      // when the example drifts.
      const settingsJson = JSON.stringify(
        {
          $schema: 'https://json.schemastore.org/claude-code-settings.json',
          permissions: {
            allow: ['Bash(git:*)', 'Edit', 'Write'],
            deny: [
              'Bash(git push --force:*)',
              'Bash(git push -f:*)',
              'Bash(rm -rf:*)',
            ],
          },
        },
        null,
        2,
      );

      // `pangolin-setup.sh` runs before the runtime adapter spawns Claude
      // Code (§6.4). We use it to (a) make the bare repo URL discoverable
      // to the sub-agent's bash invocations as `$REMOTE_URL` (it is also
      // in the merged process env via the env bundle's `values:`, but
      // some shells require a literal export to inherit it across
      // `git clone` sub-shells), and (b) seed an empty initial commit on
      // the bare repo so `git clone` has something to fetch.
      //
      // The git author identity is pinned via `git -c` rather than
      // `git config --global` so this script is idempotent across
      // re-runs and does not mutate the worker's `~/.gitconfig`.
      const setupSh = [
        '#!/bin/sh',
        'set -e',
        'echo "pangolin-setup: REMOTE_URL=$REMOTE_URL"',
        // Seed: clone, write a README, commit, push to main on the bare
        // repo. After this the bare repo has a real default branch the
        // sub-agent's clone-edit-push pattern can build on top of.
        'tmpseed=$(mktemp -d)',
        'git -c init.defaultBranch=main init "$tmpseed" >/dev/null',
        '(cd "$tmpseed" && \\',
        '  echo "# initial" > README.md && \\',
        '  git -c user.email=pangolin@example.com -c user.name=pangolin \\',
        '    add README.md && \\',
        '  git -c user.email=pangolin@example.com -c user.name=pangolin \\',
        '    commit -m "initial" >/dev/null && \\',
        '  git -c user.email=pangolin@example.com -c user.name=pangolin \\',
        '    push "$REMOTE_URL" main >/dev/null)',
        'rm -rf "$tmpseed"',
      ].join('\n');

      const cap = await client.capabilities.register({
        name: 'git-write',
        files: {
          '.claude/settings.json': settingsJson,
          'pangolin-setup.sh': setupSh,
        },
      });

      // The sub-agent's system prompt is the §6.5 contract restated for
      // Claude Code: clone the bundle's `$REMOTE_URL` into a temp dir,
      // edit `README.md` to append a sentinel line, commit under a
      // stable identity, push to a branch named `pangolin/dispatch-<id>`.
      //
      // The exact sentinel string ("EDIT FROM <id>") gives a downstream
      // assertion ("the branch CONTAINS THE EDIT the sub-agent produced")
      // a precise needle independent of branch name.
      const systemPrompt = [
        'You are a code-editing sub-agent. Execute these steps EXACTLY',
        'in a single bash session. Do not ask follow-up questions.',
        '',
        '1. tmp=$(mktemp -d); git clone "$REMOTE_URL" "$tmp"; cd "$tmp"',
        '2. git checkout -b "pangolin/dispatch-$PANGOLIN_DISPATCH_ID"',
        '3. echo "EDIT FROM $PANGOLIN_DISPATCH_ID" >> README.md',
        '4. git -c user.email=pangolin@example.com -c user.name=pangolin \\',
        '   add README.md',
        '5. git -c user.email=pangolin@example.com -c user.name=pangolin \\',
        '   commit -m "edit from dispatch $PANGOLIN_DISPATCH_ID"',
        '6. git push "$REMOTE_URL" "pangolin/dispatch-$PANGOLIN_DISPATCH_ID"',
        '7. exit 0',
      ].join('\n');

      await client.subagent.register({
        name: 'editor',
        systemPrompt,
        capabilities: [cap],
      });

      // The bare repo URL flows through the env bundle's `values:` (a
      // public config, NOT a secret) so the worker's resolved env has
      // `REMOTE_URL` set when `pangolin-setup.sh` runs and when the
      // sub-agent's bash invocations inherit env. Treating this as
      // `values:` (and not `secrets:`) is correct: a `file://` URL or a
      // `git://localhost:<port>/<name>` URL is not credential-shaped, and
      // §7.1's scanner does not flag it.
      const remoteUrl = pathToFileURL(bareRepo).href;
      await client.env.register({
        name: 'git-env',
        values: { REMOTE_URL: remoteUrl },
      });

      // Mint a known dispatchId up front so the assertion can match the
      // exact branch name without parsing the worker's stdout. The
      // sub-agent reads `$PANGOLIN_DISPATCH_ID` from its process env (set
      // by the worker per §6.1) and forms the branch as
      // `pangolin/dispatch-$PANGOLIN_DISPATCH_ID`.
      const dispatchId = `e2e-${Date.now()}`;
      const expectedBranch = `pangolin/dispatch-${dispatchId}`;

      const result = await client.dispatch({
        dispatchId,
        subagent: 'editor',
        env: 'git-env',
        target: 'local',
        timeoutSeconds: 300,
        workerImage: WORKER_IMAGE,
      } as any);

      // Acceptance: the dispatch completed without error AND a branch
      // named `pangolin/dispatch-<id>` is visible on the bare repo. We
      // check `branch -a` (covers both local and remote-tracking
      // namespaces — on a bare repo `branch -a` lists everything under
      // `refs/heads/`).
      expect(result.exitCode).toBe(0);
      const branches = execSync(
        `git --git-dir="${bareRepo}" branch -a`,
      ).toString();
      expect(branches).toContain(expectedBranch);

      // Acceptance: the branch's tip carries the edit the sub-agent
      // produced. We dereference `<branch>:README.md` via `git show` and
      // grep for the sentinel — this proves the push isn't a no-op
      // (empty commit, branch-without-edit, etc.).
      const blob = execSync(
        `git --git-dir="${bareRepo}" show "${expectedBranch}:README.md"`,
      ).toString();
      expect(blob).toContain(`EDIT FROM ${dispatchId}`);
    },
    300_000,
  );
});
