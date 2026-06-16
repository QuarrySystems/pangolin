// @quarry-systems/pangolin-verify
//
// Standalone audit-bundle verifier — the artifact an auditor runs. Owns the RFC 3161 /
// ASN.1 (pkijs) dependency so @quarry-systems/pangolin-core stays dependency-light, and
// supplies the ed25519 + trusted-time verifier callbacks that core's verifyBundle injects.
//
// Public surface:
//  - verifyTimestamp / LocalCaTimestampAuthority / Rfc3161TimestampAuthority (RFC 3161)
//  - loadBundle / loadVerifyContext / buildAnchor / makeVerifySignature / makeVerifyTimestamp
//  - renderVerification (terminal summary)

export {
  verifyTimestamp,
  verifyTimestampWithTime,
  LocalCaTimestampAuthority,
  Rfc3161TimestampAuthority,
} from './timestamp-authority.js';

export {
  loadBundle,
  loadVerifyContext,
  buildAnchor,
  makeVerifySignature,
  makeVerifyTimestamp,
} from './verify-context.js';
export type {
  AnchorSpec,
  OfflineAnchorSpec,
  AnchorCheckedSpec,
  VerifyContextJson,
  VerifyContext,
} from './verify-context.js';

export { renderVerification } from './render.js';
export type { RenderOpts } from './render.js';

// Re-export core's verifyBundle (+ its report type) so an auditor reaches a full
// verification — bundle in, VerificationReport out — from this single package, never
// needing the sealer/orchestrator package. See examples/verify-tsa.
export { verifyBundle } from '@quarry-systems/pangolin-core';
export type { VerificationReport, AuditBundle } from '@quarry-systems/pangolin-core';
