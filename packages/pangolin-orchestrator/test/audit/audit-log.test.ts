// Unit-isolate with INLINE fakes for Signer + AuditAnchor (real impls covered elsewhere).
import { describe, it, expect } from 'vitest';
import { SqliteRunStateStore } from '../../src/runstate/sqlite.js';
import { AuditLog } from '../../src/audit/audit-log.js';
const fakeSigner = { async sign() { return { alg: 'none', bytes: new Uint8Array(0) }; } };
function fakeAnchor() { const roots = new Map<string, any>(); return {
  id: 'fake', guarantee: 'detect' as const,
  async anchor(e: any) { const r = { anchorId: 'fake', epochId: e.epochId, guarantee: 'detect', at: 0 };
    roots.set(e.epochId, { ...e, receipt: r }); return r; },
  async fetch(q: any) { const r = roots.get(q.epochId); return r ? [r] : []; } }; }
it('append chains entries (genesis prev empty) and sealEpoch anchors a root', async () => {
  const store = new SqliteRunStateStore();
  const anchor = fakeAnchor();
  const log = new AuditLog({ store, signer: fakeSigner, anchor });
  log.append({ runId: 'r', kind: 'run.submitted', actor: 'human:brett', at: 't0' });
  log.append({ runId: 'r', kind: 'item.fired', itemId: 'a', manifestRef: 'm', at: 't1' });
  const entries = store.getAuditEntries('r');
  expect(entries[0]!.seq).toBe(0);
  expect(entries[0]!.prevHash).toBe('');
  expect(entries[1]!.prevHash).toBe(entries[0]!.entryHash);
  const receipt = await log.sealEpoch('r');
  expect(receipt.epochId).toBe('r');
  expect((await anchor.fetch({ epochId: 'r' })).length).toBe(1);
  expect(store.getAuditRoot('r')).toBeDefined();
  expect(store.getAuditRoot('r')!.receipt.epochId).toBe('r');
});
it('seq increments per run and is independent across runs', async () => {
  const store = new SqliteRunStateStore();
  const log = new AuditLog({ store, signer: fakeSigner, anchor: fakeAnchor() });
  log.append({ runId: 'r1', kind: 'run.submitted', at: 't0' });
  log.append({ runId: 'r2', kind: 'run.submitted', at: 't0' });
  log.append({ runId: 'r1', kind: 'run.completed', at: 't1' });
  expect(store.getAuditEntries('r1').map((e) => e.seq)).toEqual([0, 1]);
  expect(store.getAuditEntries('r2').map((e) => e.seq)).toEqual([0]);
});
