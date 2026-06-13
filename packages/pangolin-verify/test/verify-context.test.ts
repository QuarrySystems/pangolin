import { it, expect } from 'vitest';
import {
  canonEntry,
  chainHash,
  merkleRoot,
  leavesFromEntryHashes,
  verifyBundle,
} from '@quarry-systems/pangolin-core';
import type { AuditBundle, AuditEntryRow, AnchoredRoot } from '@quarry-systems/pangolin-core';
import { buildAnchor } from '../src/verify-context.js';
import type { VerifyContext } from '../src/verify-context.js';

/** Build a clean, internally-consistent sealed bundle (chain + merkle root agree). */
function buildSealedBundle(runId = 'r'): AuditBundle {
  const mk = (
    e: Omit<AuditEntryRow, 'entryHash' | 'prevHash' | 'runId'>,
    prev: string,
  ): AuditEntryRow => {
    const entry = { ...e, runId };
    const entryHash = chainHash(canonEntry(entry), prev);
    return { ...entry, entryHash, prevHash: prev };
  };
  const e0 = mk({ seq: 0, kind: 'run.submitted', at: 't0' }, '');
  const e1 = mk({ seq: 1, kind: 'run.completed', at: 't1' }, e0.entryHash);
  const entries = [e0, e1];
  const root = merkleRoot(leavesFromEntryHashes(entries.map((e) => e.entryHash)));
  const anchoredRoot: AnchoredRoot = {
    epochId: runId,
    root,
    receipt: { anchorId: 'offline', epochId: runId, guarantee: 'detect', at: 0 },
  };
  return {
    runId,
    manifests: [],
    auditLog: { entries, root: anchoredRoot },
    items: [],
    report: {
      runId,
      anchorId: 'offline',
      guarantee: 'detect',
      intact: true,
      claim: 'tamper-detecting',
      timeTier: 'asserted',
      checks: {
        chain: { ok: true },
        root: { ok: true },
        signature: { ok: 'n/a' },
        anchor: { ok: true },
        handoff: { ok: 'n/a' },
        time: { ok: 'n/a' },
      },
    },
  };
}

it('offline mode on a clean bundle compares the embedded root equal; claim is tamper-detecting', async () => {
  const bundle = buildSealedBundle('run-offline-1');
  const ctx: VerifyContext = { anchor: { mode: 'offline' }, tsaCaCertsDer: [] };
  const anchor = buildAnchor(ctx, bundle);
  expect(anchor.guarantee).toBe('detect');

  const report = await verifyBundle(bundle, { anchor });
  expect(report.intact).toBe(true);
  expect(report.checks.root.ok).toBe(true); // recomputed merkle == embedded anchored root
  expect(report.claim).toBe('tamper-detecting'); // claim ceiling for offline mode
});

it('offline mode flags a tampered bundle as not intact (root mismatch / chain break)', async () => {
  const bundle = buildSealedBundle('run-offline-tampered');
  // Mutate an entry after the fact — chain hash no longer matches.
  bundle.auditLog.entries[0]!.actor = 'attacker';
  const ctx: VerifyContext = { anchor: { mode: 'offline' }, tsaCaCertsDer: [] };
  const report = await verifyBundle(bundle, { anchor: buildAnchor(ctx, bundle) });
  expect(report.intact).toBe(false);
});
