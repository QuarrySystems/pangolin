import { it, expect } from 'vitest';
import { verify } from '../../src/audit-verify.js';
import { verifyBundle } from '../../src/audit-verify-bundle.js';
import { chainHash, merkleRoot, leavesFromEntryHashes } from '../../src/audit-merkle.js';
import { canonEntry } from '../../src/audit-canon.js';
import type { AuditStore, AuditAnchor, AnchoredRoot, AuditBundle, AuditEntryRow, TimestampToken } from '../../src/audit.js';

function oneEntryStore(runId: string): { store: AuditStore; root: Uint8Array } {
  const h0 = chainHash(canonEntry({ runId, seq: 0, kind: 'run.submitted', at: 't0' }), '');
  const entries = [{ runId, seq: 0, kind: 'run.submitted' as const, at: 't0', entryHash: h0, prevHash: '' }];
  const root = merkleRoot(leavesFromEntryHashes([h0]));
  const store = { getAuditEntries: () => entries } as unknown as AuditStore;
  return { store, root };
}
function anchorWith(root: Uint8Array, token?: TimestampToken): AuditAnchor {
  const anchored: AnchoredRoot = {
    epochId: 'r', root, receipt: { anchorId: 'a', epochId: 'r', guarantee: 'external-immutable', at: 0 },
    ...(token ? { timestamp: token } : {}),
  };
  return { id: 'a', guarantee: 'external-immutable', async anchor() { return anchored.receipt; }, async fetch() { return [anchored]; } };
}

it('no token present -> time check n/a, timeTier asserted', async () => {
  const { store, root } = oneEntryStore('r');
  const r = await verify('r', { store, anchor: anchorWith(root) });
  expect(r.checks.time.ok).toBe('n/a');
  expect(r.timeTier).toBe('asserted');
});
it('valid token + verifyTimestamp true -> time ok, timeTier tsa-attested', async () => {
  const { store, root } = oneEntryStore('r');
  const token: TimestampToken = { alg: 'rfc3161', token: new Uint8Array([1]), at: '2026-01-01T00:00:00Z' };
  const r = await verify('r', { store, anchor: anchorWith(root, token), verifyTimestamp: (rt, tk) => rt.length > 0 && tk === token });
  expect(r.checks.time.ok).toBe(true);
  expect(r.timeTier).toBe('tsa-attested');
});
it('token present but verifyTimestamp false -> time fails, tier asserted, intact unaffected', async () => {
  const { store, root } = oneEntryStore('r');
  const token: TimestampToken = { alg: 'rfc3161', token: new Uint8Array([1]), at: '2026-01-01T00:00:00Z' };
  const r = await verify('r', { store, anchor: anchorWith(root, token), verifyTimestamp: () => false });
  expect(r.checks.time.ok).toBe(false);
  expect(r.timeTier).toBe('asserted');
  expect(r.failure).toBeUndefined();   // time failure does NOT set failure
  expect(r.intact).toBe(true);          // and does NOT gate intact (clean chain stays intact)
});

it('verifyBundle threads verifyTimestamp: token on auditLog.root -> tsa-attested', async () => {
  const runId = 'r';
  const h0 = chainHash(canonEntry({ runId, seq: 0, kind: 'run.submitted', at: 't0' }), '');
  const entries: AuditEntryRow[] = [{ runId, seq: 0, kind: 'run.submitted', at: 't0', entryHash: h0, prevHash: '' }];
  const root = merkleRoot(leavesFromEntryHashes([h0]));
  const token: TimestampToken = { alg: 'rfc3161', token: new Uint8Array([1]), at: '2026-01-01T00:00:00Z' };
  // verifyBundle recomputes the report from auditLog.entries + the injected anchor's fetched root,
  // so the token must ride on the anchor's AnchoredRoot (same place verify() reads it).
  const anchored: AnchoredRoot = {
    epochId: runId, root, receipt: { anchorId: 'a', epochId: runId, guarantee: 'external-immutable', at: 0 }, timestamp: token,
  };
  const anchor: AuditAnchor = {
    id: 'a', guarantee: 'external-immutable', async anchor() { return anchored.receipt; }, async fetch() { return [anchored]; },
  };
  const bundle = {
    runId, manifests: [], auditLog: { entries, root: anchored }, items: [],
    report: undefined,
  } as unknown as AuditBundle;
  const r = await verifyBundle(bundle, { anchor, verifyTimestamp: () => true });
  expect(r.checks.time.ok).toBe(true);
  expect(r.timeTier).toBe('tsa-attested');
});
