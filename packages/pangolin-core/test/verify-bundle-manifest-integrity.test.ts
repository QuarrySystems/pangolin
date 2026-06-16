import { describe, it, expect } from 'vitest';
import type {
  AuditBundle,
  AuditAnchor,
  AuditEntryRow,
  AnchoredRoot,
  DispatchManifest,
} from '../src/audit.js';
import { verifyBundle } from '../src/audit-verify-bundle.js';
import { computeContentHash, buildPangolinUri } from '../src/index.js';
import { canonEntry } from '../src/audit-canon.js';
import { chainHash, merkleRoot, leavesFromEntryHashes } from '../src/audit-merkle.js';

// ---------------------------------------------------------------------------
// Helpers (mirrors the pattern from packages/pangolin-orchestrator/test/audit/verify-bundle.test.ts)
// ---------------------------------------------------------------------------

type GuaranteeType = 'detect' | 'external-immutable' | 'witnessed';

/** Mint the manifestRef exactly the way the dispatch executor does. */
function manifestRefOf(m: DispatchManifest, namespace = 'ns', dispatchId = 'd1'): string {
  return buildPangolinUri({
    namespace,
    type: 'manifest',
    name: dispatchId,
    contentHash: computeContentHash(m),
  });
}

/** Offline anchor that serves exactly one AnchoredRoot. */
function anchorOf(root: Uint8Array, guarantee: GuaranteeType = 'detect'): AuditAnchor {
  return {
    id: 'offline',
    guarantee,
    async anchor() {
      return { anchorId: 'offline', epochId: 'r1', guarantee, at: 0 };
    },
    async fetch() {
      return [
        {
          epochId: 'r1',
          root,
          receipt: { anchorId: 'offline', epochId: 'r1', guarantee, at: 0 },
        } satisfies AnchoredRoot,
      ];
    },
  };
}

/** Build a 2-entry chained log and return its entries + Merkle root. */
function buildEntries(runId: string): { entries: AuditEntryRow[]; root: Uint8Array } {
  const mk = (
    e: Omit<AuditEntryRow, 'entryHash' | 'prevHash' | 'runId'>,
    prev: string,
  ): AuditEntryRow => {
    const entry = { ...e, runId, entryHash: '', prevHash: prev } as AuditEntryRow;
    const eh = chainHash(canonEntry(entry), prev);
    return { ...entry, entryHash: eh } as AuditEntryRow;
  };

  const e0 = mk({ seq: 0, kind: 'run.submitted', at: 't0' }, '');
  const e1 = mk({ seq: 1, kind: 'run.completed', at: 't1' }, e0.entryHash);
  const root = merkleRoot(leavesFromEntryHashes([e0.entryHash, e1.entryHash]));
  return { entries: [e0, e1], root };
}

/**
 * Assemble a verifiable AuditBundle for one item.
 *
 * The bundle is structured so that WITHOUT the manifest-integrity check
 * everything else verifies intact:
 *  - Chain hashes are valid.
 *  - Anchored root matches the recomputed Merkle root.
 *  - The item has status 'done' and no inputRefs → handoff has no edges → ok.
 *  - items[0].manifestRef is set to the correctly-minted URI for `m`.
 *
 * Only mutating m AFTER bundleWith() was called will break manifest integrity.
 */
function bundleWith(m: DispatchManifest): { bundle: AuditBundle; anchor: AuditAnchor } {
  const runId = 'r1';
  const { entries, root } = buildEntries(runId);

  const anchoredRoot: AnchoredRoot = {
    epochId: runId,
    root,
    receipt: { anchorId: 'offline', epochId: runId, guarantee: 'detect', at: 0 },
  };

  const bundle: AuditBundle = {
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
    // The pre-populated report is a type-satisfying placeholder only;
    // verifyBundle always recomputes it.
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

  return { bundle, anchor: anchorOf(root) };
}

/** Build a minimal DispatchManifest with a 'deny' authorization block. */
function minimalManifest(): DispatchManifest {
  return {
    schemaVersion: 1,
    runId: 'r1',
    itemId: 'item-a',
    parent: 'run:r1',
    executor: 'dispatch',
    executorManifest: {},
    secretRefs: [],
    actor: 'human:test',
    firedAt: '2024-01-01T00:00:00Z',
    manifestHash: 'sha256:aabbcc',
    authorization: {
      verdict: 'deny',
      principal: 'policy:test',
      policyRef: 'sha256:0000',
      effectClass: 'dispatch.default',
      at: '2024-01-01T00:00:00Z',
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('manifest integrity (Finding A)', () => {
  it('a bundle whose manifest matches its chained manifestRef verifies intact', async () => {
    const m = minimalManifest();
    const { bundle, anchor } = bundleWith(m);

    const report = await verifyBundle(bundle, { anchor });

    expect(report.intact).toBe(true);
  });

  it('mutating a sealed manifest field (authorization.verdict) makes verify NOT intact', async () => {
    const m = minimalManifest(); // verdict = 'deny'
    const { bundle, anchor } = bundleWith(m);

    // Forge the sealed authorization.verdict after the manifestRef was minted
    (bundle.manifests[0]!.authorization as { verdict: string }).verdict = 'allow';

    const report = await verifyBundle(bundle, { anchor });

    expect(report.intact).toBe(false);
    expect(report.failure).toBe('manifest');
  });
});
