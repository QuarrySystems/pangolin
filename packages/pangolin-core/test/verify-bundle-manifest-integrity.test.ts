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

/** Build a 3-entry chained log (run.submitted + item.fired + run.completed) and return
 *  its entries + Merkle root.
 *
 *  The `item.fired` entry carries `itemId` and `manifestRef` — mirroring what the real
 *  orchestrator writes at fire time. This makes the synthetic chain FAITHFUL to reality:
 *  tick.ts writes the SAME manifestRef to both the export item AND the chained audit entry.
 *  Without this entry, `chainedManifestRefs` would be empty and the new binding check
 *  would false-reject the positive test.
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
function bundleWith(
  m: DispatchManifest,
  opts: { chainRef?: string; itemRef?: string } = {},
): { bundle: AuditBundle; anchor: AuditAnchor } {
  const runId = 'r1';
  // The chained item.fired ref is the TRUSTED anchor; the export item ref is what a consumer
  // (or attacker) presents. They are byte-identical for honest bundles (tick writes the same
  // value to both); tests can override each independently to model genuine-unpinned vs. forgery.
  const chainRef = opts.chainRef ?? manifestRefOf(m);
  const itemRef = opts.itemRef ?? manifestRefOf(m);
  // Pass the correctly-minted manifestRef into buildEntries so the chain carries
  // the item.fired entry that the new binding check requires.
  const { entries, root } = buildEntries(runId, {
    itemId: m.itemId,
    manifestRef: chainRef,
  });

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
        manifestRef: itemRef,
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

/** Build a minimal DispatchManifest with a 'deny' authorization block.
 *  The manifestHash is computed from the base fields (all fields except manifestHash itself),
 *  mirroring what buildManifest() does — this makes the manifest self-consistent so that
 *  body-integrity check (1) passes for the positive test case. */
function minimalManifest(): DispatchManifest {
  const base = {
    schemaVersion: 1 as const,
    runId: 'r1',
    itemId: 'item-a',
    parent: 'run:r1',
    executor: 'dispatch',
    executorManifest: {},
    secretRefs: [] as string[],
    actor: 'human:test',
    firedAt: '2024-01-01T00:00:00Z',
    authorization: {
      verdict: 'deny' as const,
      principal: 'policy:test',
      policyRef: 'sha256:0000',
      effectClass: 'dispatch.default',
      at: '2024-01-01T00:00:00Z',
    },
  };
  return { ...base, manifestHash: computeContentHash(base) };
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

  it('a fully-consistent forgery (verdict flipped + manifestHash recomputed + export ref rewritten) is rejected', async () => {
    // Reproduce the confirmed forgery path:
    //   (1) flip authorization.verdict deny → allow
    //   (2) recompute manifestHash over the updated base (so body-integrity check alone passes)
    //   (3) rewrite bundle.items[0].manifestRef to the NEW content address
    //
    // The chained item.fired entry still carries the ORIGINAL manifestRef — that's the
    // chain-anchored truth. Without the chain-binding check, verify() returns intact:true.
    const m = minimalManifest(); // verdict = 'deny'
    const { bundle, anchor } = bundleWith(m);

    // Step 1: flip the verdict in the manifest
    (bundle.manifests[0]!.authorization as { verdict: string }).verdict = 'allow';

    // Step 2: recompute manifestHash over the forged base (so manifestRefMatches body check passes)
    const forgedManifest = bundle.manifests[0]!;
    const {
      manifestHash: _old,
      signature: _sig,
      ...forgedBase
    } = forgedManifest as DispatchManifest & {
      signature?: unknown;
    };
    const newManifestHash = computeContentHash(forgedBase);
    (bundle.manifests[0] as { manifestHash: string }).manifestHash = newManifestHash;

    // Step 3: rewrite the export item's manifestRef to the NEW content address
    // (mimics attacker patching bundle.items[*].manifestRef to match the forged manifest)
    const newRef = manifestRefOf(bundle.manifests[0]!);
    bundle.items[0]!.manifestRef = newRef;

    // The chain still holds the ORIGINAL item.fired.manifestRef — so the new ref
    // is absent from chainedManifestRefs → must be rejected.
    const report = await verifyBundle(bundle, { anchor });

    expect(report.intact).toBe(false);
    expect(report.failure).toBe('manifest');
  });

  it('REJECTS a downgraded export ref (unpinned) that diverges from the chained pinned ref', async () => {
    // Downgrade attack: the chain anchored a PINNED ref, but the attacker rewrites the export
    // item ref to an unpinned form (pangolin://manifests/<id>) hoping the integrity check will
    // "skip" it. The gate is the TRUSTED chain, not the export ref's shape: the downgraded ref is
    // absent from the anchored item.fired set, so it must be rejected — NOT skipped.
    const m = minimalManifest();
    const { bundle, anchor } = bundleWith(m); // chain + export both = pinned manifestRefOf(m)
    bundle.items[0]!.manifestRef = 'pangolin://manifests/item-a'; // attacker downgrades the export ref only

    const report = await verifyBundle(bundle, { anchor });

    expect(report.intact).toBe(false);
    expect(report.failure).toBe('manifest');
  });

  it('TOLERATES a genuinely-unpinned ref when chain and export agree (fake-executor fixtures)', async () => {
    // Real executors always mint pinned refs; some fake-executor test fixtures (e.g. handoff-dag)
    // mint an unpinned ref like pangolin://manifests/<dispatchHash>. Because tick writes the SAME
    // value to both the chained item.fired entry AND the export item, the ref IS a chain member —
    // it passes membership, after which manifestRefMatches harmlessly skips the content check
    // (an unpinned ref commits to nothing). This must verify intact, not false-reject.
    const unpinned = 'pangolin://manifests/item-a';
    const m = minimalManifest();
    const { bundle, anchor } = bundleWith(m, { chainRef: unpinned, itemRef: unpinned });

    const report = await verifyBundle(bundle, { anchor });

    expect(report.intact).toBe(true);
    expect(report.failure).not.toBe('manifest');
  });
});
