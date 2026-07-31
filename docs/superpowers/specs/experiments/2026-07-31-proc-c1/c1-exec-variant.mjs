// Worker + agent halves of the C1' shell-exec variant.
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs';

const SECRET = 'TOPSECRET-TASK-ROLE';

if (process.argv[2] === 'agent') {
  const hits = [];
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      if (readFileSync(`/proc/${pid}/environ`, 'utf8').includes(SECRET)) {
        let cmd = '?';
        try {
          cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
        } catch {}
        hits.push(`pid ${pid} (${cmd.slice(0, 60)})`);
      }
    } catch {}
  }
  // The other lane: is the hand-off file still lying around?
  const fileLeak = existsSync('/tmp/pangolin-creds/creds');
  console.log(`  AGENT: secret found in ${hits.length} process env block(s)`);
  for (const h of hits) console.log(`    - ${h}`);
  console.log(`  AGENT: hand-off file still present? ${fileLeak}`);
  console.log(
    hits.length === 0 && !fileLeak
      ? '  => CLOSED: no process env block and no file leaks the credential'
      : '  => STILL OPEN',
  );
  process.exit(0);
}

// Worker: read the credential into the heap, then unlink it immediately —
// before the agent exists.
const creds = readFileSync(process.env.CREDS_FILE, 'utf8');
unlinkSync(process.env.CREDS_FILE);
console.log(`  WORKER (pid ${process.pid}): got credential over the file channel (len ${creds.length}), unlinked it`);
console.log(`  WORKER: own env block has secret? ${JSON.stringify(process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ?? null)}`);
console.log(`  WORKER: credential is now heap-only, usable for the S3 client`);
console.log('');

const agent = spawn(process.execPath, ['/w/c1-exec-variant.mjs', 'agent'], {
  env: { PATH: process.env.PATH },
  stdio: 'inherit',
});
await new Promise((r) => agent.on('close', r));
