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
    let manifestOk = true;
    for (const m of bundle.manifests) {
      const ref = bundle.items.find((i) => i.id === m.itemId)?.manifestRef;
      if (ref !== undefined && !manifestRefMatches(m, ref)) {
        manifestOk = false;
        break;
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
    const decided =
      bundle.manifests.some(
        (m) => m.authorization !== undefined && m.authorization.verdict !== 'not-evaluated',
      ) ||
      bundle.auditLog.entries.some(
        (e) => e.kind === 'item.denied' && e.authorization?.verdict === 'deny',
      );
    const authzTier: AuthzTier = decided ? 'recorded' : 'none';
    return { ...base, intact, failure, claim, authzTier, checks: { ...base.checks, handoff } };
  });
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
  try {
    const refHash = parsePangolinUri(manifestRef).contentHash;
    if (refHash === undefined) return false;
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
