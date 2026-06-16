import type {
  AuditBundle,
  AuditStore,
  AuditAnchor,
  AuthzTier,
  Signature,
  TimestampToken,
  VerificationReport,
  CheckResult,
  DispatchManifest,
} from './audit.js';
import { verify, claimFor } from './audit-verify.js';
import { computeContentHash } from './content-hash.js';
import { parsePangolinUri } from './uri.js';

export function verifyBundle(
  bundle: AuditBundle,
  deps: {
    anchor: AuditAnchor;
    verifySignature?: (root: Uint8Array, sig: Signature) => boolean;
    verifyTimestamp?: (root: Uint8Array, token: TimestampToken) => boolean;
  },
): Promise<VerificationReport> {
  const entries = bundle.auditLog.entries;
  // verify() consults only store.getAuditEntries(runId), so a partial store suffices.
  // The double-cast documents that narrowing — revisit if verify() grows to call other AuditStore methods.
  const store = { getAuditEntries: () => entries } as Pick<
    AuditStore,
    'getAuditEntries'
  > as AuditStore;
  return verify(bundle.runId, {
    store,
    anchor: deps.anchor,
    verifySignature: deps.verifySignature,
    verifyTimestamp: deps.verifyTimestamp,
  }).then((base) => {
    const handoff = checkHandoffClosure(bundle);
    // Manifest integrity (spec §7 / Finding A). The TRUSTED anchor for each fired item's manifest
    // is its `item.fired` audit entry's manifestRef — canonEntry seals it and the chain/root/anchor
    // checks above guarantee its authenticity. The export's bundle.items[*].manifestRef is copied
    // verbatim from the UNTRUSTED export, and the item↔manifest join (find by itemId) is attacker-
    // controllable, so we DO NOT consult it here. Instead we bind the bundle's manifests to the
    // chain BIDIRECTIONALLY, purely by content hash:
    //   forward — every PINNED chained ref must be backed by a present manifest that content-
    //             addresses to it. A forged/rewritten/downgraded ref leaves the ORIGINAL chained
    //             ref un-backed (no preimage for its fixed hash) → reject.
    //   reverse — every present manifest THAT CARRIES AN AUTHORIZATION must content-address to some
    //             PINNED chained ref. Forward already binds every sealed manifest body; reverse's
    //             additional job is to stop an UNANCHORED authorization from entering evidence — an
    //             appended/orphaned forged manifest bearing an `allow` verdict (itemId renamed,
    //             export id renamed, or the export item's manifestRef stripped) matches nothing →
    //             reject, and authzTier stays honest. Manifests without an authorization block carry
    //             no claim this check anchors (and were never bound pre-feature), so they are left to
    //             the forward check; this also keeps handoff-only fixtures (chain-unbound, authz-free
    //             manifests) from false-failing.
    // Unpinned chained refs commit to no content; they occur ONLY in fake-executor test fixtures
    // (real executors always mint pinned, content-addressed refs). When the chain contains any such
    // ref we relax the REVERSE direction, since a present manifest may legitimately correspond to
    // an uncommitted fixture item. Chained entries are tamper-anchored, so an attacker cannot
    // inject an unpinned entry to disable the reverse check without breaking the Merkle root.
    const pinnedChainedRefs: string[] = [];
    let sawUnpinnedChainedRef = false;
    for (const e of entries) {
      if (e.kind !== 'item.fired' || e.manifestRef === undefined) continue;
      if (isContentAddressed(e.manifestRef)) pinnedChainedRefs.push(e.manifestRef);
      else sawUnpinnedChainedRef = true;
    }
    let manifestOk = true;
    // forward: each pinned chained ref is covered by a present, content-matching manifest
    for (const ref of pinnedChainedRefs) {
      if (!bundle.manifests.some((m) => manifestRefMatches(m, ref))) {
        manifestOk = false;
        break;
      }
    }
    // reverse: each present AUTHORIZATION-bearing manifest is bound to some pinned chained ref
    // (relaxed only when the chain carries uncommitted/unpinned fixture refs — see above)
    if (manifestOk && !sawUnpinnedChainedRef) {
      for (const m of bundle.manifests) {
        if (m.authorization === undefined) continue; // no anchored claim → forward check governs
        if (!pinnedChainedRefs.some((ref) => manifestRefMatches(m, ref))) {
          manifestOk = false;
          break;
        }
      }
    }
    const intact = base.intact && handoff.ok !== false && manifestOk;
    const failure =
      base.failure ??
      (manifestOk === false
        ? ('manifest' as const)
        : handoff.ok === false
          ? ('handoff' as const)
          : undefined);
    const claim = claimFor(intact, base.guarantee, base.checks.signature.ok);
    // authzTier reflects authorizations the bundle can actually substantiate. The manifest-borne
    // verdict counts ONLY when the manifests passed the integrity binding above (else a forged or
    // orphaned manifest could flip the tier); the `item.denied` verdict is chain-sealed, so it
    // counts unconditionally.
    const decided =
      (manifestOk &&
        bundle.manifests.some(
          (m) => m.authorization !== undefined && m.authorization.verdict !== 'not-evaluated',
        )) ||
      bundle.auditLog.entries.some(
        (e) => e.kind === 'item.denied' && e.authorization?.verdict === 'deny',
      );
    const authzTier: AuthzTier = decided ? 'recorded' : 'none';
    return { ...base, intact, failure, claim, authzTier, checks: { ...base.checks, handoff } };
  });
}

