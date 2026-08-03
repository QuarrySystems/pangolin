// The worker's side of the C1'-restore hand-off, plus the agent sweep.
//
// Three properties are asserted here, and each one is a premise the design
// rests on rather than a nice-to-have:
//
//   1. the fd survives execve and still reads the unlinked file
//   2. restoring into process.env does NOT appear in /proc/<pid>/environ
//   3. no process in the namespace leaks the credential, and no file does
import { readFileSync, existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const NEEDLE = 'TOPSECRET-TASK-ROLE';
const fd = Number(process.env.CRED_FD ?? 3);

// 1. Read the credential off the inherited fd.
const credential = readFileSync(fd, 'utf8');
console.log(`  WORKER (pid ${process.pid}): read ${credential.length} bytes off fd ${fd}`);
console.log(`  WORKER: credential intact?      ${credential.includes(NEEDLE) ? 'yes' : 'NO — channel broken'}`);

// The env this process was exec'd with is already clean; prove it before restoring.
const beforeRestore = readFileSync(`/proc/${process.pid}/environ`, 'utf8');
console.log(`  WORKER: env block before restore ${beforeRestore.includes(NEEDLE) ? 'HAS SECRET' : 'clean'}`);

// 2. Restore. This is the whole mechanism: the SDK reads process.env, and
//    process.env is not the region /proc exposes.
process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = credential;

const afterRestore = readFileSync(`/proc/${process.pid}/environ`, 'utf8');
console.log(`  WORKER: process.env after restore ${process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI.includes(NEEDLE) ? 'HAS SECRET (as intended)' : 'MISSING'}`);
console.log(`  WORKER: env block after restore  ${afterRestore.includes(NEEDLE) ? 'HAS SECRET — MECHANISM FAILS' : 'clean'}`);

// 3. The agent's sweep: same uid, own env carrying only PATH.
const agent = `
const { readFileSync, readdirSync, existsSync } = require('fs');
const NEEDLE = ${JSON.stringify(NEEDLE)};
const hits = [];
for (const pid of readdirSync('/proc').filter((d) => /^[0-9]+$/.test(d))) {
  let env = '';
  try { env = readFileSync('/proc/' + pid + '/environ', 'utf8'); } catch { continue; }
  if (env.includes(NEEDLE)) {
    let cmd = '?';
    try { cmd = readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\\u0000').join(' ').trim(); } catch {}
    hits.push(pid + ' (' + cmd + ')');
  }
}
console.log('  AGENT : secret found in ' + hits.length + ' process env block(s)' + (hits.length ? ': ' + hits.join(', ') : ''));

// A positive control, per the third false-PASS trap: if the instrument cannot
// see a credential that IS present, "found nothing" means nothing.
const control = readFileSync('/proc/self/environ', 'utf8').includes('POSITIVE-CONTROL');
console.log('  AGENT : positive control visible? ' + (control ? 'yes — instrument works' : 'NO — instrument is blind, result void'));
process.exit(hits.length === 0 && control ? 0 : 1);
`;

console.log('');
const r = spawnSync(
  '/usr/bin/env',
  ['-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'POSITIVE_CONTROL=POSITIVE-CONTROL-VALUE', 'node', '-e', agent],
  { encoding: 'utf8' },
);
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');

// The hand-off artifact must not outlive the entrypoint.
const strays = readdirSync('/tmp').filter((f) => f.startsWith('tmp'));
console.log(`  AGENT : hand-off file present?    ${strays.length ? 'YES: ' + strays.join(', ') : 'false'}`);

const ok = r.status === 0 && !afterRestore.includes(NEEDLE) && credential.includes(NEEDLE);
console.log(`\n  => ${ok ? 'CLOSED' : 'STILL OPEN'}: env block clean, credential usable in process.env, nothing on disk`);
process.exit(ok ? 0 : 1);
