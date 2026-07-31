// Does C1-as-described actually close the finding?
//
// C1: "a thin launcher becomes the container entrypoint, reads the ambient
// credentials, execs the real worker with a minimal environment, and passes the
// credentials over an inherited fd."
//
// Half 1 proved the CHILD's env block is clean. It also printed "parent leaks:
// [...]" without drawing the conclusion. An inherited fd implies a live parent.
// If that parent keeps the credentials in its own env block, the agent — same
// uid, same PID namespace — reads them from the PARENT instead, and C1 closes
// nothing.
//
// Roles: this process = the LAUNCHER (holds creds). Child = the WORKER (clean
// envp). Grandchild = the AGENT (clean envp, hunts for creds anywhere in /proc).
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

const SECRET = 'TOPSECRET-TASK-ROLE';

if (process.argv[2] === 'agent') {
  // The prompt-injected agent: walk every readable /proc/<pid>/environ.
  const hits = [];
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const buf = readFileSync(`/proc/${pid}/environ`, 'utf8');
      if (buf.includes(SECRET)) {
        let cmd = '?';
        try {
          cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
        } catch {}
        hits.push(`pid ${pid} (${cmd.slice(0, 60)})`);
      }
    } catch {}
  }
  console.log(`  AGENT own env has secret? ${JSON.stringify(process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ?? null)}`);
  console.log(`  AGENT found secret in ${hits.length} process(es):`);
  for (const h of hits) console.log(`    - ${h}`);
  console.log(
    hits.length === 0
      ? '  => CLOSED: no process in the namespace leaks the credential'
      : '  => STILL OPEN: the credential is readable from the listed process(es)',
  );
  process.exit(0);
}

if (process.argv[2] === 'worker') {
  // The worker: clean envp (C1 half 1). It spawns the agent, as today.
  console.log(`  WORKER own env has secret? ${JSON.stringify(process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ?? null)}`);
  const agent = spawn(process.execPath, [process.argv[1], 'agent'], {
    env: { PATH: process.env.PATH },
    stdio: 'inherit',
  });
  await new Promise((r) => agent.on('close', r));
  process.exit(0);
}

// The launcher. Credentials are ambient here, exactly as the container gets them.
console.log('LAUNCHER: credentials are in my environment (as the container delivers them)');
console.log(`  launcher pid ${process.pid}, own env has secret? ${JSON.stringify(process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI)}`);
console.log('\nC1 as described — launcher STAYS ALIVE to own the inherited fd:\n');
const worker = spawn(process.execPath, [process.argv[1], 'worker'], {
  env: { PATH: process.env.PATH },
  stdio: 'inherit',
});
await new Promise((r) => worker.on('close', r));
