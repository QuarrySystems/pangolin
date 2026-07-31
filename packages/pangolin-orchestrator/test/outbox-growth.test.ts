// Regression tests for KNOWN-ISSUES.md #6 — "the outbox grows without bound, and
// every client read walks all of it".
//
// Two independent faults compound, and each is pinned separately here:
//
//   (1) WRITE AMPLIFICATION. serve/driver.ts calls getStatus() with no argument,
//       which returns every item in the store, so the loop publishes one status
//       record per run PER TICK — forever, including for runs that reached a
//       terminal state days earlier. A 67-second run was measured holding 23,307
//       outbox records.
//
//   (2) UNINDEXED READS. Every client read (status/audit/watch) listed the run's
//       prefix and then issued a sequential get per key. Reading one completed
//       run took over 60s against that same stack.
//
// Note the ordering dependency between them: the audit export is published ONCE,
// and status records keep landing on top of it, so a reverse scan alone does NOT
// make audit() cheap while (1) is unfixed — it would walk back over every status
// record published since the seal. Fixing (1) is what puts the audit record back
// within reach of the fast path. The audit test below encodes that.
import { describe, it, expect } from 'vitest';
import { OperationsApi } from '../src/operations-api.js';
import { MailboxSubmissionTransport } from '../src/transport/storage-transport.js';
import type { MailboxStore, OutboxRecord, AuditExport } from '../src/contracts/index.js';

// ---------------------------------------------------------------------------
// Counting in-memory MailboxStore — the point of these tests is the NUMBER of
// object reads, so the fake counts them.
// ---------------------------------------------------------------------------
function makeCountingMailbox(): MailboxStore & { gets: number; lists: number } {
  const objects = new Map<string, Uint8Array>();
  const store = {
    gets: 0,
    lists: 0,
    async put(key: string, body: Uint8Array): Promise<void> {
      objects.set(key, body);
    },
    async get(key: string): Promise<Uint8Array | undefined> {
      store.gets++;
      return objects.get(key);
    },
    async list(prefix: string): Promise<string[]> {
      store.lists++;
      return [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
    async delete(key: string): Promise<void> {
      objects.delete(key);
    },
  };
  return store;
}

const RUN = 'run-outbox-growth';

describe('#6 (2) client reads must not walk the whole outbox', () => {
  it('status() reads O(1) objects, not one per record', async () => {
    const mbox = makeCountingMailbox();
    const transport = new MailboxSubmissionTransport(mbox);
    for (let i = 0; i < 500; i++) {
      await transport.publish({
        runId: RUN,
        kind: 'status',
        body: [{ status: 'running' }],
        at: `t${i}`,
      });
    }

    const api = new OperationsApi({ transport });
    mbox.gets = 0;
    const rec = await api.status(RUN);

    expect(rec?.at).toBe('t499'); // still the newest record
    // Before the fix this was 500. Allow a small constant, not a per-record cost.
    expect(mbox.gets).toBeLessThanOrEqual(2);
  });

  it('audit() finds the sealed export without decoding every status record', async () => {
    const mbox = makeCountingMailbox();
    const transport = new MailboxSubmissionTransport(mbox);

    const exp: AuditExport = { runId: RUN } as AuditExport;
    // The realistic layout AFTER fault (1) is fixed: the audit export is the last
    // thing published, because a terminal run stops emitting status records.
    for (let i = 0; i < 500; i++) {
      await transport.publish({
        runId: RUN,
        kind: 'status',
        body: [{ status: 'done' }],
        at: `t${i}`,
      });
    }
    await transport.publish({ runId: RUN, kind: 'audit', body: exp, at: 'seal' });

    mbox.gets = 0;
    const found = await transport.readLatestOutbox(RUN, 'audit');

    expect(found?.at).toBe('seal');
    expect(mbox.gets).toBeLessThanOrEqual(2);
  });

  it('readLatestOutbox still returns undefined when the kind was never published', async () => {
    const mbox = makeCountingMailbox();
    const transport = new MailboxSubmissionTransport(mbox);
    await transport.publish({ runId: RUN, kind: 'status', body: [], at: 't0' });

    expect(await transport.readLatestOutbox(RUN, 'audit')).toBeUndefined();
    expect(await transport.readLatestOutbox('no-such-run')).toBeUndefined();
  });

  it('readLatestOutbox with no kind returns the newest record of any kind', async () => {
    const mbox = makeCountingMailbox();
    const transport = new MailboxSubmissionTransport(mbox);
    await transport.publish({ runId: RUN, kind: 'status', body: [], at: 't0' });
    await transport.publish({ runId: RUN, kind: 'audit', body: {}, at: 't1' });

    expect((await transport.readLatestOutbox(RUN))?.at).toBe('t1');
  });

  it('ordering is by seq, not by lexical `at` — 10 outlives 9', async () => {
    // Guards the zero-padded key convention the reverse scan depends on.
    const mbox = makeCountingMailbox();
    const transport = new MailboxSubmissionTransport(mbox);
    for (let i = 0; i < 11; i++) {
      await transport.publish({ runId: RUN, kind: 'status', body: [], at: `t${i}` });
    }
    expect((await transport.readLatestOutbox(RUN))?.at).toBe('t10');
  });

  it('OperationsApi falls back to readOutbox when the transport lacks the fast path', async () => {
    // Custom//older transports do not implement readLatestOutbox — it is optional,
    // so they must keep working unchanged.
    const records: OutboxRecord[] = [
      { runId: RUN, kind: 'status', body: [{ status: 'running' }], at: 't0' },
      { runId: RUN, kind: 'status', body: [{ status: 'done' }], at: 't1' },
    ];
    const legacy = {
      async submit() {
        return RUN;
      },
      async pollInbox() {
        return [];
      },
      async ack() {},
      async deadLetter() {},
      async publish() {},
      async readOutbox() {
        return records;
      },
    };

    const api = new OperationsApi({ transport: legacy });
    expect((await api.status(RUN))?.at).toBe('t1');
  });
});
