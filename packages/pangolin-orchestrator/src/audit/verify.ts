import type { AuditStore, AuditAnchor, VerificationReport, Signature } from '../contracts/index.js';
import { GUARANTEE_RANK } from '../contracts/index.js';
import type { Guarantee } from '../contracts/index.js';
import { canonEntry } from './canon.js';
import { chainHash, merkleRoot, leavesFromEntryHashes } from './merkle.js';

/** DRY claim rule (spec §7): tamper-evident only when guarantee >= external-immutable AND intact. */
export function claimFor(intact: boolean, guarantee: Guarantee): 'tamper-evident' | 'tamper-detecting' {
  return intact && GUARANTEE_RANK[guarantee] >= GUARANTEE_RANK['external-immutable']
    ? 'tamper-evident'
    : 'tamper-detecting';
}

export async function verify(
  runId: string,
  deps: {
    store: AuditStore;
    anchor: AuditAnchor;
    verifySignature?: (root: Uint8Array, sig: Signature) => boolean;
  },
): Promise<VerificationReport> {
  const g = deps.anchor.guarantee;
  const entries = deps.store.getAuditEntries(runId);

  // 1. Recompute the chain and verify each entry's hash and chain linkage (collect-all — no early return)
  let prev = '', chainOk = true, badSeq: number | undefined;
  for (const e of entries) {
    if (chainHash(canonEntry(e), prev) !== e.entryHash || e.prevHash !== prev) {
      chainOk = false;
      badSeq = e.seq;
      break;
    }
    prev = e.entryHash;
  }

  // 2. Recompute the Merkle root from the entry hashes
  const recomputed = merkleRoot(leavesFromEntryHashes(entries.map((e) => e.entryHash)));

  // 3. Fetch the anchored root — collect-all: fetch even if chain failed
  const anchored = (await deps.anchor.fetch({ epochId: runId }))[0];

  const anchorOk = !!anchored;
  const rootOk: boolean | 'n/a' = anchored
    ? Buffer.compare(Buffer.from(recomputed), Buffer.from(anchored.root)) === 0
    : 'n/a';
  const sigOk: boolean | 'n/a' =
    anchored?.signature && deps.verifySignature
      ? deps.verifySignature(anchored.root, anchored.signature)
      : 'n/a';

  const checks = {
    chain: { ok: chainOk, detail: chainOk ? undefined : `entry ${badSeq} hash ≠ recomputed` },
    root: { ok: rootOk },
    signature: { ok: sigOk },
    anchor: { ok: anchorOk },
    handoff: { ok: 'n/a' as const },
  };

  const intact = chainOk && anchorOk && rootOk !== false && sigOk !== false;

  const failure =
    !chainOk ? 'chain' as const
    : !anchorOk ? 'anchor-missing' as const
    : rootOk === false ? 'root-mismatch' as const
    : sigOk === false ? 'signature' as const
    : undefined;

  const claim = claimFor(intact, g);

  return { runId, anchorId: deps.anchor.id, guarantee: g, intact, claim, failure, checks };
}
