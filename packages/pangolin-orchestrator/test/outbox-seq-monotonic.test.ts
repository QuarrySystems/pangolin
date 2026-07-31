// Outbox keys must stay ordered and unique ACROSS serve restarts.
//
// `MailboxSubmissionTransport.seq` is a per-INSTANCE counter and the outbox key is
// `outbox/<runId>/<seq padded>.json`. Seeded at 0, a restart rewinds it, so the new
// process mints keys that collide with the previous one's — and mailbox writes are
// overwrites. Two consequences, both silent:
//
//   1. HISTORY IS CLOBBERED. Records written before the restart are replaced. That can
//      take out a run's `kind: 'audit'` record, after which `orch audit` reports "no
//      audit export published yet" for a run that definitely sealed one.
//
//   2. THE NEWEST RECORD STOPS BEING THE HIGHEST KEY. Everything that reads "the
//      latest" picks the lexically-greatest key — readLatestOutbox scanning in reverse
//      today, and readOutbox().at(-1) before it. After a restart the greatest key
//      belongs to the PREVIOUS process, so status() silently goes backwards in time.
//
// Not currently exhibited on the serve stack only because it has run as a single
// process; the run inspected on 2026-07-31 spans 000000000002 -> 000001204974 with
// timestamps in step. The next restart is what breaks it.
//
// The fix seeds the counter from wall-clock ms and never lets it go backwards, so keys
// are monotonic across processes without needing any read of existing state.
import { describe, it, expect, vi } from 'vitest';
import { MailboxSubmissionTransport } from '../src/transport/storage-transport.js';
import type { MailboxStore } from '../src/contracts/index.js';

function makeMailbox(): MailboxStore & { keys(): string[] } {
  const objects = new Map<string, Uint8Array>();
  return {
    keys: () => [...objects.keys()].sort(),
    async put(key, body) {
      objects.set(key, body);
    },
    async get(key) {
      return objects.get(key);
    },
    async list(prefix) {
      return [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

const RUN = 'run-restart';

describe('outbox keys survive a process restart', () => {
  it('a restarted transport does not overwrite the previous process records', async () => {
    const mbox = makeMailbox();

    const before = new MailboxSubmissionTransport(mbox);
    await before.publish({ runId: RUN, kind: 'status', body: [], at: 'p1-first' });
    await before.publish({ runId: RUN, kind: 'status', body: [], at: 'p1-second' });

    // Restart: same mailbox, brand new instance — this is what serve does on boot.
    const after = new MailboxSubmissionTransport(mbox);
    await after.publish({ runId: RUN, kind: 'status', body: [], at: 'p2-first' });

    expect(await after.readOutbox(RUN)).toHaveLength(3); // was 2 — one was clobbered
  });

  it('the newest record is still the one "latest" resolves to after a restart', async () => {
    // A real restart is separated from the previous process by seconds, so the clock is
    // what orders the two. Faked here rather than slept, and set explicitly so the test
    // states the gap it depends on instead of inheriting whatever the machine does.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-31T12:00:00.000Z'));
      const mbox = makeMailbox();

      const before = new MailboxSubmissionTransport(mbox);
      for (let i = 0; i < 5; i++) {
        await before.publish({ runId: RUN, kind: 'status', body: [], at: `p1-${i}` });
      }

      vi.setSystemTime(new Date('2026-07-31T12:00:05.000Z')); // serve restarts 5s later
      const after = new MailboxSubmissionTransport(mbox);
      await after.publish({ runId: RUN, kind: 'status', body: [], at: 'p2-newest' });

      // Before the fix this returned 'p1-4': the previous process's highest key outranked
      // the new one, so status() reported a record older than the one just written.
      expect((await after.readLatestOutbox(RUN))?.at).toBe('p2-newest');
    } finally {
      vi.useRealTimers();
    }
  });

  it('records survive even a same-millisecond restart, though their order is then a tie', async () => {
    // The honest limit of a clock seed. Two processes starting inside the same
    // millisecond seed identically, and the earlier one may already have drifted ahead
    // of the clock — nothing a fresh instance can know without reading existing state.
    // So "newest sorts last" is not guaranteed in that window. What IS guaranteed, and
    // is the property that actually matters, is that nothing is overwritten.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-31T12:00:00.000Z'));
      const mbox = makeMailbox();

      const before = new MailboxSubmissionTransport(mbox);
      for (let i = 0; i < 5; i++) {
        await before.publish({ runId: RUN, kind: 'status', body: [], at: `p1-${i}` });
      }
      const after = new MailboxSubmissionTransport(mbox); // same ms — worst case
      await after.publish({ runId: RUN, kind: 'status', body: [], at: 'p2-newest' });

      expect(await after.readOutbox(RUN)).toHaveLength(6); // all six kept
    } finally {
      vi.useRealTimers();
    }
  });

  it("a run's audit record is not clobbered by post-restart status records", async () => {
    // The sharp edge: losing this record makes `orch audit` claim a sealed run never
    // published an export.
    const mbox = makeMailbox();

    const before = new MailboxSubmissionTransport(mbox);
    await before.publish({ runId: RUN, kind: 'status', body: [], at: 'p1-status' });
    await before.publish({ runId: RUN, kind: 'audit', body: { runId: RUN }, at: 'p1-audit' });

    const after = new MailboxSubmissionTransport(mbox);
    for (let i = 0; i < 3; i++) {
      await after.publish({ runId: RUN, kind: 'status', body: [], at: `p2-${i}` });
    }

    expect((await after.readLatestOutbox(RUN, 'audit'))?.at).toBe('p1-audit');
  });

  it('keys remain fixed-width and lexically sortable', async () => {
    // The reverse scan in readLatestOutbox depends on lexical order BEING publication
    // order. Ragged widths would break that quietly.
    const mbox = makeMailbox();
    const t = new MailboxSubmissionTransport(mbox);
    for (let i = 0; i < 3; i++) {
      await t.publish({ runId: RUN, kind: 'status', body: [], at: `k${i}` });
    }

    const names = mbox.keys().map((k) => k.split('/').pop()!.replace('.json', ''));
    expect(new Set(names.map((n) => n.length)).size).toBe(1); // one uniform width
    expect([...names].sort()).toEqual(names); // already in lexical order
  });

  it('sorts after legacy 12-digit keys written by earlier versions', async () => {
    // Existing stacks hold ~1.7M keys minted as String(++seq).padStart(12,'0'). New keys
    // must outrank them, or the first read after upgrading returns an ancient record.
    const mbox = makeMailbox();
    await mbox.put(
      `orchestrator/outbox/${RUN}/000001204974.json`,
      new TextEncoder().encode(
        JSON.stringify({ runId: RUN, kind: 'status', body: [], at: 'legacy-newest' }),
      ),
    );

    const t = new MailboxSubmissionTransport(mbox);
    await t.publish({ runId: RUN, kind: 'status', body: [], at: 'post-upgrade' });

    expect((await t.readLatestOutbox(RUN))?.at).toBe('post-upgrade');
  });
});
