// REAL-SCENARIO pressure tests: the actual deployment topology the mailbox enables.
// `serve` runs as a genuinely separate OS process (its own SQLite DB); clients in
// THIS process submit/read through the shared filesystem mailbox only — no shared
// memory, no direct connection (D3/D5).
import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MailboxSubmissionTransport, LocalDirMailbox } from '../../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(here, 'serve-daemon.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface StatusItem { id: string; status: string }
type Client = MailboxSubmissionTransport;
const client = (dir: string): Client => new MailboxSubmissionTransport(new LocalDirMailbox(dir));
const runOf = (id: string, items: { id: string; deps?: string[] }[]) => ({
  id, queue: 'default',
  items: items.map((i) => ({ id: i.id, executor: 'echo', inputs: {}, depends_on: i.deps ?? [], resourceLocks: [] })),
});
const submit = (c: Client, run: ReturnType<typeof runOf>) =>
  c.submit({ run, actor: 'human:client', submittedAt: new Date(0).toISOString() });
async function latest(c: Client, runId: string): Promise<StatusItem[] | undefined> {
  const recs = await c.readOutbox(runId);
  return recs[recs.length - 1]?.body as StatusItem[] | undefined;
}
async function pollUntil(fn: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(60); }
  return false;
}
function startDaemon(mailboxDir: string, dbPath: string, durationMs = 0): { proc: ChildProcess; err: () => string } {
  let err = '';
  const proc = spawn(process.execPath, [DAEMON, mailboxDir, dbPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AGORA_XPROC_DURATION_MS: String(durationMs) },
  });
  proc.stderr?.on('data', (d) => (err += d.toString()));
  return { proc, err: () => err };
}
async function freshDirs(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  return { mailboxDir: join(root, 'mbox'), dbPath: join(root, 'state.db') };
}

describe('cross-process mailbox handoff (real deployment topology)', () => {
  it('a separate serve process runs a DAG submitted by a client through the shared mailbox', async () => {
    const { mailboxDir, dbPath } = await freshDirs('agora-xproc-');
    const d = startDaemon(mailboxDir, dbPath);
    await sleep(400);
    try {
      const c = client(mailboxDir); // separate transport; never touches the daemon's DB
      await submit(c, runOf('xrun', [{ id: 'a' }, { id: 'b' }, { id: 'v', deps: ['a', 'b'] }]));
      const ok = await pollUntil(async () => {
        const b = await latest(c, 'xrun');
        return !!b && b.length === 3 && b.every((i) => i.status === 'done');
      }, 9000);
      expect(ok, `run did not complete cross-process.\n--- daemon stderr ---\n${d.err()}`).toBe(true);
      const b = (await latest(c, 'xrun'))!;
      expect(b.map((i) => i.id).sort()).toEqual(['a', 'b', 'v']);
    } finally {
      d.proc.kill('SIGTERM'); await sleep(150);
    }
  }, 20000);

  // SCENARIO 1 — hard crash mid-run + resume on a fresh process (recoverStranded across a REAL process boundary)
  it('survives a SIGKILL of the daemon mid-run and a fresh daemon resumes the run from the durable DB', async () => {
    const { mailboxDir, dbPath } = await freshDirs('agora-xproc-crash-');
    const d1 = startDaemon(mailboxDir, dbPath, 4000); // SLOW executor → item genuinely in-flight
    await sleep(400);
    let d2: { proc: ChildProcess; err: () => string } | undefined;
    try {
      const c = client(mailboxDir);
      await submit(c, runOf('crashrun', [{ id: 'slow' }]));

      // wait until 'slow' is actually running, then HARD-kill the daemon (no graceful shutdown)
      const running = await pollUntil(async () => (await latest(c, 'crashrun'))?.[0]?.status === 'running', 8000);
      expect(running, `item never reached running before crash.\n${d1.err()}`).toBe(true);
      d1.proc.kill('SIGKILL');
      await sleep(300); // let the OS release the DB handle

      // fresh daemon, SAME db + mailbox, instant executor: recoverStranded must re-dispatch the stranded item
      d2 = startDaemon(mailboxDir, dbPath, 0);
      const done = await pollUntil(async () => {
        const b = await latest(c, 'crashrun');
        return !!b && b.length === 1 && b.every((i) => i.status === 'done');
      }, 10000);
      expect(done, `run did not resume after restart.\n--- d2 stderr ---\n${d2.err()}`).toBe(true);
    } finally {
      try { d1.proc.kill('SIGKILL'); } catch { /* already dead */ }
      d2?.proc.kill('SIGTERM'); await sleep(150);
    }
  }, 25000);

  // SCENARIO 2 — many concurrent client submissions to one daemon (filesystem contention on the mailbox)
  it('handles many concurrent client submissions to one daemon with no loss or duplication', async () => {
    const { mailboxDir, dbPath } = await freshDirs('agora-xproc-load-');
    const d = startDaemon(mailboxDir, dbPath, 0);
    await sleep(400);
    try {
      const N = 20;
      const ids = Array.from({ length: N }, (_, i) => `load-${i}`);
      // N SEPARATE client transports submit concurrently → concurrent writes to the mailbox dir.
      // Every run uses the SAME item id 't' on purpose: a regression guard for run-scoped ids
      // (item ids are unique per run, not globally — this would UNIQUE-collide before the fix).
      const clients = ids.map(() => client(mailboxDir));
      await Promise.all(ids.map((id, i) => submit(clients[i]!, runOf(id, [{ id: 't' }]))));

      const reader = client(mailboxDir);
      const completed = new Set<string>();
      await pollUntil(async () => {
        for (const id of ids) {
          if (completed.has(id)) continue;
          const b = await latest(reader, id);
          if (b && b.length === 1 && b.every((i) => i.status === 'done')) completed.add(id);
        }
        return completed.size === N;
      }, 18000);
      expect(completed.size, `only ${completed.size}/${N} runs completed.\n${d.err()}`).toBe(N);
    } finally {
      d.proc.kill('SIGTERM'); await sleep(150);
    }
  }, 30000);
});
