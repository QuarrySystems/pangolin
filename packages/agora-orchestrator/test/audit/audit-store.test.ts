import { describe, it, expect } from 'vitest';
import { SqliteRunStateStore } from '../../src/runstate/sqlite.js';

describe('SqliteRunStateStore as AuditStore', () => {
  it('appends + reads audit entries in seq order; tracks chain head', () => {
    const s = new SqliteRunStateStore();
    s.appendAuditEntry({ runId: 'r', seq: 0, kind: 'run.submitted', at: 't0', entryHash: 'aa', prevHash: '' });
    s.appendAuditEntry({ runId: 'r', seq: 1, kind: 'item.fired', itemId: 'a', at: 't1', entryHash: 'bb', prevHash: 'aa' });
    expect(s.getAuditEntries('r').map((e) => e.seq)).toEqual([0, 1]);
    expect(s.getAuditEntries('r')[1]!.itemId).toBe('a');
    expect(s.getAuditChainHead('r')).toBe('bb');
    expect(s.getAuditChainHead('missing')).toBe('');
  });

  it('round-trips an anchored root (root bytes + signature + receipt incl locator)', () => {
    const s = new SqliteRunStateStore();
    const root = new Uint8Array(32).fill(5);
    s.putAuditRoot({ epochId: 'r', root, signature: { alg: 'ed25519', bytes: new Uint8Array([1,2]), keyRef: 'k' },
      receipt: { anchorId: 'local', epochId: 'r', guarantee: 'detect', at: 1, locator: 's3://x/y' } });
    const got = s.getAuditRoot('r')!;
    expect(Buffer.from(got.root)).toEqual(Buffer.from(root));
    expect(got.signature!.alg).toBe('ed25519');
    expect(Array.from(got.signature!.bytes)).toEqual([1,2]);
    expect(got.signature!.keyRef).toBe('k');
    expect(got.receipt).toMatchObject({ anchorId: 'local', guarantee: 'detect', at: 1, locator: 's3://x/y' });
  });

  it('round-trips a root with NO signature; getAuditRoot of missing epoch is undefined', () => {
    const s = new SqliteRunStateStore();
    s.putAuditRoot({ epochId: 'r2', root: new Uint8Array(32),
      receipt: { anchorId: 'local', epochId: 'r2', guarantee: 'detect', at: 2 } });
    expect(s.getAuditRoot('r2')!.signature).toBeUndefined();
    expect(s.getAuditRoot('nope')).toBeUndefined();
  });

  it('omits null optional fields from returned AuditEntryRow (undefined not null)', () => {
    const s = new SqliteRunStateStore();
    s.appendAuditEntry({ runId: 'r3', seq: 0, kind: 'run.submitted', at: 't', entryHash: 'cc', prevHash: '' });
    const entries = s.getAuditEntries('r3');
    expect(entries.length).toBe(1);
    const e = entries[0]!;
    expect(e.itemId).toBeUndefined();
    expect(e.status).toBeUndefined();
    expect(e.actor).toBeUndefined();
    expect(e.manifestRef).toBeUndefined();
    expect(e.resultRef).toBeUndefined();
    expect(e.entryHash).toBe('cc');
    expect(e.prevHash).toBe('');
  });
});
