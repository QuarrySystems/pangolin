import { it, expect } from 'vitest';
import { canonEntry } from '../../src/audit/canon.js';
import { chainHash, merkleRoot, leavesFromEntryHashes } from '../../src/audit/merkle.js';
import { LocalAnchor, S3ObjectLockAnchor, type S3LockClient } from '../../src/audit/anchor.js';
import { verify } from '../../src/audit/verify.js';
import type { AuditEntryRow, AuditStore } from '../../src/contracts/index.js';
import { createLocalSigner, verifyEd25519 } from '../../src/audit/signer.js';

// A mutable in-memory AuditStore whose audit_entries array we can forge in place.
function memStore(entries: AuditEntryRow[]) {
  const roots = new Map<string, any>();
  return {
    entries,
    appendAuditEntry: (r: AuditEntryRow) => entries.push(r),
    getAuditEntries: () => entries,
    getAuditChainHead: () => (entries.length ? entries[entries.length - 1]!.entryHash : ''),
    putAuditRoot: (r: any) => roots.set(r.epochId, r),
    getAuditRoot: (id: string) => roots.get(id),
  } as unknown as AuditStore & { entries: AuditEntryRow[] };
}

// STRICT immutable S3 fake — simulates COMPLIANCE: overwriting an existing key is rejected.
// Versioned fake modeling REAL S3 object-lock semantics: putObject ALWAYS succeeds (each PUT
// is a new version — Object Lock never rejects a new version), and getObject returns the
// EARLIEST (original) version, mirroring the fixed AwsS3LockClient. This is the property that
// makes the anchor tamper-evident: an attacker can append a forged newer version, but the
// lock-protected original (read by the anchor) cannot be superseded.
function versionedFakeS3(): S3LockClient {
  const m = new Map<string, Uint8Array[]>();
  return {
    async putObject(key, body) { const v = m.get(key) ?? []; v.push(body); m.set(key, v); },
    async getObject(key) { return m.get(key)?.[0]; },
  };
}

// Build a 2-entry chained run with the REAL hashing primitives, returning rows + Merkle root.
function buildRun(runId: string): { rows: AuditEntryRow[]; root: Uint8Array } {
  const e0 = { runId, seq: 0, kind: 'run.submitted' as const, actor: 'human:brett', at: 't0' };
  const h0 = chainHash(canonEntry(e0 as any), '');
  const e1 = { runId, seq: 1, kind: 'run.completed' as const, at: 't1' };
  const h1 = chainHash(canonEntry(e1 as any), h0);
  const rows: AuditEntryRow[] = [
    { ...(e0 as any), entryHash: h0, prevHash: '' },
    { ...(e1 as any), entryHash: h1, prevHash: h0 },
  ];
  return { rows, root: merkleRoot(leavesFromEntryHashes([h0, h1])) };
}

// Chain-consistent forge: rewrite entry 0's actor, recompute its hash, and RELINK entry 1
// (prevHash + entryHash) so the chain re-verifies. Returns the fresh local Merkle root.
function forgeInPlace(rows: AuditEntryRow[]): Uint8Array {
  rows[0]!.actor = 'attacker';
  const h0 = chainHash(canonEntry(rows[0]! as any), '');
  rows[0]!.entryHash = h0;
  rows[1]!.prevHash = h0;
  rows[1]!.entryHash = chainHash(canonEntry(rows[1]! as any), h0);
  return merkleRoot(leavesFromEntryHashes([rows[0]!.entryHash, rows[1]!.entryHash]));
}

it('chain-consistent forge: LocalAnchor (mutable) is fooled -> intact:true', async () => {
  const { rows, root } = buildRun('r');
  const store = memStore(rows);
  const anchor = new LocalAnchor(store);
  await anchor.anchor({ epochId: 'r', root });            // seal original root

  const forgedRoot = forgeInPlace(store.entries);          // attacker forges the chain
  await anchor.anchor({ epochId: 'r', root: forgedRoot }); // mutable store: re-anchor SUCCEEDS

  const report = await verify('r', { store, anchor });
  expect(report.checks.chain.ok).toBe(true);               // forge kept the chain consistent
  expect(report.intact).toBe(true);                        // forgery UNDETECTED — "tamper-detecting only"
  expect(report.claim).toBe('tamper-detecting');
});

