#!/usr/bin/env node
// Decision gate for the transport half of the dependency-cache design
// (spec §8: "sizing it is the first task of any plan, before the cache is
// assumed to help").
//
// Measures, inside the REAL worker image, how long a cold `pnpm install` of
// this repo's own lockfile takes, against the 120 s
// PANGOLIN_SETUP_TIMEOUT_SECONDS default.
//
// Framework-free and self-verifying, mirroring scripts/verify-patch-capture-env.mjs
// — vitest is not in the image. The governing rule from that script is carried
// over verbatim: **it must fail loudly rather than skip.** A measurement harness
// that can silently report nothing is the failure this gate exists to prevent,
// so every unavailability path below exits non-zero.
//
// COLD IS THE WHOLE POINT. The repo is mounted read-only and only the MANIFESTS
// (pnpm-workspace.yaml, pnpm-lock.yaml, .npmrc, every non-ignored package.json)
// are copied into the build dir. Copying the worktree wholesale would bring the
// existing ~800 MB node_modules with it, `pnpm install` would find the tree
// already satisfied, and the arm would report a fast number that measures
// nothing. The store is cold by construction: each `docker run --rm` starts
// with an empty ~/.local/share/pnpm/store.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const IMAGE = process.env.PANGOLIN_WORKER_IMAGE ?? 'ghcr.io/quarrysystems/pangolin-worker:main';
const SETUP_TIMEOUT_DEFAULT = 120;

const fail = (why) => {
  console.error(`FAIL: ${why}`);
  process.exit(1);
};

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

/** Positive control on the path arithmetic: a wrong REPO_ROOT would mount an
 *  empty dir and every arm would fail for a reason that looks like a real
 *  finding. Assert the anchor file instead of discovering it by failure. */
if (!existsSync(resolve(REPO_ROOT, 'pnpm-workspace.yaml'))) {
  fail(`REPO_ROOT resolved to ${REPO_ROOT}, which has no pnpm-workspace.yaml`);
}