/** True iff `ref` is a pinned (content-addressed) pangolin:// URI carrying a contentHash segment.
 *  Applied ONLY to TRUSTED chained refs (never the untrusted export ref) to decide whether the
 *  chain made a content commitment that must be enforced. Unpinned/unparseable → no commitment. */
function isContentAddressed(ref: string): boolean {
  try {
    return parsePangolinUri(ref).contentHash !== undefined;
  } catch {
    return false;
  }
}

/** Returns true iff the manifest's recomputed content hash matches the hash embedded in the
 *  chained manifestRef URI. Accepts both minting conventions used in this codebase:
 *  - DispatchExecutor / inproc: contentHash = computeContentHash(full manifest sans signature)
 *  - pattern-harness / idKeyedExecutor: contentHash = manifest.manifestHash (self-hash)
 *
 *  Two checks are performed:
 *  (1) Body integrity: the declared self-hash must recompute from the base fields (all fields
 *      except manifestHash and signature). A mutation in any base field that leaves manifestHash
 *      stale is caught here.
 *  (2) Chain binding: the trusted (chained) manifestRef must pin THIS manifest by either
 *      minting convention. A self-consistent forgery (base + manifestHash both updated) is
 *      caught because the chained refHash no longer matches either the new manifestHash or the
 *      new full hash. */
function manifestRefMatches(m: DispatchManifest, manifestRef: string): boolean {
  // The integrity guarantee applies only to CONTENT-ADDRESSED (pinned) refs. A ref that carries
  // no contentHash — unparseable or unpinned (e.g. a simplified `pangolin://manifests/<id>` test
  // ref) — commits to nothing, so there is nothing to verify: skip it (do NOT flag). Real sealed
  // bundles always mint pinned, content-addressed refs (DispatchExecutor/inproc/pattern-harness),
  // so this never weakens a production bundle's check; it only avoids a false reject on non-pinned refs.
  let refHash: string | undefined;
  try {
    refHash = parsePangolinUri(manifestRef).contentHash;
  } catch {
    return true; // unparseable ref → not a content commitment → not checkable
  }
  if (refHash === undefined) return true; // unpinned ref → not checkable
  try {
    // Reproduce the self-hash basis: all fields except manifestHash and signature.
    const {
      manifestHash,
      signature: _signature,
      ...base
    } = m as DispatchManifest & {
      signature?: unknown;
    };
    // (1) Body integrity: declared self-hash must match recomputed hash of base fields.
    if (computeContentHash(base) !== manifestHash) return false;
    // (2) Chain binding: the trusted refHash must match either minting convention.
    const fullHash = computeContentHash({ ...base, manifestHash });
    return refHash === manifestHash || refHash === fullHash;
  } catch {
    return false;
  }
}

/** Provenance closure (spec §7): every manifests[*].inputRefs value must equal some item's
 *  resultRef or an outputRefs value. Refs are sha256 content hashes => ref-equality IS
 *  byte-equality; no blob fetching needed. */
function checkHandoffClosure(bundle: AuditBundle): CheckResult {
  const produced = new Set<string>();
  for (const it of bundle.items) {
    if (it.status !== 'done') continue; // only completed items are legitimate producers
    if (it.resultRef) produced.add(it.resultRef);
    for (const ref of Object.values(it.outputRefs ?? {})) {
      if (!ref) continue; // skip empty-string / falsy refs; not a valid content hash
      produced.add(ref);
    }
  }
  let edges = 0;
  for (const m of bundle.manifests) {
    for (const [key, ref] of Object.entries(m.inputRefs ?? {})) {
      edges++;
      if (!ref || !produced.has(ref)) {
        return {
          ok: false,
          detail: `item ${m.itemId} input ${key}: ${ref} not produced by any item in this run`,
        };
      }
    }
  }
  return edges === 0
    ? { ok: true, detail: 'no handoff edges' }
    : { ok: true, detail: `${edges} input ref${edges === 1 ? '' : 's'} accounted for` };
}
