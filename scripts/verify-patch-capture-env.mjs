#!/usr/bin/env node
// verify-patch-capture-env.mjs — proves the patch-capture env-scoping fix (buildGitEnv) holds
// inside the SHIPPED worker image, not just in vitest against source.
//
// Discharges spec §4.4 (HOME=/nonexistent is harmless, exercised in a container) and §7 (record
// one run of the escape repro against the built worker image). §7 is impossible in the form the
// spec implies: `packages/pangolin-worker/package.json` ships only "dist"/"README.md"/"LICENSE",
// the image is built with `pnpm deploy --prod`, so test/ is not in the image and vitest is not
// installed. This script imports the COMPILED module and re-implements the escape-test's two
// arms as a plain node script with no test framework.
//
// The script carries its own positive control (Arm A): a container check that only asserts
// absence fails exactly the way a naive escape test would — if the fsmonitor vector does not
// fire under that image's git version, every assertion passes having proven nothing. Arm A must
// leak or the run is invalid; Arm B must not leak and must still capture correctly.
//
// Usage:
//   node verify-patch-capture-env.mjs [path/to/patch-capture.js]
// Default module path is /opt/pangolin/worker/dist/patch-capture.js (the in-container location).
// AWS_SESSION_TOKEN and PANGOLIN_CALLBACK_TOKEN_REF must be set in the environment.
//
// Exit 0 on success; exit 1 with a diagnostic on any failure.

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_MODULE_PATH = '/opt/pangolin/worker/dist/patch-capture.js';

function fail(reason) {
  console.error(`FAIL: ${reason}`);
  process.exit(1);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) fail(`required env var ${name} is not set`);
  return value;
}

/** Writes the hook + the repo-local config that invokes it. `leakDir` is deliberately outside
 *  `dir` so the hook's own output is not staged into the captured patch. */
async function plantHook(dir, leakDir) {
  const leak = join(leakDir, 'leak.txt');
  const hook = join(dir, '.git', 'evil.sh');
  await writeFile(hook, `#!/bin/sh\nenv > '${leak.split(sep).join('/')}'\nexit 1\n`);
  await chmod(hook, 0o755);
  // Backslashes are escapes in .git/config — forward-slash the path; quote it since git runs
  // core.fsmonitor through a shell.
  const cfgPath = hook.split(sep).join('/');
  await writeFile(join(dir, '.git', 'config'), `[core]\n\tfsmonitor = '${cfgPath}'\n`, {
    flag: 'a',
  });
  return leak;
}

function rawGit(dir, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', ['-C', dir, '-c', 'safe.directory=*', ...args]);
    child.on('error', reject);
    child.on('exit', () => resolvePromise()); // the hook exits 1 by design; ignore the status
  });
}

async function runArmA(awsValue) {
  const dir = await mkdtemp(join(tmpdir(), 'verify-ctl-'));
  const leakDir = await mkdtemp(join(tmpdir(), 'verify-ctl-leak-'));
  await writeFile(join(dir, 'file.txt'), 'hello\n');

  // No env option — the pre-fix behaviour — so this arm proves the vector is live and Arm B's
  // assertions actually discriminate something.
  await rawGit(dir, ['init', '-q']);
  const leak = await plantHook(dir, leakDir);
  await rawGit(dir, ['add', '-A']);

  const captured = await readFile(leak, 'utf8');
  if (!captured.includes(awsValue)) {
    fail(
      'positive control did not leak — the fsmonitor vector is not live in this image; arm B proves nothing',
    );
  }
  console.log('Arm A (positive control): leaked as expected — the fsmonitor vector is live.');
}

async function runArmB(modulePath, awsValue, refValue) {
  const moduleUrl = pathToFileURL(resolve(modulePath)).href;
  const { captureBaseline, computeWorkspacePatch } = await import(moduleUrl);

  const dir = await mkdtemp(join(tmpdir(), 'verify-'));
  const leakDir = await mkdtemp(join(tmpdir(), 'verify-leak-'));

  await writeFile(join(dir, 'file.txt'), 'hello\n');
  const base = await captureBaseline(dir); // creates .git/ before the "agent" acts
  if (!('treeOid' in base) || typeof base.treeOid !== 'string') {
    fail(`captureBaseline did not return a treeOid: ${JSON.stringify(base)}`);
  }

  const leak = await plantHook(dir, leakDir); // the agent's move
  await writeFile(join(dir, 'file.txt'), 'hello\nagent change\n');

  const patchBytes = await computeWorkspacePatch(dir, base);

  // No .catch — an absent file means the hook never ran and the run must fail loudly.
  const captured = await readFile(leak, 'utf8');

  if (!/^PATH=/m.test(captured)) {
    fail('arm B leak file is missing PATH= — the hook did not actually run under a real env');
  }
  if (!/^HOME=\/nonexistent$/m.test(captured)) {
    fail('arm B leak file is missing HOME=/nonexistent — env scoping is not applied');
  }

  if (captured.includes(awsValue)) {
    fail('arm B leak file contains the planted AWS_SESSION_TOKEN value — credential leaked');
  }
  if (captured.includes(refValue)) {
    fail(
      'arm B leak file contains the planted PANGOLIN_CALLBACK_TOKEN_REF value — credential leaked',
    );
  }
  if (/^AWS_/m.test(captured)) {
    fail('arm B leak file contains an AWS_ line — credential leaked');
  }
  if (/^PANGOLIN_/m.test(captured)) {
    fail('arm B leak file contains a PANGOLIN_ line — credential leaked');
  }

  if (patchBytes === null) {
    fail('computeWorkspacePatch returned null — capture did not work under the scoped env');
  }
  const patch = new TextDecoder().decode(patchBytes);
  if (!patch.includes('agent change')) {
    fail('computeWorkspacePatch output does not contain the mutated line — capture is broken');
  }

  console.log(
    'Arm B (real path): env scoped correctly (PATH/HOME present, no credentials), and the diff still captured the mutation.',
  );
}

async function main() {
  const modulePath = process.argv[2] ?? DEFAULT_MODULE_PATH;
  const awsValue = requiredEnv('AWS_SESSION_TOKEN');
  const refValue = requiredEnv('PANGOLIN_CALLBACK_TOKEN_REF');

  await runArmA(awsValue);
  await runArmB(modulePath, awsValue, refValue);

  console.log('OK');
  process.exit(0);
}

main().catch((err) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
