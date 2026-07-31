// One place for the rule VERIFICATION.md states: "The verifier recomputes `report`
// from scratch; it does not trust the embedded one."
//
// Every CLI path that shows a verdict or gates on one must go through here. A bundle
// carries a `report` field, and for a bundle READ FROM DISK that field is written by
// whoever wrote the file — so trusting it hands the verdict to the artifact being
// judged. Even for a freshly assembled bundle, recomputing here is what lets the
// caller's own trust deps (its anchor, its public key, its trusted-time verifier)
// decide, rather than whichever deps the assembler happened to hold.
//
// This exists because the rule was silently broken once: `orch watch` rendered, and
// `orch audit` set its EXIT CODE from, the report embedded by assembleBundle — which
// was built by the chain-only verify() and so carried no manifest-integrity result.
// A forged manifest that verifyBundle reports as TAMPERED passed those paths clean
// (KNOWN-ISSUES #5). assembleBundle now embeds the full report, but that made the
// embedded value LOOK authoritative, which is the more inviting version of the same
// trap. Recomputing at the point of use closes it for good.
import { verifyBundle } from '@quarry-systems/pangolin-orchestrator';
import type {
  AuditAnchor,
  AuditBundle,
  Signature,
  TimestampToken,
  VerificationReport,
} from '@quarry-systems/pangolin-orchestrator';

/** The trust inputs a verdict is computed against — the subset of OrchContext that
 *  decides truth. Structural rather than an OrchContext import, to keep this module
 *  free of a cycle with cmd-orch. */
export interface VerifyDeps {
  anchor?: AuditAnchor;
  verifySignature?: (root: Uint8Array, sig: Signature) => boolean | 'n/a';
  verifyTimestamp?: (root: Uint8Array, token: TimestampToken) => boolean;
}

/** Recompute a bundle's verdict against the caller's trust deps.
 *
 *  Throws when no anchor is configured: a verdict with nothing to anchor against is not
 *  a weaker verdict, it is not a verdict at all, and returning something reassuring
 *  would be worse than failing. */
export async function recomputeVerdict(
  bundle: AuditBundle,
  deps: VerifyDeps,
  verb: string,
): Promise<VerificationReport> {
  if (!deps.anchor) {
    throw new Error(
      `${verb}: pangolin.config \`orch\` export provides no anchor to verify against`,
    );
  }
  return verifyBundle(bundle, {
    anchor: deps.anchor,
    verifySignature: deps.verifySignature,
    verifyTimestamp: deps.verifyTimestamp,
  });
}

/** The bundle as it should be rendered: its own `report` replaced by the recomputed one.
 *  `renderVerification` reads `bundle.report`, so this is the only shape safe to hand it. */
export async function verifiedView(
  bundle: AuditBundle,
  deps: VerifyDeps,
  verb: string,
): Promise<{ bundle: AuditBundle; report: VerificationReport }> {
  const report = await recomputeVerdict(bundle, deps, verb);
  return { bundle: { ...bundle, report }, report };
}
