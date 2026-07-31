import { randomUUID } from 'node:crypto';
import type {
  MailboxStore,
  SubmissionTransport,
  SubmissionEnvelope,
  OutboxRecord,
  OutboxKind,
  ControlEnvelope,
  ControlChannel,
  AppendChannel,
  ExtendEnvelope,
} from '../contracts/index.js';

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const dec = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));

export class MailboxSubmissionTransport
  implements SubmissionTransport, ControlChannel, AppendChannel
{
  private seq = 0;
  constructor(
    private readonly mbox: MailboxStore,
    private readonly ns = 'orchestrator',
  ) {}
  private inbox = (id: string) => `${this.ns}/submissions/${id}.json`;
  private dead = (id: string) => `${this.ns}/dead/${id}.json`;

  /** Next outbox sequence — WALL-CLOCK SEEDED, and never allowed to go backwards.
   *
   *  This counter is per-INSTANCE and mailbox writes are overwrites, so seeding it at 0
   *  (as this did) meant every serve restart rewound it and the new process re-minted
   *  keys the previous one had already used. Two silent failures came out of that:
   *  records written before the restart were CLOBBERED — including, eventually, a run's
   *  `kind: 'audit'` record, after which `orch audit` reports "no audit export published
   *  yet" for a run that definitely sealed one — and the lexically-greatest key stopped
   *  being the newest, so everything that reads "the latest" (readLatestOutbox's reverse
   *  scan, readOutbox().at(-1) before it) silently returned a pre-restart record.
   *
   *  Seeding from Date.now() makes a fresh process resume ahead of any predecessor
   *  without reading a byte of existing state. The max() guards the one case a bare
   *  clock read would not: sustained publishing faster than 1/ms would run the counter
   *  ahead of wall clock, and it must then keep climbing rather than stall or repeat.
   *  (Observed rate on the serve stack is ~47/s, so this is headroom, not a hot path.) */
  private nextSeq(): number {
    this.seq = Math.max(Date.now(), this.seq + 1);
    return this.seq;
  }

  /** Per-instance discriminator, closing the one collision window the clock seed cannot.
   *  Two processes starting inside the SAME millisecond seed to the same value, and
   *  without this their first records would overwrite each other — the exact failure
   *  being fixed, just narrowed rather than closed. It sorts after the sequence, so
   *  ordering is unaffected: ties only occur between records that are genuinely
   *  concurrent, and both survive. */
  private readonly instance = randomUUID().slice(0, 8);

  /** Width 16, not 12: epoch-ms is 13 digits today and 12 would truncate the ordering
   *  this key exists to encode. Legacy 12-digit keys still sort BEFORE these — they
   *  differ inside the leading zeros, long before length matters — so a stack upgraded
   *  mid-life keeps reading its newest record, not its oldest. */
  private outbox = (id: string) =>
    `${this.ns}/outbox/${id}/${String(this.nextSeq()).padStart(16, '0')}-${this.instance}.json`;
  private controlKey = (id: string) => `${this.ns}/control/${id}.json`;
  async submit(env: SubmissionEnvelope): Promise<string> {
    try {
      await this.mbox.put(this.inbox(env.run.id), enc(env));
      return env.run.id;
    } catch (err) {
      throw new Error(`submit run ${env.run.id} failed`, { cause: err });
    }
  }
  async pollInbox(): Promise<SubmissionEnvelope[]> {
    const keys = await this.mbox.list(`${this.ns}/submissions/`);
    const out: SubmissionEnvelope[] = [];
    for (const k of keys) {
      if (!k.endsWith('.json')) continue;
      const b = await this.mbox.get(k);
      if (b) out.push(dec(b) as SubmissionEnvelope);
    }
    return out;
  }
  async ack(runId: string): Promise<void> {
    await this.mbox.delete(this.inbox(runId));
  }
  async deadLetter(runId: string): Promise<void> {
    const b = await this.mbox.get(this.inbox(runId));
    if (b) await this.mbox.put(this.dead(runId), b);
    await this.mbox.delete(this.inbox(runId));
  }
  async publish(rec: OutboxRecord): Promise<void> {
    await this.mbox.put(this.outbox(rec.runId), enc(rec));
  }
  async readOutbox(runId: string): Promise<OutboxRecord[]> {
    const keys = (await this.mbox.list(`${this.ns}/outbox/${runId}/`)).sort();
    const out: OutboxRecord[] = [];
    for (const k of keys) {
      const b = await this.mbox.get(k);
      if (b?.length) out.push(dec(b) as OutboxRecord);
    }
    return out;
  }
  /** Newest record of `kind` (any kind when omitted), without reading the whole outbox.
   *
   *  Rests on lexical key order being publication order, which `outbox()` above provides
   *  by zero-padding to a fixed width — seq 10 sorts after seq 9, not between 1 and 2.
   *  An earlier version of this comment stopped there, and that was only true WITHIN one
   *  process: the sequence used to reset to 0 on restart, so the greatest key could
   *  belong to a previous run of the daemon. The clock seeding in `nextSeq()` is what
   *  makes the claim hold across restarts, and the two must be read together.
   *
   *  Scanning back from the newest key and stopping at the first match costs one `get`
   *  in the common case instead of one per record.
   *
   *  Still O(keys) in the worst case — a `kind` that was never published reads
   *  everything. Both real callers ask for a kind that is normally the newest or nearly
   *  so, which is what makes this a fast path in practice rather than only in theory. */
  async readLatestOutbox(runId: string, kind?: OutboxKind): Promise<OutboxRecord | undefined> {
    const keys = (await this.mbox.list(`${this.ns}/outbox/${runId}/`)).sort();
    for (let i = keys.length - 1; i >= 0; i--) {
      const b = await this.mbox.get(keys[i]);
      if (!b?.length) continue;
      const rec = dec(b) as OutboxRecord;
      if (kind === undefined || rec.kind === kind) return rec;
    }
    return undefined;
  }
  async control(env: ControlEnvelope): Promise<void> {
    try {
      await this.mbox.put(this.controlKey(env.target), enc(env));
    } catch (err) {
      throw new Error(`control ${env.kind} target ${env.target} failed`, { cause: err });
    }
  }
  async pollControl(): Promise<ControlEnvelope[]> {
    const keys = await this.mbox.list(`${this.ns}/control/`);
    const out: ControlEnvelope[] = [];
    for (const k of keys) {
      if (!k.endsWith('.json')) continue;
      const b = await this.mbox.get(k);
      if (b) out.push(dec(b) as ControlEnvelope);
    }
    return out;
  }
  async ackControl(target: string): Promise<void> {
    await this.mbox.delete(this.controlKey(target));
  }

  private extendKey = (runId: string, seq: string) => `${this.ns}/extends/${runId}/${seq}.json`;
  async extend(env: ExtendEnvelope): Promise<void> {
    const seq = randomUUID();
    await this.mbox.put(this.extendKey(env.runId, seq), enc({ ...env, seq }));
  }
  async pollExtends(): Promise<ExtendEnvelope[]> {
    const keys = await this.mbox.list(`${this.ns}/extends/`);
    const out: ExtendEnvelope[] = [];
    for (const k of keys) {
      if (!k.endsWith('.json')) continue;
      const b = await this.mbox.get(k);
      if (b) out.push(dec(b) as ExtendEnvelope);
    }
    return out;
  }
  async ackExtend(runId: string, seq: string): Promise<void> {
    await this.mbox.delete(this.extendKey(runId, seq));
  }
}
