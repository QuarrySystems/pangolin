import { describe, it, expect } from 'vitest';
import type {
  AuditBundle,
  AuditAnchor,
  AuditEntryRow,
  AnchoredRoot,
  DispatchManifest,
  Authorization,
} from '../src/audit.js';
import { verifyBundle } from '../src/audit-verify-bundle.js';
import { computeContentHash, buildPangolinUri } from '../src/index.js';
import { canonEntry } from '../src/audit-canon.js';
import { chainHash, merkleRoot, leavesFromEntryHashes } from '../src/audit-merkle.js';

// ---------------------------------------------------------------------------
// Helpers (mirrors the approach from verify-bundle-manifest-integrity.test.ts)
// ---------------------------------------------------------------------------

/** Mint the manifestRef the same way the dispatch executor does. */
function manifestRefOf(m: DispatchManifest): string {
  return buildPangolinUri({
    namespace: 'ns',
    type: 'manifest',
    name: 'd1',
    contentHash: computeContentHash(m),
  });
}

/** Offline anchor that serves exactly one AnchoredRoot. */
function anchorOf(root: Uint8Array): AuditAnchor {
  return {
    id: 'offline',
    guarantee: 'detect',
    async anchor() {
      return { anchorId: 'offline', epochId: 'r1', guarantee: 'detect', at: 0 };
    },
    async fetch() {
      return [
        {
          epochId: 'r1',
          root,
          receipt: { anchorId: 'offline', epochId: 'r1', guarantee: 'detect', at: 0 },
        } satisfies AnchoredRoot,
      ];
    },
  };
}

/** Build a 3-entry chained log (run.submitted + item.fired + run.completed).
 *
 *  The `item.fired` entry is needed because the manifest-integrity chain-binding check
 *  requires the export item's manifestRef to be present in the set of chain-anchored
 *  item.fired refs. Without it, any bundle with a pinned manifestRef would verify as
 *  not-intact (failure:'manifest'). This matches real orchestrator behaviour:
 *  tick.ts writes the same manifestRef to both the export item and the chained entry.
 */
function buildEntries(
  runId: string,
  opts: { itemId: string; manifestRef: string },
): { entries: AuditEntryRow[]; root: Uint8Array } {
  const mk = (
    e: Omit<AuditEntryRow, 'entryHash' | 'prevHash' | 'runId'>,
    prev: string,
  ): AuditEntryRow => {
    const entry = { ...e, runId, entryHash: '', prevHash: prev } as AuditEntryRow;
    const eh = chainHash(canonEntry(entry), prev);
    return { ...entry, entryHash: eh } as AuditEntryRow;
  };

  const e0 = mk({ seq: 0, kind: 'run.submitted', at: 't0' }, '');
  const e1 = mk(
    { seq: 1, kind: 'item.fired', itemId: opts.itemId, manifestRef: opts.manifestRef, at: 't1' },
    e0.entryHash,
  );
  const e2 = mk({ seq: 2, kind: 'run.completed', at: 't2' }, e1.entryHash);
  const root = merkleRoot(leavesFromEntryHashes([e0.entryHash, e1.entryHash, e2.entryHash]));
  return { entries: [e0, e1, e2], root };
}

/** Build a 2-entry chained log with an item.denied entry that carries authorization. */
function buildEntriesWithDenied(
  runId: string,
  authorization: Authorization,
): { entries: AuditEntryRow[]; root: Uint8Array } {
  const mk = (
    e: Omit<AuditEntryRow, 'entryHash' | 'prevHash' | 'runId'>,
    prev: string,
  ): AuditEntryRow => {
    const entry = { ...e, runId, entryHash: '', prevHash: prev } as AuditEntryRow;
    const eh = chainHash(canonEntry(entry), prev);
    return { ...entry, entryHash: eh } as AuditEntryRow;
  };

  const e0 = mk({ seq: 0, kind: 'run.submitted', at: 't0' }, '');
  const e1 = mk(
    { seq: 1, kind: 'item.denied', itemId: 'item-a', at: 't1', authorization },
    e0.entryHash,
  );
  const root = merkleRoot(leavesFromEntryHashes([e0.entryHash, e1.entryHash]));
  return { entries: [e0, e1], root };
}

/** Build a minimal DispatchManifest, optionally with an authorization block. */
function minimalManifest(auth?: Authorization): DispatchManifest {
  const base: Omit<DispatchManifest, 'manifestHash'> = {
    schemaVersion: 1 as const,
    runId: 'r1',
    itemId: 'item-a',
    parent: 'run:r1',
    executor: 'dispatch',
    executorManifest: {},
    secretRefs: [],
    actor: 'human:test',
    firedAt: '2024-01-01T00:00:00Z',
    ...(auth !== undefined ? { authorization: auth } : {}),
  };
  return { ...base, manifestHash: computeContentHash(base) };
}

