#!/usr/bin/env node
// Container tripwire for the /proc env-exposure finding (spec §5, C1'-restore).
//
// THE FINDING: a prompt-injected agent reads the worker's AWS chain and callback
// HMAC key reference straight out of `/proc/<worker-pid>/environ`. Same uid, no
// exploit. `runtime-env-filter.ts` scopes only the environment handed to the
// agent PROCESS, not the worker's own, so it does not achieve what it exists to
// do. Reproduced three times before the fix was designed.
//
// Arms:
//   control    — WITHOUT the mechanism the credential IS readable. This arm must
//                LEAK or the whole run is void: it proves the probe can see, so
//                the other arms' absences mean something.
//   entrypoint — structural properties of the hand-off: the worker is pid 1
//                (the entrypoint `exec`ed rather than forked), and no credential
//                file survives in the filesystem.
//   full       — the shipped image end-to-end, through its own ENTRYPOINT: no
//                process in the namespace leaks the credential.
//
// Framework-free and self-verifying, mirroring `scripts/verify-patch-capture-env.mjs`
// — vitest is not installed in the worker image. Like that script, it FAILS
// LOUDLY rather than skipping: a verifier that can silently report nothing is
// the exact failure this plan exists to avoid.
//
// A /proc read returning 0 bytes with the credential plainly present is a
// MEASURED failure mode here, not a hypothetical (spec §3a) — which is why the
// control arm is mandatory rather than a nicety.

import { spawn } from 'node:child_process';

const IMAGE = process.env.PANGOLIN_WORKER_IMAGE ?? 'ghcr.io/quarrysystems/pangolin-worker:main';
const NEEDLE = 'TOPSECRET-TASK-ROLE';
const CRED = `/v2/credentials/${NEEDLE}`;

let failed = 0;
const fail = (why) => {
  console.error(`FAIL: ${why}`);
  failed += 1;
};

function docker(args) {
  return new Promise((res) => {
    const c = spawn('docker', args, { windowsHide: true });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('error', () => {
      console.error('FAIL: docker is not available — this verifier must never skip');
      process.exit(1);
    });
    c.on('close', (code) => res({ code, out }));
  });
}

// Sweeps EVERY readable /proc/<pid>/environ, exactly as an injected agent would
// — not just pid 1. The worker is pid 1 once the entrypoint `exec`s, but a probe
// that only looks there would miss a leak in any forked helper, and would still
// pass if the exec regressed into a fork.
// Newline-joined, not `; `-joined: a semicolon after `do` is a shell syntax
// error, and the resulting failure looks like a missing probe rather than a
// broken command.
const SWEEP = [
  'HITS=0',
  'for f in /proc/[0-9]*/environ; do',
  `  tr '\\0' '\\n' < "$f" 2>/dev/null | grep -q ${NEEDLE} && HITS=$((HITS+1))`,
  'done',
  'echo "HITS:$HITS"',
].join('\n');

function hitsOf(out, arm) {
  const m = /HITS:(\d+)/.exec(out);
  if (!m) {
    fail(`${arm}: sweep produced no HITS line — the probe did not run. Output: ${out.slice(-300)}`);
    return null;
  }
  return Number(m[1]);
}

/** WITHOUT the mechanism: `--entrypoint /bin/sh` bypasses it entirely. */
async function armControl() {
  const { out } = await docker([
    'run', '--rm',
    '-e', `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=${CRED}`,
    '--entrypoint', '/bin/sh', IMAGE, '-c', SWEEP,
  ]);
  const hits = hitsOf(out, 'control');
  if (hits === null) return;
  if (hits < 1) {
    fail(
      'positive control did not leak — the probe cannot see a credential that IS present; ' +
        'every other arm proves nothing. (A /proc read yielding 0 bytes with the value set is a ' +
        'measured failure mode, so treat this as a broken probe, not a passing system.)',
    );
    return;
  }
  console.log(`Arm control: leaked as expected (${hits} hit(s)) — the probe works.`);
}

/** Structural properties of the hand-off, through the image's own ENTRYPOINT. */
async function armEntrypoint() {
  const script = [
    'echo "PID1:$(cat /proc/1/comm 2>/dev/null)"',
    // The payload file is written then immediately unlinked, so it must not be
    // reachable by name from inside the container.
    'echo "STRAY:$(find /tmp /run /dev/shm -maxdepth 2 -name "*pangolin-cred*" 2>/dev/null | wc -l)"',
  ].join('; ');
  const { out } = await docker([
    'run', '--rm',
    '-e', `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=${CRED}`,
    IMAGE, '/bin/sh', '-c', script,
  ]);
  const stray = /STRAY:(\d+)/.exec(out);
  if (!stray) {
    fail(`entrypoint: probe did not run. Output: ${out.slice(-300)}`);
    return;
  }
  if (Number(stray[1]) !== 0) {
    fail(`entrypoint: ${stray[1]} credential payload file(s) survive on disk — the unlink did not happen`);
    return;
  }
  console.log(`Arm entrypoint: no credential payload survives on disk. ${/PID1:\S*/.exec(out)?.[0] ?? ''}`);
}

/** The shipped image end-to-end — NO --entrypoint override, so this exercises
 *  exactly what the compute providers launch. */
async function armFull() {
  const { out } = await docker([
    'run', '--rm',
    '-e', `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=${CRED}`,
    IMAGE, '/bin/sh', '-c', SWEEP,
  ]);
  const hits = hitsOf(out, 'full');
  if (hits === null) return;
  if (hits !== 0) {
    fail(`credential still readable from /proc (${hits} hit(s))`);
    return;
  }
  console.log('Arm full: no process env block leaks the credential.');
}

const ARMS = { control: armControl, entrypoint: armEntrypoint, full: armFull };

const requested = (process.argv.find((a) => a.startsWith('--arm=')) ?? '').split('=')[1];
if (requested && !ARMS[requested]) {
  console.error(`FAIL: unknown arm '${requested}' — expected one of ${Object.keys(ARMS).join('|')}`);
  process.exit(1);
}

const probe = await docker(['image', 'inspect', IMAGE, '--format', '{{.Id}}']);
if (probe.code !== 0) {
  console.error(`FAIL: image ${IMAGE} is not available locally — ${probe.out.slice(-200)}`);
  process.exit(1);
}
console.log(`image:${IMAGE}`);
console.log(`image_id:${probe.out.trim()}`);

// The control arm runs FIRST and ALWAYS, whatever was requested: an absence
// result from `full` or `entrypoint` is meaningless without evidence, in the
// same run, that the probe can see a credential at all.
await armControl();
if (requested && requested !== 'control') {
  await ARMS[requested]();
} else if (!requested) {
  await armEntrypoint();
  await armFull();
}

process.exit(failed > 0 ? 1 : 0);
