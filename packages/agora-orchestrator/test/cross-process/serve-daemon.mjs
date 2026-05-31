// A real, standalone serve daemon — run as a separate OS process by the
// cross-process pressure test. It owns its own SQLite DB (D3 sole owner) and
// shares NOTHING with the client except the mailbox directory on disk.
// Imports the BUILT package (dist) because a child node process can't use
// vitest's on-the-fly transpilation.
import {
  AgoraOrchestrator,
  SqliteRunStateStore,
  ManualTrigger,
  MailboxSubmissionTransport,
  LocalDirMailbox,
  serve,
} from '../../dist/index.js';

const mailboxDir = process.argv[2];
const dbPath = process.argv[3];

// Deterministic "echo" executor. AGORA_XPROC_DURATION_MS>0 makes work take time so
// an item is genuinely in-flight (for the hard-kill / recovery scenario); 0 = instant.
const durationMs = Number(process.env.AGORA_XPROC_DURATION_MS ?? '0');
const inflight = new Map();
let counter = 0;
const echo = {
  id: 'echo',
  async fire() {
    const h = `h${++counter}`;
    inflight.set(h, Date.now() + durationMs);
    return { dispatchHash: h };
  },
  async reconcile(h) {
    const due = inflight.get(h);
    if (due === undefined) return null; // unknown dispatch (e.g. after a crash) — appears running
    if (Date.now() < due) return null; // still working
    inflight.delete(h);
    return { status: 'done' };
  },
};

const store = new SqliteRunStateStore(dbPath);
const orchestrator = new AgoraOrchestrator({
  store,
  executors: { echo },
  triggers: { manual: new ManualTrigger() },
  queues: { default: { concurrency: 4 } },
});
const transport = new MailboxSubmissionTransport(new LocalDirMailbox(mailboxDir));

const ac = new AbortController();
const stop = () => ac.abort();
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

process.stderr.write('daemon: up\n');
serve({
  orchestrator,
  transport,
  tickIntervalMs: 50,
  signal: ac.signal,
  onError: (err) => process.stderr.write(`daemon: loop error ${String(err && err.stack ? err.stack : err)}\n`),
})
  .then(() => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  })
  .catch((err) => {
    process.stderr.write(`daemon: error ${String(err)}\n`);
    process.exit(1);
  });