/** Assemble a verifiable AuditBundle from a manifest + log entries + anchored root. */
function buildBundle(
  m: DispatchManifest,
  entries: AuditEntryRow[],
  anchoredRoot: AnchoredRoot,
): AuditBundle {
  const runId = 'r1';
  return {
    runId,
    manifests: [m],
    auditLog: { entries, root: anchoredRoot },
    items: [
      {
        id: m.itemId,
        status: 'done',
        manifestRef: manifestRefOf(m),
      },
    ],
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('authzTier derivation (orthogonal to tamper claim)', () => {
  it('none: no authorization on any manifest → authzTier === "none"', async () => {
    const m = minimalManifest(); // no authorization block
    const { entries, root } = buildEntries('r1', {
      itemId: m.itemId,
      manifestRef: manifestRefOf(m),
    });
    const anchoredRoot: AnchoredRoot = {
      epochId: 'r1',
      root,
      receipt: { anchorId: 'offline', epochId: 'r1', guarantee: 'detect', at: 0 },
    };
    const bundle = buildBundle(m, entries, anchoredRoot);
    const anchor = anchorOf(root);

    const report = await verifyBundle(bundle, { anchor });

    expect(report.authzTier).toBe('none');
  });

  it('none: authorization.verdict === "not-evaluated" → authzTier === "none"', async () => {
    const auth: Authorization = {
      verdict: 'not-evaluated',
      principal: 'none',
      policyRef: 'sha256:0000',
      effectClass: 'dispatch.default',
      at: '2024-01-01T00:00:00Z',
    };
    const m = minimalManifest(auth);
    const { entries, root } = buildEntries('r1', {
      itemId: m.itemId,
      manifestRef: manifestRefOf(m),
    });
    const anchoredRoot: AnchoredRoot = {
      epochId: 'r1',
      root,
      receipt: { anchorId: 'offline', epochId: 'r1', guarantee: 'detect', at: 0 },
    };
    const bundle = buildBundle(m, entries, anchoredRoot);
    const anchor = anchorOf(root);

    const report = await verifyBundle(bundle, { anchor });

    expect(report.authzTier).toBe('none');
  });

  it('recorded via allow: authorization.verdict === "allow" → authzTier === "recorded"', async () => {
    const auth: Authorization = {
      verdict: 'allow',
      principal: 'policy:test',
      policyRef: 'sha256:abcd',
      effectClass: 'dispatch.default',
      at: '2024-01-01T00:00:00Z',
    };
    const m = minimalManifest(auth);
    const { entries, root } = buildEntries('r1', {
      itemId: m.itemId,
      manifestRef: manifestRefOf(m),
    });
    const anchoredRoot: AnchoredRoot = {
      epochId: 'r1',
      root,
      receipt: { anchorId: 'offline', epochId: 'r1', guarantee: 'detect', at: 0 },
    };
    const bundle = buildBundle(m, entries, anchoredRoot);
    const anchor = anchorOf(root);

    const report = await verifyBundle(bundle, { anchor });

    expect(report.authzTier).toBe('recorded');
  });

  it('recorded via deny entry: item.denied with verdict "deny" → authzTier === "recorded"', async () => {
    const auth: Authorization = {
      verdict: 'deny',
      principal: 'policy:test',
      policyRef: 'sha256:abcd',
      effectClass: 'dispatch.default',
      at: '2024-01-01T00:00:00Z',
    };
    // No manifest authorization — only the log entry carries the deny verdict
    const m = minimalManifest();
    const { entries, root } = buildEntriesWithDenied('r1', auth);
    const anchoredRoot: AnchoredRoot = {
      epochId: 'r1',
      root,
      receipt: { anchorId: 'offline', epochId: 'r1', guarantee: 'detect', at: 0 },
    };

    // For the deny case we don't need manifest integrity — no manifestRef on the item
    const runId = 'r1';
    const bundle: AuditBundle = {
      runId,
      manifests: [m],
      auditLog: { entries, root: anchoredRoot },
      items: [
        {
          id: m.itemId,
          status: 'done',
          // no manifestRef → manifest integrity check is skipped (ref === undefined)
        },
      ],
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
    const anchor = anchorOf(root);

    const report = await verifyBundle(bundle, { anchor });

    expect(report.authzTier).toBe('recorded');
  });

  it('orthogonality: authzTier does not affect intact/claim — same intact bundle reports same claim regardless of authzTier', async () => {
    // Bundle A: no authorization (authzTier = 'none')
    const mNone = minimalManifest();
    const { entries: entriesNone, root: rootNone } = buildEntries('r1', {
      itemId: mNone.itemId,
      manifestRef: manifestRefOf(mNone),
    });
    const anchoredRootNone: AnchoredRoot = {
      epochId: 'r1',
      root: rootNone,
      receipt: { anchorId: 'offline', epochId: 'r1', guarantee: 'detect', at: 0 },
    };
    const bundleNone = buildBundle(mNone, entriesNone, anchoredRootNone);
    const reportNone = await verifyBundle(bundleNone, { anchor: anchorOf(rootNone) });

    // Bundle B: with authorization allow (authzTier = 'recorded')
    const auth: Authorization = {
      verdict: 'allow',
      principal: 'policy:test',
      policyRef: 'sha256:abcd',
      effectClass: 'dispatch.default',
      at: '2024-01-01T00:00:00Z',
    };
    const mRecorded = minimalManifest(auth);
    const { entries: entriesRecorded, root: rootRecorded } = buildEntries('r1', {
      itemId: mRecorded.itemId,
      manifestRef: manifestRefOf(mRecorded),
    });
    const anchoredRootRecorded: AnchoredRoot = {
      epochId: 'r1',
      root: rootRecorded,
      receipt: { anchorId: 'offline', epochId: 'r1', guarantee: 'detect', at: 0 },
    };
    const bundleRecorded = buildBundle(mRecorded, entriesRecorded, anchoredRootRecorded);
    const reportRecorded = await verifyBundle(bundleRecorded, { anchor: anchorOf(rootRecorded) });

    // authzTier differs
    expect(reportNone.authzTier).toBe('none');
    expect(reportRecorded.authzTier).toBe('recorded');

    // intact and claim are the same — authzTier does not affect them
    expect(reportNone.intact).toBe(reportRecorded.intact);
    expect(reportNone.claim).toBe(reportRecorded.claim);
  });
});
