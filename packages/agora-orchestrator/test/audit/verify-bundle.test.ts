import { describe, it, expect } from 'vitest';
import type { AuditBundle, AuditAnchor, AuditEntryRow, AnchoredRoot } from '../../src/contracts/index.js';
import { canonEntry } from '../../src/audit/canon.js';
import { chainHash, merkleRoot, leavesFromEntryHashes } from '../../src/audit/merkle.js';
import { verifyBundle } from '../../src/audit/verify-bundle.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type GuaranteeType = 'detect' | 'external-immutable' | 'witnessed';

/** Build a fake AuditAnchor that serves exactly one AnchoredRoot. */
const anchorOf = (root: Uint8Array, guarantee: GuaranteeType = 'external-immutable') => ({
  id: 'fake',
  guarantee,
  async anchor() {
    return { anchorId: 'fake', epochId: 'r', guarantee, at: 0 };
  },
  async fetch() {
    return [{ epochId: 'r', root, receipt: { anchorId: 'fake', epochId: 'r', guarantee, at: 0 } }];
  },
} satisfies AuditAnchor);

/** Build a pair of chained AuditEntryRows and compute their merkle root. */
function buildEntries(runId: string): { entries: AuditEntryRow[]; root: Uint8Array } {
  const mk = (e: Omit<AuditEntryRow, 'entryHash' | 'prevHash' | 'runId'>, prev: string): AuditEntryRow => {
    const entry = { ...e, runId };
    const eh = chainHash(canonEntry(entry), prev);
    return { ...entry, entryHash: eh, prevHash: prev };
  };

  const e0 = mk({ seq: 0, kind: 'run.submitted', at: 't0' }, '');
  const e1 = mk({ seq: 1, kind: 'run.completed', at: 't1' }, e0.entryHash);
  const root = merkleRoot(leavesFromEntryHashes([e0.entryHash, e1.entryHash]));
  return { entries: [e0, e1], root };
}

/** Build a sealed AuditBundle with correct chain + merkle root. */
function buildSealedBundle(runId: string = 'r'): { bundle: AuditBundle; root: Uint8Array } {
  const { entries, root } = buildEntries(runId);
  const anchoredRoot: AnchoredRoot = {
    epochId: runId,
    root,
    receipt: { anchorId: 'fake', epochId: runId, guarantee: 'external-immutable', at: 0 },
  };
  const bundle: AuditBundle = {
    runId,
    manifests: [],
    auditLog: { entries, root: anchoredRoot },
    items: [],
    report: {
      runId,
      anchorId: 'fake',
      guarantee: 'external-immutable',
      intact: true,
      claim: 'tamper-evident',
      checks: {
        chain: { ok: true },
        root: { ok: true },
        signature: { ok: 'n/a' },
        anchor: { ok: true },
      },
    },
  };
  return { bundle, root };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it('verifies a self-contained sealed bundle against the supplied external anchor', async () => {
  const { bundle, root } = buildSealedBundle();
  const r = await verifyBundle(bundle, { anchor: anchorOf(root, 'external-immutable') });
  expect(r.intact).toBe(true);
  expect(r.claim).toBe('tamper-evident');
});

it('a bundle whose entries were altered fails against the unchanged anchored root', async () => {
  const { bundle, root } = buildSealedBundle();
  // Mutate actor on the first entry AFTER computing entryHash, breaking the chain
  bundle.auditLog.entries[0]!.actor = 'attacker';
  const r = await verifyBundle(bundle, { anchor: anchorOf(root) });
  expect(r.intact).toBe(false);
  expect(r.checks.chain.ok).toBe(false);
});

it('detect-tier anchor on an intact bundle returns tamper-detecting', async () => {
  const { bundle, root } = buildSealedBundle();
  const r = await verifyBundle(bundle, { anchor: anchorOf(root, 'detect') });
  expect(r.intact).toBe(true);
  expect(r.claim).toBe('tamper-detecting');
});

it('ignores bundle.auditLog.root — an intact bundle with a garbage embedded root still verifies via the anchor', async () => {
  // The chain is left INTACT; only the embedded root is corrupted. If verifyBundle trusted the
  // embedded root it would report a root mismatch. It must pass, because the anchor holds the truth —
  // which directly proves the embedded root is never consulted.
  const { bundle, root } = buildSealedBundle();
  bundle.auditLog.root = {
    epochId: 'r',
    root: new Uint8Array(32).fill(0xff), // garbage embedded root
    receipt: { anchorId: 'fake', epochId: 'r', guarantee: 'external-immutable', at: 0 },
  };

  const r = await verifyBundle(bundle, { anchor: anchorOf(root, 'external-immutable') });

  expect(r.intact).toBe(true); // embedded garbage ignored; the anchored root is authoritative
  expect(r.checks.root.ok).toBe(true);
});

it('a root-mismatch is detected when recomputed root differs from the anchored one', async () => {
  const { bundle } = buildSealedBundle();
  // Supply a different (wrong) root via the anchor
  const wrongRoot = new Uint8Array(32).fill(0xab);
  const r = await verifyBundle(bundle, { anchor: anchorOf(wrongRoot, 'external-immutable') });
  expect(r.intact).toBe(false);
  expect(r.failure).toBe('root-mismatch');
  expect(r.checks.root.ok).toBe(false);
});

it('passes verifySignature through to verify() correctly', async () => {
  const { bundle, root } = buildSealedBundle();
  const r = await verifyBundle(bundle, {
    anchor: anchorOf(root, 'external-immutable'),
    verifySignature: () => true,
  });
  expect(r.intact).toBe(true);
});

it('a bad verifySignature causes intact to be false', async () => {
  const { bundle, root } = buildSealedBundle();
  // Add a signature field to the anchor fetch so signature check is triggered
  const anchorWithSig: AuditAnchor = {
    id: 'fake',
    guarantee: 'external-immutable',
    async anchor() {
      return { anchorId: 'fake', epochId: 'r', guarantee: 'external-immutable', at: 0 };
    },
    async fetch() {
      return [
        {
          epochId: 'r',
          root,
          signature: { alg: 'ed25519', bytes: new Uint8Array([9]) },
          receipt: { anchorId: 'fake', epochId: 'r', guarantee: 'external-immutable', at: 0 },
        },
      ];
    },
  };
  const r = await verifyBundle(bundle, { anchor: anchorWithSig, verifySignature: () => false });
  expect(r.intact).toBe(false);
  expect(r.failure).toBe('signature');
});
