import { describe, it, expect } from 'vitest';
import { LocalAnchor, S3ObjectLockAnchor, type S3LockClient } from '../../src/audit/anchor.js';

function memStore() {
  const m = new Map<string, any>();
  return {
    putAuditRoot: (r: any) => m.set(r.epochId, r),
    getAuditRoot: (id: string) => m.get(id),
    appendAuditEntry() {},
    getAuditEntries: () => [],
    getAuditChainHead: () => '',
  };
}

function fakeS3(): S3LockClient & { puts: any[] } {
  const store = new Map<string, Uint8Array>();
  const puts: any[] = [];
  return {
    puts,
    async putObject(key, body, opts) { puts.push({ key, opts }); store.set(key, body); },
    async getObject(key) { return store.get(key); },
  };
}

it('LocalAnchor (detect) anchors then fetches the same root', async () => {
  const a = new LocalAnchor(memStore() as any, () => 1000);
  const root = new Uint8Array(32).fill(9);
  const receipt = await a.anchor({ epochId: 'r', root });
  expect(receipt).toMatchObject({ anchorId: 'local', epochId: 'r', guarantee: 'detect', at: 1000 });
  expect(Buffer.from((await a.fetch({ epochId: 'r' }))[0]!.root).toString('hex')).toBe('09'.repeat(32));
});

it('LocalAnchor fetch of unknown epoch returns []', async () => {
  expect(await new LocalAnchor(memStore() as any).fetch({ epochId: 'nope' })).toEqual([]);
});

it('S3ObjectLockAnchor (external-immutable) PutObjects with COMPLIANCE lock + GetObject round-trips', async () => {
  const s3 = fakeS3();
  const a = new S3ObjectLockAnchor(s3, 'mybucket', 3650, () => 1000);
  expect(a.id).toBe('s3:mybucket');
  expect(a.guarantee).toBe('external-immutable');
  const root = new Uint8Array(32).fill(5);
  const receipt = await a.anchor({ epochId: 'r', root, signature: { alg: 'ed25519', bytes: new Uint8Array([1, 2, 3]) } });
  expect(receipt.locator).toBe('s3://mybucket/audit/roots/r.json');
  expect(s3.puts[0].opts.mode).toBe('COMPLIANCE');
  expect(s3.puts[0].opts.retainUntil instanceof Date).toBe(true);
  const got = (await a.fetch({ epochId: 'r' }))[0]!;
  expect(Buffer.from(got.root).toString('hex')).toBe('05'.repeat(32));
  expect(got.signature!.alg).toBe('ed25519');
  expect(Array.from(got.signature!.bytes)).toEqual([1, 2, 3]);
});

it('S3ObjectLockAnchor fetch of missing key returns []', async () => {
  expect(await new S3ObjectLockAnchor(fakeS3(), 'b').fetch({ epochId: 'x' })).toEqual([]);
});
