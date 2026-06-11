import type { MailboxStore, SubmissionTransport, SubmissionEnvelope, OutboxRecord, ControlEnvelope, ControlChannel } from '../contracts/index.js';

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const dec = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));

export class MailboxSubmissionTransport implements SubmissionTransport, ControlChannel {
  private seq = 0;
  constructor(private readonly mbox: MailboxStore, private readonly ns = 'orchestrator') {}
  private inbox = (id: string) => `${this.ns}/submissions/${id}.json`;
  private dead = (id: string) => `${this.ns}/dead/${id}.json`;
  private outbox = (id: string) => `${this.ns}/outbox/${id}/${String(++this.seq).padStart(12, '0')}.json`;
  private controlKey = (id: string) => `${this.ns}/control/${id}.json`;
  async submit(env: SubmissionEnvelope): Promise<string> {
    try { await this.mbox.put(this.inbox(env.run.id), enc(env)); return env.run.id; }
    catch (err) { throw new Error(`submit run ${env.run.id} failed`, { cause: err }); }
  }
  async pollInbox(): Promise<SubmissionEnvelope[]> {
    const keys = await this.mbox.list(`${this.ns}/submissions/`);
    const out: SubmissionEnvelope[] = [];
    for (const k of keys) { if (!k.endsWith('.json')) continue; const b = await this.mbox.get(k); if (b) out.push(dec(b) as SubmissionEnvelope); }
    return out;
  }
  async ack(runId: string): Promise<void> { await this.mbox.delete(this.inbox(runId)); }
  async deadLetter(runId: string): Promise<void> {
    const b = await this.mbox.get(this.inbox(runId));
    if (b) await this.mbox.put(this.dead(runId), b);
    await this.mbox.delete(this.inbox(runId));
  }
  async publish(rec: OutboxRecord): Promise<void> { await this.mbox.put(this.outbox(rec.runId), enc(rec)); }
  async readOutbox(runId: string): Promise<OutboxRecord[]> {
    const keys = (await this.mbox.list(`${this.ns}/outbox/${runId}/`)).sort();
    const out: OutboxRecord[] = [];
    for (const k of keys) { const b = await this.mbox.get(k); if (b?.length) out.push(dec(b) as OutboxRecord); }
    return out;
  }
  async control(env: ControlEnvelope): Promise<void> {
    try { await this.mbox.put(this.controlKey(env.target), enc(env)); }
    catch (err) { throw new Error(`control ${env.kind} target ${env.target} failed`, { cause: err }); }
  }
  async pollControl(): Promise<ControlEnvelope[]> {
    const keys = await this.mbox.list(`${this.ns}/control/`);
    const out: ControlEnvelope[] = [];
    for (const k of keys) { if (!k.endsWith('.json')) continue; const b = await this.mbox.get(k); if (b) out.push(dec(b) as ControlEnvelope); }
    return out;
  }
  async ackControl(target: string): Promise<void> { await this.mbox.delete(this.controlKey(target)); }
}