function docker(args, { timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((res) => {
    const c = spawn('docker', args, { windowsHide: true });
    let out = '';
    const timer = setTimeout(() => {
      c.kill('SIGKILL');
      fail(`docker run exceeded ${timeoutMs} ms — a hung measurement is not a measurement`);
    }, timeoutMs);
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('error', () => {
      clearTimeout(timer);
      fail('docker is not available — this measurement must never skip');
    });
    c.on('close', (code) => {
      clearTimeout(timer);
      res({ code, out });
    });
  });
}

/** Shared prelude: install pnpm into a writable prefix. The worker runs as uid
 *  1000 and npm's global prefix is root-owned /usr/local, so a bare
 *  `npm i -g pnpm` fails EACCES (spec §2). */
const INSTALL_PNPM =
  'export NPM_CONFIG_PREFIX="$HOME/.npm-global"; mkdir -p "$NPM_CONFIG_PREFIX"; ' +
  'npm i -g pnpm --silent >/dev/null 2>&1 || exit 3; ' +
  'export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"; ';

function run(script, { mountRepo = false } = {}) {
  const args = ['run', '--rm'];
  if (mountRepo) {
    args.push('--mount', `type=bind,source=${REPO_ROOT},target=/w,readonly`);
  }
  args.push('--entrypoint', '/bin/bash', IMAGE, '-c', script);
  return docker(args);
}

function parseElapsed(out, arm) {
  const m = /elapsed_seconds:(\d+)/.exec(out);
  if (!m) fail(`${arm} arm produced no timing; output: ${out.slice(-400)}`);
  return Number(m[1]);
}

/** Arm 1 — toolchain only. Spec §2 hand-measured this at 2 s; the acceptance
 *  criterion treats >30 s as evidence the arm is measuring the wrong thing. */
async function armToolchain() {
  const { code, out } = await run(
    'export NPM_CONFIG_PREFIX="$HOME/.npm-global"; mkdir -p "$NPM_CONFIG_PREFIX"; ' +
      'S=$(date +%s); npm i -g pnpm --silent >/dev/null 2>&1 || exit 3; ' +
      'E=$(date +%s); export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"; ' +
      'pnpm --version >/dev/null 2>&1 || exit 5; ' +
      'echo "elapsed_seconds:$(( E - S ))"; echo "pnpm_usable:yes"',
  );
  if (code !== 0) fail(`toolchain arm: docker run exited ${code} — output: ${out.slice(-400)}`);
  if (!/pnpm_usable:yes/.test(out)) fail('toolchain arm: pnpm not runnable after install');
  return parseElapsed(out, 'toolchain');
}

/** Arm 2 — cold `pnpm install --frozen-lockfile` over the real lockfile.
 *  pnpm itself is installed in an UNTIMED region so the number measures the
 *  install and not the toolchain. */
async function armFull() {
  const { code, out } = await run(
    INSTALL_PNPM +
      // Manifests only — see the header. `tar -T -` preserves the directory
      // structure pnpm needs to resolve workspace members, and the -not -path
      // prunes keep any existing node_modules out of the copy.
      'mkdir -p /tmp/build && cd /w && ' +
      "find . -name package.json -not -path '*/node_modules/*' -not -path './.git/*' " +
      '  > /tmp/manifests.txt || exit 6; ' +
      'for f in pnpm-workspace.yaml pnpm-lock.yaml .npmrc; do ' +
      '  [ -f "$f" ] && echo "./$f" >> /tmp/manifests.txt; done; ' +
      'tar -c -T /tmp/manifests.txt | (cd /tmp/build && tar -x) || exit 7; ' +
      'cd /tmp/build; ' +
      // Positive control: prove the copy is manifest-only and genuinely cold
      // BEFORE timing anything, so a warm tree cannot masquerade as a fast install.
      'test -f pnpm-lock.yaml || exit 8; ' +
      'test -d node_modules && exit 9; ' +
      'echo "manifests_copied:$(wc -l < /tmp/manifests.txt)"; ' +
      // `--prod=false` is REQUIRED, not stylistic. The worker image bakes
      // NODE_ENV=production (measured: `docker image inspect` Config.Env), so a
      // bare `pnpm install --frozen-lockfile` silently SKIPS devDependencies —
      // it completes, exits 0, populates node_modules/.pnpm, and leaves out
      // vitest/eslint entirely. Measured: 802 packages without this flag.
      // Since the driver is "a dispatched verifier must run tsc and a test
      // suite" (spec §1), a prod-only tree is not the thing worth timing: it
      // cannot run the gates the whole design exists to enable.
      'S=$(date +%s); pnpm install --frozen-lockfile --prod=false >/tmp/install.log 2>&1 || ' +
      '  { echo "INSTALL_FAILED"; tail -25 /tmp/install.log; exit 4; }; ' +
      'E=$(date +%s); echo "elapsed_seconds:$(( E - S ))"; ' +
      'test -d node_modules/.pnpm && echo "store_populated:yes"; ' +
      // A fast number from a PARTIAL install would be wrong in the direction
      // that matters, and `store_populated` only proves the directory exists.
      // Count what actually landed and compare it against the lockfile's own
      // resolved-package count, so "13 s" is defensible as a complete install.
      'echo "installed_packages:$(ls node_modules/.pnpm | grep -cv \'^lock.yaml$\')"; ' +
      'echo "lockfile_resolutions:$(grep -c \'resolution: {\' pnpm-lock.yaml)"; ' +
      // Named heavyweights as the positive control: a truncated install would
      // still leave *some* directories behind, so assert that specific
      // top-level toolchain deps actually landed.
      'for p in typescript vitest esbuild; do ' +
      '  ls -d node_modules/.pnpm/${p}@* >/dev/null 2>&1 && echo "present:$p"; done',
    { mountRepo: true },
  );
  if (code !== 0) {
    fail(`full arm: docker run exited ${code} — a failed install is NOT a measurement. ${out.slice(-600)}`);
  }
  if (!/store_populated:yes/.test(out)) {
    fail('full arm: node_modules/.pnpm absent — install produced nothing');
  }
  const secs = parseElapsed(out, 'full');
  const mm = /manifests_copied:(\d+)/.exec(out);
  if (mm) console.log(`manifests_copied:${mm[1]}`);

  // Completeness gate. A cold install that resolved only a fraction of the
  // lockfile would otherwise report a fast, meaningless number.
  const installed = Number((/installed_packages:(\d+)/.exec(out) ?? [])[1] ?? 0);
  const resolutions = Number((/lockfile_resolutions:(\d+)/.exec(out) ?? [])[1] ?? 0);
  if (!installed || !resolutions) fail(`full arm: could not count packages; output: ${out.slice(-400)}`);
  console.log(`installed_packages:${installed}`);
  console.log(`lockfile_resolutions:${resolutions}`);

  // NOT a ratio against `lockfile_resolutions`. Measured: 802 installed against
  // 1052 resolutions (76%) for a COMPLETE install — the lockfile carries
  // platform-specific optional binaries (rollup/esbuild/swc variants for
  // darwin/win32/musl) that a linux-x64 install correctly skips. A ratio gate
  // fails a healthy install, so the completeness signal is named packages
  // instead, and the "was it a no-op?" question is answered earlier and more
  // directly by the pre-timing `test -d node_modules && exit 9`.
  const REQUIRED = ['typescript', 'vitest', 'esbuild'];
  const missing = REQUIRED.filter((p) => !new RegExp(`present:${p}\\b`).test(out));
  if (missing.length) {
    fail(`full arm: expected packages absent after install (${missing.join(', ')}) — partial install, not a measurement`);
  }
  if (installed < 100) {
    fail(`full arm: only ${installed} package dirs present — implausibly small for this workspace`);
  }
  if (secs > SETUP_TIMEOUT_DEFAULT) {
    console.log(`EXCEEDS_SETUP_TIMEOUT ${secs} > ${SETUP_TIMEOUT_DEFAULT}`);
  }
  return secs;
}

const arm = (process.argv.find((a) => a.startsWith('--arm=')) ?? '').split('=')[1];
if (arm !== 'toolchain' && arm !== 'full') {
  fail('usage: measure.mjs --arm=toolchain|full');
}

const digest = await docker(['image', 'inspect', IMAGE, '--format', '{{.Id}}']);
if (digest.code !== 0) fail(`image ${IMAGE} is not available locally — ${digest.out.slice(-200)}`);
console.log(`image:${IMAGE}`);
console.log(`image_id:${digest.out.trim()}`);

const secs = arm === 'toolchain' ? await armToolchain() : await armFull();
console.log(`elapsed_seconds:${secs}`);
process.exit(0);
