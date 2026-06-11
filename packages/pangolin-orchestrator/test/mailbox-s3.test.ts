import { describe, it, expect } from 'vitest';
import { S3Mailbox } from '../src/mailbox/s3.js';
import type { MailboxS3Client } from '../src/contracts/index.js';

const fake = (): MailboxS3Client => {
  const m = new Map<string, Uint8Array>();
  return {
    put: async (k, b) => void m.set(k, b),
    get: async (k) => m.get(k) ?? null,
    list: async (p) => [...m.keys()].filter((k) => k.startsWith(p)),
    delete: async (k) => void m.delete(k),
  };
};

it('round-trips and prefix-lists at segment boundary', async () => {
  const mb = new S3Mailbox(fake());
  await mb.put('inbox/r1.json', new Uint8Array([1]));
  expect(await mb.get('inbox/r1.json')).toEqual(new Uint8Array([1]));
  expect(await mb.list('inbox')).toEqual(['inbox/r1.json']);
  expect(await mb.list('in')).toEqual([]); // 'in' must NOT match 'inbox/...'
});

it('list returns a key stored at exactly the bare prefix (k === prefix branch)', async () => {
  const mb = new S3Mailbox(fake());
  await mb.put('inbox', new Uint8Array([42]));
  await mb.put('inbox/r1.json', new Uint8Array([1]));
  const result = await mb.list('inbox');
  expect(result).toContain('inbox');
  expect(result).toContain('inbox/r1.json');
});

it('get of an absent key resolves to null', async () => {
  const mb = new S3Mailbox(fake());
  expect(await mb.get('no-such-key')).toBeNull();
});

it('delete of an absent key is a no-op (does not throw)', async () => {
  const mb = new S3Mailbox(fake());
  await expect(mb.delete('no-such-key')).resolves.toBeUndefined();
});
