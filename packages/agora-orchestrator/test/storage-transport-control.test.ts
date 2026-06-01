import { it, expect } from 'vitest';
import type { MailboxStore } from '../src/contracts/index.js';
import { MailboxSubmissionTransport } from '../src/transport/storage-transport.js';

/** Map-backed MailboxStore fake for unit tests — mirrors the setup in storage-transport.test.ts. */
function memMailbox(): MailboxStore {
  const m = new Map<string, Uint8Array>();
  return {
    async put(key, bytes) { m.set(key, bytes); },
    async get(key) { return m.get(key) ?? null; },
    async list(prefix) {
      const dirPrefix = prefix.endsWith('/') ? prefix : prefix + '/';
      return [...m.keys()].filter((k) => k === prefix || k.startsWith(dirPrefix));
    },
    async delete(key) { m.delete(key); },
  };
}

it('round-trips a cancel control request and acks it', async () => {
  const t = new MailboxSubmissionTransport(memMailbox());
  await t.control({ kind: 'cancel', target: 'run-1', actor: 'human:brett', at: '2026-05-31T00:00:00Z' });
  expect((await t.pollControl()).map((c) => c.target)).toEqual(['run-1']);
  // poll again — still present (not consumed until ackControl)
  expect((await t.pollControl()).map((c) => c.target)).toEqual(['run-1']);
  await t.ackControl('run-1');
  expect(await t.pollControl()).toEqual([]);
});