it('chain-consistent forge: S3ObjectLockAnchor (immutable) catches it -> root-mismatch', async () => {
  const { rows, root } = buildRun('r');
  const store = memStore(rows);
  const anchor = new S3ObjectLockAnchor(versionedFakeS3(), 'bucket');
  await anchor.anchor({ epochId: 'r', root });             // seal original root (version 1, locked)

  const forgedRoot = forgeInPlace(store.entries);
  // Attacker re-anchors the forged root. S3 versioning ACCEPTS it as a new (latest) version —
  // Object Lock never rejects a new version — but the anchor reads the EARLIEST (locked
  // original) version, so the forgery is ignored at fetch time.
  await anchor.anchor({ epochId: 'r', root: forgedRoot });

  const report = await verify('r', { store, anchor });
  expect(report.checks.chain.ok).toBe(true);               // chain still consistent...
  expect(report.checks.root.ok).toBe(false);               // ...but recomputed root != immutable anchored root
  expect(report.failure).toBe('root-mismatch');
  expect(report.intact).toBe(false);
  expect(report.claim).toBe('tamper-detecting');           // the tamper-evident claim correctly collapses
});

// Fake modeling the SAME-SECOND tie WORST CASE: when an attacker writes a forged version in
// the SAME second as the seal, S3's version order at second-granularity is ambiguous, so the
// earliest-read CAN return the forgery. This fake returns the most-recently written version to
// model that worst case. (Contrast versionedFakeS3, which returns the earliest = later-second
// case that #69 already defeats.)
function sameSecondTieFakeS3(): S3LockClient {
  const m = new Map<string, Uint8Array[]>();
  return {
    async putObject(key, body) { const v = m.get(key) ?? []; v.push(body); m.set(key, v); },
    async getObject(key) { const v = m.get(key); return v?.[v.length - 1]; },
  };
}

it('same-second forgery (unsigned) selected by the tie -> tamper-evident claim collapses', async () => {
  const { rows, root } = buildRun('r');
  const store = memStore(rows);
  const signer = createLocalSigner();
  const anchor = new S3ObjectLockAnchor(sameSecondTieFakeS3(), 'bucket');

  // Honest SIGNED seal (version 0, lock-protected original).
  await anchor.anchor({ epochId: 'r', root, signature: await signer.sign(root) });

  // Attacker forges the chain and writes an UNSIGNED forged version in the same second (version 1).
  const forgedRoot = forgeInPlace(store.entries);
  await anchor.anchor({ epochId: 'r', root: forgedRoot }); // no signature

  const report = await verify('r', {
    store, anchor,
    verifySignature: (r, sig) => verifyEd25519(r, sig, signer.publicKey),
  });

  // The read returned the forgery: its root matches the forged entries (rootOk true), but it
  // carries NO signature -> sigOk 'n/a'. The tamper-evident claim MUST NOT be granted.
  expect(report.checks.root.ok).toBe(true);        // forgery is structurally self-consistent
  expect(report.checks.signature.ok).toBe('n/a');  // unsigned forgery — no verifiable authorship
  expect(report.claim).toBe('tamper-detecting');   // pre-fix BUG: returns 'tamper-evident'
});

it('clean external-immutable run verified without a signature verifier -> tamper-detecting', async () => {
  const { rows, root } = buildRun('r');
  const store = memStore(rows);
  const signer = createLocalSigner();
  const anchor = new S3ObjectLockAnchor(versionedFakeS3(), 'bucket');
  await anchor.anchor({ epochId: 'r', root, signature: await signer.sign(root) });

  // No verifySignature injected -> the verifier cannot confirm authorship -> not tamper-evident.
  const report = await verify('r', { store, anchor });
  expect(report.intact).toBe(true);
  expect(report.claim).toBe('tamper-detecting');   // pre-fix BUG: returns 'tamper-evident'
});
