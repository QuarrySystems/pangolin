// The audit verification type surface now lives in @quarry-systems/pangolin-core
// (single source of truth, shared by the sealer and the verifier). This file is
// a pure re-export so existing `../contracts/index.js` / `./audit.js` imports
// keep working unchanged.
export type {
  Guarantee,
  Signature,
  AnchorReceipt,
  AnchoredRoot,
  Signer,
  AuditAnchor,
  TimestampToken,
  TimestampAuthority,
  TimeTier,
  AuditEntryKind,
  AuditEntry,
  CheckResult,
  VerificationReport,
  AuditEntryRow,
  AuditStore,
  AuditItemOutcome,
  AuditExport,
  AuditBundle,
} from '@quarry-systems/pangolin-core';
export { GUARANTEE_RANK } from '@quarry-systems/pangolin-core';
