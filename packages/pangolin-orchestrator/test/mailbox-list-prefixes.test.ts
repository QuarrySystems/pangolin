// KNOWN-ISSUES #6 change 3: enumerating runs must cost one entry per RUN, not one per
// RECORD.
//
// `MailboxStore.list(prefix)` returns every key beneath a prefix, so asking "which runs
// exist?" meant listing every outbox record ever written. Measured on the serve stack
// 2026-07-31: the delimited form answered in 2 s where the recursive form took ~8 min
// over 1,701,236 objects for 95 runs. There was no client-side way to ask at all — the
// only route was shelling into the serve container and querying its SQLite, which is
// what KNOWN-ISSUES #7's operator note had to document.
//
// S3 answers this natively via Delimiter + CommonPrefixes; the contract simply had no
// way to express it. `listPrefixes` is OPTIONAL on both seams so third-party mailboxes
// keep working, with callers falling back to deriving prefixes from `list()`.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDirMailbox } from '../src/mailbox/local-dir.js';
import { S3Mailbox } from '../src/mailbox/s3.js';
import { MailboxSubmissionTransport } from '../src/transport/storage-transport.js';
import type { MailboxS3Client, MailboxStore } from '../src/contracts/index.js';

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

/** In-memory MailboxS3Client with a real delimiter implementation, plus counters so a
 *  test can prove the delimited path did not fall back to a full scan. */
function fakeS3Seam(): MailboxS3Client & { listCalls: number; prefixCalls: number } {
  const objects = new Map<string, Uint8Array>();
  const seam = {
    listCalls: 0,
    prefixCalls: 0,
    async put(key: string, bytes: Uint8Array) {
      objects.set(key, bytes);
    },
    async get(key: string) {
      return objects.get(key) ?? null;
    },
    async delete(key: string) {
      objects.delete(key);
    },
    async list(prefix: string) {
      seam.listCalls++;
      return [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
    async listPrefixes(prefix: string) {
      seam.prefixCalls++;
      const out = new Set<string>();
      for (const k of objects.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        const cut = rest.indexOf('/');
        if (cut >= 0) out.add(prefix + rest.slice(0, cut + 1));
      }
      return [...out].sort();
    },
  };
  return seam;
}

async function seedRuns(mbox: MailboxStore, runs: string[], perRun: number): Promise<void> {
  const t = new MailboxSubmissionTransport(mbox);
  for (const run of runs) {
    for (let i = 0; i < perRun; i++) {
      await t.publish({ runId: run, kind: 'status', body: [{ n: i }], at: `t${i}` });
    }
  }
}

describe('#6 change 3: run enumeration is O(runs), not O(records)', () => {
  it('S3Mailbox.listPrefixes returns one entry per run, whatever the record count', async () => {
    const seam = fakeS3Seam();
    const mbox = new S3Mailbox(seam);
    await seedRuns(mbox, ['run-a', 'run-b', 'run-c'], 40);

    const prefixes = await mbox.listPrefixes!('orchestrator/outbox/');

    expect(prefixes).toEqual([
      'orchestrator/outbox/run-a/',
      'orchestrator/outbox/run-b/',
      'orchestrator/outbox/run-c/',
    ]);
    // 120 records behind 3 prefixes — the whole point.
    expect((await mbox.list('orchestrator/outbox/')).length).toBe(120);
  });

  it('uses the delimited seam call, not a full scan', async () => {
    // Guards the actual cost claim. Delegating to list() and post-processing would pass
    // a value-only assertion while keeping the O(records) behaviour this exists to fix.
    const seam = fakeS3Seam();
    const mbox = new S3Mailbox(seam);
    await seedRuns(mbox, ['run-a', 'run-b'], 10);

    seam.listCalls = 0;
    seam.prefixCalls = 0;
    await mbox.listPrefixes!('orchestrator/outbox/');

    expect(seam.prefixCalls).toBe(1);
    expect(seam.listCalls).toBe(0);
  });

  it('LocalDirMailbox.listPrefixes matches the S3 semantics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pangolin-mbox-'));
    try {
      const mbox = new LocalDirMailbox(root);
      await seedRuns(mbox, ['run-x', 'run-y'], 3);

      expect(await mbox.listPrefixes!('orchestrator/outbox/')).toEqual([
        'orchestrator/outbox/run-x/',
        'orchestrator/outbox/run-y/',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns immediate children only — a nested key does not leak deeper segments', async () => {
    const seam = fakeS3Seam();
    const mbox = new S3Mailbox(seam);
    await mbox.put('orchestrator/outbox/run-a/nested/deep/x.json', enc({}));

    expect(await mbox.listPrefixes!('orchestrator/outbox/')).toEqual([
      'orchestrator/outbox/run-a/',
    ]);
  });

  it('is empty, not an error, when nothing has been published', async () => {
    const seam = fakeS3Seam();
    const mbox = new S3Mailbox(seam);
    expect(await mbox.listPrefixes!('orchestrator/outbox/')).toEqual([]);
  });
});

describe('#6 change 3: transport.listRuns', () => {
  it('returns run ids, not key prefixes', async () => {
    const seam = fakeS3Seam();
    const mbox = new S3Mailbox(seam);
    const t = new MailboxSubmissionTransport(mbox);
    await seedRuns(mbox, ['run-a', 'run-b'], 5);

    expect((await t.listRuns()).sort()).toEqual(['run-a', 'run-b']);
  });

  it('falls back to list() when the mailbox has no delimited support', async () => {
    // The optional member has to be genuinely optional: a third-party MailboxStore that
    // predates it must still be able to answer, just less cheaply.
    const objects = new Map<string, Uint8Array>();
    const legacy: MailboxStore = {
      async put(k, b) {
        objects.set(k, b);
      },
      async get(k) {
        return objects.get(k) ?? null;
      },
      async delete(k) {
        objects.delete(k);
      },
      async list(p) {
        return [...objects.keys()].filter((k) => k.startsWith(p)).sort();
      },
    };
    const t = new MailboxSubmissionTransport(legacy);
    await seedRuns(legacy, ['run-p', 'run-q'], 4);

    expect((await t.listRuns()).sort()).toEqual(['run-p', 'run-q']);
  });
});
