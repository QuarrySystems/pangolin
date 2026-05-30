import type { StorageProvider } from '@quarry-systems/agora-core';
import type { SubmissionTransport, SubmissionEnvelope, OutboxRecord } from '../contracts/index.js';

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const dec = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));

export class StorageSubmissionTransport implements SubmissionTransport {
  constructor(private readonly storage: StorageProvider, private readonly ns = 'orchestrator') {}

  private inbox = (id: string) => `${this.ns}/submissions/${id}.json`;
  private claimed = (id: string) => `${this.ns}/submissions/${id}.claimed`;
  private outbox = (id: string, at: string) => `${this.ns}/outbox/${id}/${at}.json`;

  async submit(env: SubmissionEnvelope): Promise<string> {
    try {
      await this.storage.put(this.inbox(env.run.id), enc(env));
      return env.run.id;
    } catch (err) {
      throw new Error(`submit run ${env.run.id} failed`, { cause: err });
    }
  }

  async pollInbox(): Promise<SubmissionEnvelope[]> {
    const entries = await this.storage.list(`${this.ns}/submissions/`);
    const out: SubmissionEnvelope[] = [];
    for (const e of entries) {
      if (!e.uri.endsWith('.json')) continue;
      const env = dec(await this.storage.get(e.uri)) as SubmissionEnvelope;
      if (await this.isClaimed(env.run.id)) continue;
      await this.storage.put(this.claimed(env.run.id), enc({ at: env.submittedAt }));
      out.push(env);
    }
    return out;
  }

  async publish(rec: OutboxRecord): Promise<void> {
    await this.storage.put(this.outbox(rec.runId, rec.at), enc(rec));
  }

  async readOutbox(runId: string): Promise<OutboxRecord[]> {
    const entries = await this.storage.list(`${this.ns}/outbox/${runId}/`);
    const out: OutboxRecord[] = [];
    for (const e of entries) {
      const body = await this.storage.get(e.uri);
      if (!body?.length) continue;
      out.push(dec(body) as OutboxRecord);
    }
    return out;
  }

  private async isClaimed(id: string): Promise<boolean> {
    return (await this.storage.list(`${this.ns}/submissions/`)).some((e) => e.uri.endsWith(`${id}.claimed`));
  }
}
