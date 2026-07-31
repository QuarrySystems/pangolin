import type { AuditExport, AuditBundle, AuditAnchor, Signature } from '../contracts/index.js';
import type { DispatchManifest } from '../contracts/index.js';
import { verifyBundle } from './verify-bundle.js';

interface StorageLike {
  get(ref: string): Promise<Uint8Array>;
}

// The read-only AuditStore shim that used to live here is gone: verifyBundle builds an
// equivalent one internally (it needs only getAuditEntries, which is all verify() ever
// called), so keeping a second copy here would be one more thing to keep in step.

export async function assembleBundle(
  exp: AuditExport,
  deps: {
    anchor: AuditAnchor;
    storage: StorageLike;
    verifySignature?: (root: Uint8Array, sig: Signature) => boolean | 'n/a';
  },
): Promise<AuditBundle> {
  const manifests: DispatchManifest[] = [];
  for (const it of exp.items) {
    if (!it.manifestRef) continue;
    try {
      manifests.push(
        JSON.parse(
          new TextDecoder().decode(await deps.storage.get(it.manifestRef)),
        ) as DispatchManifest,
      );
    } catch {
      /* a missing/unfetchable manifest is reported via the bundle, not thrown */
    }
  }
  // The embedded report is computed with verifyBundle, NOT the chain-only verify().
  //
  // verify() checks chain + root + signature + anchor and nothing else: it hardcodes
  // `handoff: { ok: 'n/a' }` and never sets authzTier. Building the report with it left
  // three checks missing from every bundle — handoff closure, authorization tier, and
  // MANIFEST INTEGRITY — while `renderVerification` presents the embedded report as a
  // complete verdict. That is what made `orch watch` disagree with `pangolin verify` on
  // the same run (KNOWN-ISSUES #5), and the manifest half was worse than a disagreement:
  // a forged manifest that verifyBundle reports as `✗ TAMPERED failure:'manifest'`
  // rendered as a clean bill here, and `orch audit` takes its EXIT CODE from
  // `bundle.report.intact`.
  //
  // The cast is safe and narrow: verifyBundle reads runId, auditLog.entries, manifests
  // and items — never `report` — so a report-less skeleton is a valid input to it. This
  // is the only order that works, since the report is a function of the bundle.
  const skeleton: Omit<AuditBundle, 'report'> = {
    runId: exp.runId,
    manifests,
    auditLog: { entries: exp.entries, root: exp.root },
    items: exp.items,
  };
  const report = await verifyBundle(skeleton as AuditBundle, {
    anchor: deps.anchor,
    verifySignature: deps.verifySignature,
  });
  return { ...skeleton, report };
}
