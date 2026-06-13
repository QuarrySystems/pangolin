// Unit tests for make-recording-bundle.mjs
// No live run / MinIO required — tests forgeOneByte against a hand-constructed
// minimal fixture bundle with a valid single-entry audit chain.

import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
// make-recording-bundle.mjs is plain ESM (no .d.ts); forgeOneByte is exercised below.
// @ts-expect-error - untyped local .mjs import
import { forgeOneByte } from '../make-recording-bundle.mjs';
import { verifyBundle } from '@quarry-systems/pangolin-orchestrator';
import type { AuditBundle, AuditEntryRow, AuditAnchor, AnchoredRoot } from '@quarry-systems/pangolin-orchestrator';

// ---------------------------------------------------------------------------
// Helpers mirroring pangolin-orchestrator's canon + chain formulae.
// We recompute the entryHash so the fixture is provably correct.
// ---------------------------------------------------------------------------
function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function chainHash(canonStr: string, prevHash: string): string {
  return sha256hex(canonStr + prevHash);
}

function canonEntry(e: AuditEntryRow): string {
  return JSON.stringify([
    e.kind,
    e.runId,
    e.itemId ?? null,
    e.status ?? null,
    e.actor ?? null,
    e.manifestRef ?? null,
    e.resultRef ?? null,
    e.at,
    e.seq,
  ]);
}

// Merkle root: leaf domain SHA256(0x00 || leaf), single-leaf case.
function merkleRootForOneLeaf(hexHash: string): Uint8Array {
  const leafBytes = Buffer.from(hexHash, 'hex');
  const leafHashed = new Uint8Array(
    createHash('sha256').update(Buffer.concat([Buffer.from([0x00]), leafBytes])).digest(),
  );
  return leafHashed;
}

// ---------------------------------------------------------------------------
// Minimal valid fixture: single-entry audit chain, anchored root matching it.
// We need the anchor separately for verifyBundle; build a self-contained helper.
function makeFixture() {
  const runId = 'test-run-fixture-1';
  const at = '2026-01-01T00:00:00.000Z';

  const e0Partial = {
    kind: 'run.submitted' as const,
    runId,
    seq: 0,
    at,
  };
  const canonStr = canonEntry({ ...e0Partial, entryHash: '', prevHash: '' });
  const entryHash = chainHash(canonStr, '');

  const e0: AuditEntryRow = {
    ...e0Partial,
    entryHash,
    prevHash: '',
  };

  const rootBytes = merkleRootForOneLeaf(entryHash);

  const anchoredRoot: AnchoredRoot = {
    epochId: runId,
    root: rootBytes,
    receipt: {
      anchorId: 'fake-test-anchor',
      epochId: runId,
      guarantee: 'detect' as const,
      at: 0,
    },
  };

  const fakeAnchor: AuditAnchor = {
    id: 'fake-test-anchor',
    guarantee: 'detect' as const,
    async anchor() {
      return anchoredRoot.receipt;
    },
    async fetch(_range: { epochId?: string }): Promise<AnchoredRoot[]> {
      return [anchoredRoot];
    },
  };

  const bundle: AuditBundle = {
    runId,
    manifests: [],
    auditLog: { entries: [e0], root: anchoredRoot },
    items: [],
    report: {
      runId,
      intact: true,
      anchorId: 'fake-test-anchor',
      guarantee: 'detect',
      claim: 'tamper-detecting',
      timeTier: 'asserted',
      checks: {
        chain: { ok: true },
        root: { ok: true },
        signature: { ok: 'n/a' },
        anchor: { ok: true },
        handoff: { ok: true, detail: 'no handoff edges' },
        time: { ok: 'n/a' },
      },
    },
  };

  return { bundle, fakeAnchor };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('forgeOneByte', () => {
  it('changes the first entry entryHash by exactly one character', () => {
    const { bundle } = makeFixture();
    const original = bundle.auditLog.entries[0]!.entryHash;
    const forged = forgeOneByte(bundle);
    const forgedHash = forged.auditLog.entries[0]!.entryHash;

    expect(forgedHash).not.toBe(original);
    expect(forgedHash.length).toBe(original.length);

    // Exactly one character differs.
    let diffCount = 0;
    for (let i = 0; i < original.length; i++) {
      if (original[i] !== forgedHash[i]) diffCount++;
    }
    expect(diffCount).toBe(1);
  });

  it('does not mutate the input bundle (structuredClone)', () => {
    const { bundle } = makeFixture();
    const originalHash = bundle.auditLog.entries[0]!.entryHash;
    forgeOneByte(bundle);
    expect(bundle.auditLog.entries[0]!.entryHash).toBe(originalHash);
  });

  it('forged bundle fails verification with intact:false and failure:chain', async () => {
    const { bundle, fakeAnchor } = makeFixture();

    // Verify the clean bundle is intact first.
    const cleanReport = await verifyBundle(bundle, { anchor: fakeAnchor, verifySignature: () => true });
    expect(cleanReport.intact).toBe(true);

    // Forge and verify.
    const forged = forgeOneByte(bundle);
    const report = await verifyBundle(forged, { anchor: fakeAnchor, verifySignature: () => true });
    expect(report.intact).toBe(false);
    expect(report.failure).toBe('chain');
  });
});
