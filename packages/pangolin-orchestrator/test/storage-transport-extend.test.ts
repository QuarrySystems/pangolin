import { it, expect } from 'vitest';
import type { MailboxStore } from '../src/contracts/index.js';
import { MailboxSubmissionTransport } from '../src/transport/storage-transport.js';

/** Map-backed MailboxStore fake for unit tests — mirrors the setup in storage-transport.test.ts. */
function makeMailbox(): MailboxStore {
  const m = new Map<string, Uint8Array>();
  return {
    async put(key, bytes) {
      m.set(key, bytes);
    },
    async get(key) {
      return m.get(key) ?? null;
    },
    async list(prefix) {
      const dirPrefix = prefix.endsWith('/') ? prefix : prefix + '/';
      return [...m.keys()].filter((k) => k === prefix || k.startsWith(dirPrefix));
    },
    async delete(key) {
      m.delete(key);
    },
  };
}

it('round-trips an extend with a surfaced seq: extend → pollExtends → ackExtend', async () => {
  const t = new MailboxSubmissionTransport(makeMailbox(), 'ns');
  await t.extend({ runId: 'r1', items: [], actor: 'app:x', at: 'T1' });
  const polled = await t.pollExtends();
  expect(polled.map((e) => e.runId)).toEqual(['r1']);
  expect(typeof polled[0]!.seq).toBe('string'); // transport-assigned
  await t.ackExtend('r1', polled[0]!.seq!);
  expect(await t.pollExtends()).toEqual([]);
});
